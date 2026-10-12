// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {LaunchpadKey} from "ascend/libraries/LaunchpadKey.sol";
import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "infinity-core/src/types/BalanceDelta.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {ILockCallback} from "infinity-core/src/interfaces/ILockCallback.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

interface IMintable {
    function mint(address to, uint256 value) external;
}

/// Accepts the creator role in its constructor: the CREATE2-predicted handoff
/// pattern Ascend's own CTO registry uses (transferCreator → predicted → accept).
contract RoleTaker {
    constructor(IAscendLaunchpad lp, PoolId id) {
        lp.acceptCreator(id);
    }
}

/// Minimal exact-input swapper through the Infinity vault lock.
contract Swapper is ILockCallback {
    using BalanceDeltaLibrary for BalanceDelta;

    IVault public immutable vault;
    ICLPoolManager public immutable pm;

    constructor(IVault v, ICLPoolManager p) {
        vault = v;
        pm = p;
    }

    function swapExactIn(PoolKey memory key, bool zeroForOne, uint256 amountIn) external returns (uint256 out) {
        Currency cin = zeroForOne ? key.currency0 : key.currency1;
        ERC20(Currency.unwrap(cin)).transferFrom(msg.sender, address(this), amountIn);
        out = abi.decode(vault.lock(abi.encode(key, zeroForOne, amountIn, msg.sender)), (uint256));
    }

    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(vault), "only vault");
        (PoolKey memory key, bool zeroForOne, uint256 amountIn, address to) =
            abi.decode(data, (PoolKey, bool, uint256, address));
        BalanceDelta d = pm.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            }),
            ""
        );
        (Currency cin, Currency cout) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        int128 inD = zeroForOne ? d.amount0() : d.amount1();
        int128 outD = zeroForOne ? d.amount1() : d.amount0();
        if (inD < 0) {
            vault.sync(cin);
            ERC20(Currency.unwrap(cin)).transfer(address(vault), uint256(uint128(-inD)));
            vault.settle();
        }
        uint256 out = outD > 0 ? uint256(uint128(outD)) : 0;
        if (out > 0) vault.take(cout, to, out);
        return abi.encode(out);
    }
}

/// Proof-of-concept fork tests against Ascend's LIVE Elysium testnet deployment.
/// They prove the primitives PANTHEON/Covenant depends on actually behave as designed.
contract AscendPoC is Test {
    IAscendLaunchpad constant LP = IAscendLaunchpad(0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9);
    address constant USDC = 0x4b4fb5C5794F0c821464956374cC5872D5F0f140; // Ascend mock USDC (6 dp, public mint)

    Swapper swapper;

    function setUp() public {
        vm.createSelectFork("elysium");
        swapper = new Swapper(LP.vault(), LP.poolManager());
        IMintable(USDC).mint(address(this), 10_000e6);
    }

    function _launch(string memory sym, uint256 devBuy) internal returns (address token, PoolId id) {
        if (devBuy > 0) ERC20(USDC).approve(address(LP), devBuy);
        (token, id) = LP.launch(
            IAscendLaunchpad.LaunchParams({
                name: string.concat("Pantheon PoC ", sym),
                symbol: sym,
                quote: USDC,
                devBuyQuote: devBuy,
                minDevOut: 0,
                salt: keccak256(abi.encode(sym, block.timestamp)),
                creator: address(this)
            })
        );
    }

    /// PoC-1: a CONTRACT can be the creator and receives the dev-buy; unused quote is refunded.
    function test_PoC1_contractCreatorGetsDevBuyAndRefund() public {
        uint256 usdcBefore = ERC20(USDC).balanceOf(address(this));
        (address token, PoolId id) = _launch("PNTA", 100e6);
        assertEq(LP.poolCreator(id), address(this), "contract is creator");
        assertGt(ERC20(token).balanceOf(address(this)), 0, "dev-buy delivered to creator");
        assertLe(usdcBefore - ERC20(USDC).balanceOf(address(this)), 100e6, "spent <= dev-buy");
        console2.log("dev-buy tokens:", ERC20(token).balanceOf(address(this)) / 1e18);
    }

    /// PoC-2: the creator role hands off to a CREATE2-predicted contract that accepts in its constructor.
    function test_PoC2_roleHandoffToPredictedContract() public {
        (, PoolId id) = _launch("PNTB", 0);
        bytes32 salt = PoolId.unwrap(id);
        address predicted = vm.computeCreate2Address(
            salt, keccak256(abi.encodePacked(type(RoleTaker).creationCode, abi.encode(LP, id))), address(this)
        );
        LP.transferCreator(id, predicted);
        assertEq(LP.pendingCreator(id), predicted, "pending set");
        RoleTaker taker = new RoleTaker{salt: salt}(LP, id);
        assertEq(address(taker), predicted, "address matches prediction");
        assertEq(LP.poolCreator(id), predicted, "role accepted by contract");
    }

    /// PoC-3: trades accrue creator fees; permissionless collect + claim pays the contract creator.
    function test_PoC3_feesAccrueAndClaimPaysContract() public {
        (address token, PoolId id) = _launch("PNTC", 0);
        vm.warp(block.timestamp + 30); // past the 5 s sniper-tax decay
        PoolKey memory key = LaunchpadKey.keyOf(token, USDC, address(LP), address(LP.poolManager()));
        bool quoteIs0 = USDC < token;

        // buy: USDC -> token
        ERC20(USDC).approve(address(swapper), 1_000e6);
        uint256 got = swapper.swapExactIn(key, quoteIs0, 1_000e6);
        assertGt(got, 0, "bought tokens");
        // sell half back: token -> USDC
        ERC20(token).approve(address(swapper), got / 2);
        swapper.swapExactIn(key, !quoteIs0, got / 2);

        LP.collect(id);
        uint256 owedT = LP.creatorOwedToken(id);
        uint256 owedQ = LP.creatorOwedQuote(id);
        console2.log("owed token (1e18):", owedT / 1e18);
        console2.log("owed quote (1e6):", owedQ);
        assertGt(owedT + owedQ, 0, "fees accrued to creator");

        uint256 t0 = ERC20(token).balanceOf(address(this));
        uint256 q0 = ERC20(USDC).balanceOf(address(this));
        LP.claim(id);
        assertEq(ERC20(token).balanceOf(address(this)) - t0, owedT, "token fees paid to contract");
        assertEq(ERC20(USDC).balanceOf(address(this)) - q0, owedQ, "quote fees paid to contract");
    }
}
