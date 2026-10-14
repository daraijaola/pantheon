// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2, Vm} from "forge-std/Test.sol";
import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {LaunchpadKey} from "ascend/libraries/LaunchpadKey.sol";
import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {Swapper} from "./AscendPoC.t.sol";
import {CovenantFactory} from "../../src/covenant/CovenantFactory.sol";
import {CovenantRouter} from "../../src/covenant/CovenantRouter.sol";
import {ConstituentRegistry} from "../../src/index/ConstituentRegistry.sol";
import {IndexVault, IStakingRewards} from "../../src/index/IndexVault.sol";
import {PantheonStaking, IRewardList} from "../../src/staking/PantheonStaking.sol";
import {IHypePassport} from "../../src/passport/IHypePassport.sol";

interface IMintable {
    function mint(address to, uint256 value) external;
}

/// The whole PANTHEON loop against Ascend's LIVE Elysium testnet deployment (forked):
/// launch PNTH through Covenant, trade it, route its fees (sells burned, buys to the basket),
/// pick the basket through the registry's 24 h wait, buy it with Ascend's price guard,
/// stream it to stakers, claim it, and unstake through the 3-day unlock.
contract PantheonForkTest is Test {
    IAscendLaunchpad constant LP = IAscendLaunchpad(0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9);
    address constant USDC = 0x4b4fb5C5794F0c821464956374cC5872D5F0f140;
    address constant BURN_SINK = 0xC889ac2f59A88afb3B2FB3f2C452DBa336fE5f0F;

    address curator = makeAddr("curator");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");

    Swapper swapper;
    CovenantFactory factory;
    ConstituentRegistry registry;
    PantheonStaking staking;
    IndexVault index;

    address pnth;
    PoolId pnthPool;
    CovenantRouter router;
    // At most 20% per coin means at least five coins: the test basket is five at 20% each.
    uint256 constant N = 5;
    address[N] coins;
    PoolId[N] coinPools;

    function setUp() public {
        vm.createSelectFork("elysium");
        swapper = new Swapper(LP.vault(), LP.poolManager());
        IMintable(USDC).mint(address(this), 1_000_000e6);
        IMintable(USDC).mint(alice, 100_000e6);
        ERC20(USDC).approve(address(swapper), type(uint256).max);

        // The basket's coins, launched now and aged past the registry's 3-day minimum.
        for (uint256 i; i < N; ++i) {
            (coins[i], coinPools[i]) = _launchPlain(string.concat("Basket ", vm.toString(i)), string.concat("BSK", vm.toString(i)));
        }
        vm.warp(block.timestamp + 30);
        for (uint256 i; i < N; ++i) _buy(coins[i], 2_000e6);
        vm.warp(block.timestamp + 3 days + 1 hours);
        for (uint256 i; i < N; ++i) _buy(coins[i], 200e6); // fresh trades keep Ascend's average current

        // PANTHEON's contracts. The basket vault's address is known in advance (CREATE from this
        // contract), so PNTH's router can name it as the target of the USDC leg from the first block.
        // Like a deploy script's transactions, the launch call itself uses one nonce; then come the
        // registry, staking and the vault.
        factory = new CovenantFactory(LP, BURN_SINK);
        uint256 nonce = vm.getNonce(address(this));
        address predictedIndex = vm.computeCreateAddress(address(this), nonce + 3);

        CovenantRouter.Leg[] memory tokenLegs = new CovenantRouter.Leg[](1);
        tokenLegs[0] = CovenantRouter.Leg(CovenantRouter.Job.BURN, 10_000, address(0));
        CovenantRouter.Leg[] memory quoteLegs = new CovenantRouter.Leg[](1);
        quoteLegs[0] = CovenantRouter.Leg(CovenantRouter.Job.INDEX, 10_000, predictedIndex);
        address r;
        (pnth, pnthPool, r) = factory.launch("PANTHEON", "PNTH", USDC, keccak256("pnth-test"), tokenLegs, quoteLegs);
        router = CovenantRouter(r);

        registry = new ConstituentRegistry(LP, USDC, pnth, curator, guardian, 10_000e6); // nonce + 1
        staking = new PantheonStaking(ERC20(pnth), IHypePassport(address(0)), IRewardList(address(registry))); // nonce + 2
        index = new IndexVault(LP, registry, IStakingRewards(address(staking)), 2 days); // nonce + 3
        assertEq(address(index), predictedIndex, "basket vault at the address the router names");
    }

    // ------------------------------------------------------------------ Covenant

    function test_covenantHoldsTheRoleForever() public view {
        assertEq(LP.poolCreator(pnthPool), address(router), "router is the creator");
        assertEq(LP.pendingCreator(pnthPool), address(0), "no handoff pending");
        CovenantRouter.Leg[] memory t = router.legs(0);
        CovenantRouter.Leg[] memory q = router.legs(1);
        assertEq(uint8(t[0].job), uint8(CovenantRouter.Job.BURN));
        assertEq(uint8(q[0].job), uint8(CovenantRouter.Job.INDEX));
        assertEq(q[0].target, address(index));
    }

    function test_feesRoute_sellsBurned_buysToBasket() public {
        vm.warp(block.timestamp + 30); // past the sniper tax
        uint256 got = _buy(pnth, 5_000e6);
        _sell(pnth, got / 2);

        uint256 sinkBefore = ERC20(pnth).balanceOf(BURN_SINK);
        uint256 indexBefore = ERC20(USDC).balanceOf(address(index));
        (uint256 newToken, uint256 newQuote) = router.run();
        console2.log("PNTH fees burned (1e18):", newToken / 1e18);
        console2.log("USDC fees to basket (1e6):", newQuote);

        assertGt(newToken, 0, "sell fees arrived");
        assertGt(newQuote, 0, "buy fees arrived");
        assertEq(ERC20(pnth).balanceOf(BURN_SINK) - sinkBefore, newToken, "all PNTH fees burned");
        assertEq(ERC20(USDC).balanceOf(address(index)) - indexBefore, newQuote, "all USDC fees to the basket");
        assertEq(ERC20(pnth).balanceOf(address(router)), 0, "router keeps nothing");
        assertEq(ERC20(USDC).balanceOf(address(router)), 0, "router keeps nothing");

        // A second run with no new trades moves nothing.
        (newToken, newQuote) = router.run();
        assertEq(newToken + newQuote, 0, "nothing new");
    }

    // ------------------------------------------------------------------ the basket

    function test_registryRules() public {
        ConstituentRegistry.Constituent[] memory list = _basketList();

        vm.expectRevert(ConstituentRegistry.NotCurator.selector);
        registry.propose(list, bytes32(0), "");

        // A coin above 20% is refused, even when the weights add up.
        list[0].weightBps = 4_000;
        list[1].weightBps = 1_000;
        list[2].weightBps = 1_000;
        vm.prank(curator);
        vm.expectRevert(abi.encodeWithSelector(ConstituentRegistry.BadList.selector, 0));
        registry.propose(list, bytes32(0), "");

        // PNTH itself can never be in its own basket.
        list = _basketList();
        list[0].token = pnth;
        list[0].poolId = pnthPool;
        vm.prank(curator);
        vm.expectRevert(abi.encodeWithSelector(ConstituentRegistry.BadList.selector, 0));
        registry.propose(list, bytes32(0), "");

        // A valid list waits 24 hours, and the guardian can veto it.
        vm.prank(curator);
        uint256 id = registry.propose(_basketList(), keccak256("scores"), "ipfs://method");
        vm.expectRevert(ConstituentRegistry.NotReady.selector);
        registry.execute(id);
        vm.prank(guardian);
        registry.veto(id);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(ConstituentRegistry.AlreadySettled.selector);
        registry.execute(id);
    }

    function test_endToEnd_buyBasketStreamClaimUnstake() public {
        // Alice buys PNTH and stakes it.
        vm.warp(block.timestamp + 30);
        vm.startPrank(alice);
        ERC20(USDC).approve(address(swapper), type(uint256).max);
        uint256 alicePnth = swapper.swapExactIn(_key(pnth), _quoteIs0(pnth), 10_000e6);
        ERC20(pnth).approve(address(staking), alicePnth);
        staking.stake(alicePnth);
        vm.stopPrank();

        // Trading builds fees; Covenant routes them.
        uint256 got = _buy(pnth, 20_000e6);
        _sell(pnth, got / 2);
        (, uint256 toBasket) = router.run();
        assertGt(toBasket, 0, "USDC reached the basket");

        // The Trials result: five coins, through the 24-hour wait.
        vm.prank(curator);
        uint256 id = registry.propose(_basketList(), keccak256("scores"), "ipfs://method");
        vm.warp(block.timestamp + 1 days + 1);
        registry.execute(id);
        _settleAverages(); // an active market: small trades let Ascend's average catch up to the price
        assertEq(registry.active().length, N, "basket active");

        // Anyone can trigger the buy. Each coin is bought inside Ascend's price band.
        vm.recordLogs();
        index.rebalance(N);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 buys;
        for (uint256 i; i < logs.length; ++i) if (logs[i].topics[0] == IndexVault.BasketBuy.selector) buys++;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IndexVault.BasketSkip.selector) {
                console2.log("skipped", address(uint160(uint256(logs[i].topics[1]))), abi.decode(logs[i].data, (uint8)));
            }
        }
        assertEq(buys, N, "every coin bought");
        for (uint256 i; i < N; ++i) assertGt(ERC20(coins[i]).balanceOf(address(staking)), 0, "coin streamed to stakers");

        // A day later the stream has paid out; Alice claims every coin.
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice);
        staking.claim();
        for (uint256 i; i < N; ++i) {
            uint256 bal = ERC20(coins[i]).balanceOf(alice);
            console2.log("Alice earned (1e18):", bal / 1e18);
            assertGt(bal, 0, "Alice earned the coin");
            // She is the only staker, so she gets the whole stream, less rounding dust.
            assertApproxEqRel(bal + ERC20(coins[i]).balanceOf(address(staking)), bal, 1e15);
        }

        // Unstaking takes 3 days.
        vm.startPrank(alice);
        staking.requestUnstake(alicePnth);
        vm.expectRevert();
        staking.withdraw();
        vm.warp(block.timestamp + 3 days);
        staking.withdraw();
        vm.stopPrank();
        assertEq(ERC20(pnth).balanceOf(alice), alicePnth, "PNTH back");
    }

    // ------------------------------------------------------------------ helpers

    function _launchPlain(string memory name, string memory sym) internal returns (address token, PoolId id) {
        (token, id) = LP.launch(
            IAscendLaunchpad.LaunchParams({
                name: name,
                symbol: sym,
                quote: USDC,
                devBuyQuote: 0,
                minDevOut: 0,
                salt: keccak256(abi.encode(sym, block.timestamp)),
                creator: address(this)
            })
        );
    }

    function _basketList() internal view returns (ConstituentRegistry.Constituent[] memory list) {
        list = new ConstituentRegistry.Constituent[](N);
        for (uint256 i; i < N; ++i) list[i] = ConstituentRegistry.Constituent(coinPools[i], coins[i], 2_000, 1_000e6);
    }

    /// Ascend's average only moves when someone trades (at most halfway per trade, once per 10 min of
    /// weight). A few tiny trades ten minutes apart, like any active market, bring it to the price.
    function _settleAverages() internal {
        for (uint256 k; k < 6; ++k) {
            vm.warp(block.timestamp + 601);
            for (uint256 i; i < N; ++i) _buy(coins[i], 1e6);
        }
    }

    function _key(address token) internal view returns (PoolKey memory) {
        return LaunchpadKey.keyOf(token, USDC, address(LP), address(LP.poolManager()));
    }

    function _quoteIs0(address token) internal pure returns (bool) {
        return USDC < token;
    }

    function _buy(address token, uint256 usdc) internal returns (uint256) {
        return swapper.swapExactIn(_key(token), _quoteIs0(token), usdc);
    }

    function _sell(address token, uint256 amount) internal returns (uint256) {
        ERC20(token).approve(address(swapper), amount);
        return swapper.swapExactIn(_key(token), !_quoteIs0(token), amount);
    }
}
