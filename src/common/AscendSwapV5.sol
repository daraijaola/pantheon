// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {IV5PoolManager, V5PoolKey} from "./AscendV5.sol";

abstract contract AscendSwapV5 {
    using SafeTransferLib for ERC20;

    IV5PoolManager public immutable poolManager;
    bool private transient _inUnlock;

    error UnexpectedCallback();
    error BadDelta();

    constructor(IV5PoolManager manager) {
        poolManager = manager;
    }

    function _swapExactIn(V5PoolKey memory key, bool zeroForOne, uint256 amount, uint160 limit, address to)
        internal
        returns (uint256 spent, uint256 out)
    {
        if (amount > uint256(type(int256).max) || _inUnlock) revert BadDelta();
        _inUnlock = true;
        bytes memory result = poolManager.unlock(abi.encode(key, zeroForOne, amount, limit, to));
        _inUnlock = false;
        return abi.decode(result, (uint256, uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_inUnlock) revert UnexpectedCallback();
        (V5PoolKey memory key, bool zeroForOne, uint256 amount, uint160 limit, address to) =
            abi.decode(data, (V5PoolKey, bool, uint256, uint160, address));
        int256 delta = poolManager.swap(key, IV5PoolManager.SwapParams(zeroForOne, -int256(amount), limit), "");
        int128 d0 = int128(delta >> 128);
        int128 d1 = int128(delta);
        (int128 input, int128 output) = zeroForOne ? (d0, d1) : (d1, d0);
        if (input > 0 || output < 0) revert BadDelta();
        uint256 spent = uint256(-int256(input));
        uint256 out = uint256(int256(output));
        if (spent > amount) revert BadDelta();
        (address cin, address cout) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        if (spent > 0) {
            poolManager.sync(cin);
            ERC20(cin).safeTransfer(address(poolManager), spent);
            if (poolManager.settle() != spent) revert BadDelta();
        }
        if (out > 0) poolManager.take(cout, to, out);
        return abi.encode(spent, out);
    }
}
