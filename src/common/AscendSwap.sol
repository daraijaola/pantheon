// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {ILockCallback} from "infinity-core/src/interfaces/ILockCallback.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "infinity-core/src/types/BalanceDelta.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

/// @title AscendSwap
/// @notice One exact-input swap through an Ascend pool (PancakeSwap Infinity vault lock), with a
/// price limit. Only the input the pool actually consumed is paid; if the limit is reached first,
/// the rest of the input simply stays with the caller. This is the routine the proof-of-concept
/// fork tests ran against Ascend's live testnet, plus the limit and a guard on the callback.
abstract contract AscendSwap is ILockCallback {
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeTransferLib for ERC20;

    IVault public immutable vault;
    ICLPoolManager public immutable poolManager;

    /// Set only while this contract's own lock is open, so the vault can't be asked to call back
    /// at any other time (by anyone else's lock).
    bool private transient _inLock;

    error NotVault();
    error UnexpectedCallback();

    constructor(IVault vault_, ICLPoolManager poolManager_) {
        vault = vault_;
        poolManager = poolManager_;
    }

    /// @return spent the input the pool consumed
    /// @return out the output sent to `to`
    function _swapExactIn(PoolKey memory key, bool zeroForOne, uint256 amountIn, uint160 sqrtPriceLimitX96, address to)
        internal
        returns (uint256 spent, uint256 out)
    {
        _inLock = true;
        bytes memory res = vault.lock(abi.encode(key, zeroForOne, amountIn, sqrtPriceLimitX96, to));
        _inLock = false;
        (spent, out) = abi.decode(res, (uint256, uint256));
    }

    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(vault)) revert NotVault();
        if (!_inLock) revert UnexpectedCallback();
        (PoolKey memory key, bool zeroForOne, uint256 amountIn, uint160 limit, address to) =
            abi.decode(data, (PoolKey, bool, uint256, uint160, address));

        BalanceDelta d = poolManager.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: limit
            }),
            ""
        );
        (Currency cin, Currency cout) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        int128 inD = zeroForOne ? d.amount0() : d.amount1();
        int128 outD = zeroForOne ? d.amount1() : d.amount0();

        uint256 spent = inD < 0 ? uint256(uint128(-inD)) : 0;
        if (spent > 0) {
            vault.sync(cin);
            ERC20(Currency.unwrap(cin)).safeTransfer(address(vault), spent);
            vault.settle();
        }
        uint256 out = outD > 0 ? uint256(uint128(outD)) : 0;
        if (out > 0) vault.take(cout, to, out);
        return abi.encode(spent, out);
    }
}
