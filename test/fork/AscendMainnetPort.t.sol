// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2, Vm} from "forge-std/Test.sol";
import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {AscendSwapV5} from "../../src/common/AscendSwapV5.sol";
import {
    AscendV5Key,
    V5PoolKey,
    IV5PoolManager,
    IEscrowFactoryV5,
    ISeatFactoryV5,
    ICreatorSeatV5
} from "../../src/common/AscendV5.sol";
import {ConstituentRegistry} from "../../src/index/ConstituentRegistry.sol";
import {ConstituentRegistryV5} from "../../src/index/ConstituentRegistryV5.sol";
import {IndexVaultV5} from "../../src/index/IndexVaultV5.sol";
import {PantheonStaking} from "../../src/staking/PantheonStaking.sol";
import {DeployMainnet} from "../../script/DeployMainnet.s.sol";
import {HypePassportRegistry} from "../../src/passport/HypePassportRegistry.sol";

interface IPortEscrow {
    function held() external view returns (uint256);
    function cumulativeFees() external view returns (uint256);
    function recipient() external view returns (address);
    function fee() external view returns (uint24);
    function builderFee() external view returns (uint24);
    function settle() external;
    function startHold() external;
    function graduate() external;
    function lines() external view returns (uint160, uint160, uint160, uint160);
}

contract PortSwapper is AscendSwapV5 {
    constructor(IV5PoolManager manager) AscendSwapV5(manager) {}

    function buy(V5PoolKey memory key, address quote, uint256 amount) external returns (uint256 spent, uint256 out) {
        ERC20(quote).transferFrom(msg.sender, address(this), amount);
        bool direction = key.currency0 == quote;
        (spent, out) = _swapExactIn(
            key, direction, amount, direction ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1, msg.sender
        );
        if (amount > spent) ERC20(quote).transfer(msg.sender, amount - spent);
    }
}

contract PortAgeProbe is ConstituentRegistryV5 {
    constructor(IAscendLaunchpad lp, address usdc, address pnth, address team)
        ConstituentRegistryV5(lp, usdc, pnth, team, team, 1_000e6)
    {}

    function check(Constituent memory c) external view {
        _checkOne(c, 0);
    }
}

contract PortDeploy is DeployMainnet {
    function execute(Config memory c) external returns (Deployed memory) {
        return _run(c);
    }

    function _record(Deployed memory) internal override {}
}

contract AscendMainnetPortTest is Test {
    address constant TEAM = 0xdf6aA48D464d9BC2443096f03cba4Fa750d3bdC6;
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    IAscendLaunchpad constant LP = IAscendLaunchpad(0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC);
    ISeatFactoryV5 constant SF = ISeatFactoryV5(0xBDB8d64452191041C4dAA3AD0f64bE4380FEA0b1);
    // Mainnet Launched log at block 3120163, before the pinned fork, not created by this test.
    address constant REAL_COIN = 0x35F64EAaEB793D51e8328D59b9c5AB29b42d8914;
    bytes32 constant REAL_POOL = 0xf9bb5f186363963e1593e49efe06b0e2c683aa157c8367bd0c59070acef329a8;
    address buyer = makeAddr("mainnet-third-party");
    address caller = makeAddr("permissionless-crank");
    PortDeploy script;
    DeployMainnet.Config config;
    DeployMainnet.Deployed d;
    PortSwapper swapper;
    ConstituentRegistryV5 registry;
    IndexVaultV5 vault;
    PantheonStaking staking;
    bool enabled;

    modifier forkOnly() {
        if (!enabled) vm.skip(true);
        _;
    }

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        // Only loopback Anvil endpoints are accepted by this test harness.
        require(_local(rpc), "fork tests require loopback Anvil");
        vm.createSelectFork(rpc, 3_120_548);
        assertEq(block.chainid, 99901);
        enabled = true;
        vm.deal(TEAM, 100 ether);
        deal(USDC, TEAM, 100e6);
        deal(USDC, buyer, 200_000e6);
        script = new PortDeploy();
        swapper = new PortSwapper(IV5PoolManager(script.POOL_MANAGER()));
        vm.prank(buyer);
        ERC20(USDC).approve(address(swapper), type(uint256).max);
        config = DeployMainnet.Config({
            nonce: vm.getNonce(TEAM),
            salt: keccak256("pantheon-mainnet-port-test"),
            seatSalt: keccak256("pantheon-mainnet-port-seat-test"),
            expectedRuleSet: 0xA9a627729D04576D8f79E3279bd17429C7794712,
            expectedStartTick: -400600,
            devBuyQuote: 0,
            minDevOut: 0,
            maxRunCap: 1_000e6,
            maxStale: 2 days
        });
    }

    function test_fullScriptLaunchPredictionsAndFixedTerms() public forkOnly {
        uint64 nonce = vm.getNonce(TEAM);
        _launch();
        assertEq(d.index, vm.computeCreateAddress(TEAM, uint256(nonce) + 3));
        assertEq(vm.getNonce(TEAM), nonce + 5);
        assertEq(ERC20(d.pnth).symbol(), "PNTH");
        assertEq(LP.poolCreator(PoolId.wrap(d.pool)), d.escrow);
        assertEq(IPortEscrow(d.escrow).recipient(), d.seat);
        assertEq(IPortEscrow(d.escrow).fee(), 15_000);
        assertEq(IPortEscrow(d.escrow).builderFee(), 0);
        assertEq(registry.curator(), TEAM);
        assertEq(registry.guardian(), TEAM);
        assertEq(registry.MIN_AGE(), 72 hours);
        assertEq(registry.DELAY(), 24 hours);
        assertEq(HypePassportRegistry(d.passport).ATTESTOR(), TEAM);
        _slots();
        assertEq(vault.claimFees(), 0);
        vault.rebalance(0);
        assertEq(vault.cursor(), 0);
    }

    function test_thirdPartyBuyReleasedFeesArePulled15And85() public forkOnly {
        _launch();
        _buy(d.pnth, 100e6);
        _payout(true);
        assertEq(vault.claimFees(), 0, "idempotent claim");
    }

    function test_emptyListStreamsUSDCAndStakerClaims() public forkOnly {
        _launch();
        _buy(d.pnth, 100e6);
        _stake();
        _payout(true);
        uint256 amount = ERC20(USDC).balanceOf(d.index);
        vm.prank(caller);
        vault.rebalance(1);
        assertEq(ERC20(USDC).balanceOf(d.index), 0);
        assertEq(ERC20(USDC).balanceOf(d.staking), amount);
        vm.warp(block.timestamp + 1 days + 1);
        uint256 before = ERC20(USDC).balanceOf(buyer);
        vm.prank(buyer);
        staking.claim();
        assertGt(ERC20(USDC).balanceOf(buyer), before);
    }

    function test_existingMainnetCoinAgeUsesLaunchTimeNotRegistryDeployment() public forkOnly {
        _launch();
        uint256 deployedAt = vm.getBlockTimestamp();
        uint256 launchedAt = LP.poolLaunchedAt(PoolId.wrap(REAL_POOL));
        assertGt(launchedAt, 0);
        assertLt(launchedAt, deployedAt);
        assertGt(REAL_COIN.code.length, 0);
        assertEq(keccak256(abi.encode(AscendV5Key.keyOf(REAL_COIN, USDC, address(LP)))), REAL_POOL);
        PortAgeProbe probe = new PortAgeProbe(LP, USDC, d.pnth, TEAM);
        ConstituentRegistry.Constituent memory coin =
            ConstituentRegistry.Constituent(PoolId.wrap(REAL_POOL), REAL_COIN, 2000, 1e6);
        vm.warp(launchedAt + 72 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(ConstituentRegistry.BadList.selector, 0));
        probe.check(coin);
        vm.warp(launchedAt + 72 hours);
        assertLt(block.timestamp, deployedAt + 72 hours);
        probe.check(coin);
        coin.poolId = PoolId.wrap(bytes32(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(ConstituentRegistry.BadList.selector, 0));
        probe.check(coin);
    }

    function test_realConstituentRebalanceStreamsCoinsAndStakerClaims() public forkOnly {
        _launch();
        ConstituentRegistry.Constituent[] memory list = _basket();
        vm.warp(block.timestamp + 72 hours);
        vm.prank(TEAM);
        uint256 id = registry.propose(list, keccak256("fork scores"), "ipfs://fork-methodology");
        vm.expectRevert(ConstituentRegistry.NotReady.selector);
        registry.execute(id);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(caller);
        registry.execute(id);
        // Refresh only by real swaps, with no mocked EMA, slot0, hook or pool state.
        for (uint256 i; i < list.length; ++i) {
            _buy(list[i].token, 1e6);
        }
        _buy(d.pnth, 100e6);
        _stake();
        _payout(true);
        uint256 before = ERC20(USDC).balanceOf(d.index);
        vm.prank(caller);
        vault.rebalance(5);
        assertLt(ERC20(USDC).balanceOf(d.index), before);
        assertGt(ERC20(REAL_COIN).balanceOf(d.staking), 0, "real mainnet coin streamed");
        for (uint256 i; i < list.length; ++i) {
            assertGt(ERC20(list[i].token).balanceOf(d.staking), 0);
            assertEq(ERC20(list[i].token).balanceOf(d.index), 0);
        }
        vm.warp(block.timestamp + 1 days + 1);
        uint256 had = ERC20(REAL_COIN).balanceOf(buyer);
        vm.prank(buyer);
        staking.claim();
        assertGt(ERC20(REAL_COIN).balanceOf(buyer), had);
        assertEq(ERC20(REAL_COIN).allowance(d.index, d.staking), 0);
    }

    function test_heldFeesUnlockAfterRealVolumeAndOneHourHold() public forkOnly {
        _launch();
        _buy(d.pnth, 100e6);
        _payout(true);
        IPortEscrow escrow = IPortEscrow(d.escrow);
        uint256 heldBefore = escrow.held();
        (uint160 grad,,,) = escrow.lines();
        bool tokenIs0 = LP.poolTokenIs0(PoolId.wrap(d.pool));
        bool above;
        for (uint256 i; i < 64; ++i) {
            vm.warp(block.timestamp + 5 minutes);
            _buy(d.pnth, 1_000e6);
            uint160 ema = LP.emaSqrtPrice(PoolId.wrap(d.pool));
            above = tokenIs0 ? ema > grad : ema < grad;
            if (above) break;
        }
        assertTrue(above, "real trades must bring EMA over graduation line");
        escrow.startHold();
        vm.expectRevert();
        escrow.graduate();
        vm.warp(block.timestamp + 1 hours + 1);
        _buy(d.pnth, 1e6);
        escrow.graduate();
        assertEq(escrow.held(), 0, "held allocation released");
        uint256 teamBefore = ERC20(USDC).balanceOf(TEAM);
        uint256 vaultBefore = ERC20(USDC).balanceOf(d.index);
        _payout(false);
        uint256 paid = ERC20(USDC).balanceOf(TEAM) - teamBefore + ERC20(USDC).balanceOf(d.index) - vaultBefore;
        assertGt(paid, heldBefore);
    }

    function test_devBuyIsUSDCFundedPaysTeamAndClearsApproval() public forkOnly {
        config.devBuyQuote = 1e6;
        config.minDevOut = 1;
        uint256 before = ERC20(USDC).balanceOf(TEAM);
        _launch();
        assertGt(ERC20(d.pnth).balanceOf(TEAM), 0);
        assertLt(ERC20(USDC).balanceOf(TEAM), before);
        assertGe(ERC20(USDC).balanceOf(TEAM), before - 1e6);
        assertEq(ERC20(USDC).allowance(TEAM, address(SF)), 0);
    }

    function test_governanceAgeTimelockAndGuardianAreUnchanged() public forkOnly {
        _launch();
        ConstituentRegistry.Constituent[] memory list = _basket();
        vm.expectRevert(ConstituentRegistry.NotCurator.selector);
        registry.propose(list, bytes32(0), "");
        vm.prank(TEAM);
        vm.expectRevert(abi.encodeWithSelector(ConstituentRegistry.BadList.selector, 0));
        registry.propose(list, bytes32(0), "");
        vm.warp(block.timestamp + 72 hours);
        vm.prank(TEAM);
        uint256 id = registry.propose(list, bytes32(0), "");
        vm.expectRevert(ConstituentRegistry.NotGuardian.selector);
        registry.veto(id);
        vm.prank(TEAM);
        registry.veto(id);
        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert(ConstituentRegistry.AlreadySettled.selector);
        registry.execute(id);
        list[0].poolId = PoolId.wrap(bytes32(uint256(7)));
        vm.prank(TEAM);
        vm.expectRevert(abi.encodeWithSelector(ConstituentRegistry.BadList.selector, 0));
        registry.propose(list, bytes32(0), "");
    }

    function test_callbackAndQuoteFlushAreProtected() public forkOnly {
        _launch();
        vm.expectRevert(AscendSwapV5.UnexpectedCallback.selector);
        vault.unlockCallback("");
        vm.prank(script.POOL_MANAGER());
        vm.expectRevert(AscendSwapV5.UnexpectedCallback.selector);
        vault.unlockCallback("");
        vm.expectRevert(IndexVaultV5.QuoteIsBudget.selector);
        vault.flush(USDC);
    }

    function test_refusedStreamRetainsCoinsAndClearsAllowance() public forkOnly {
        _launch();
        deal(REAL_COIN, d.index, 1e18);
        vm.expectEmit(true, false, false, true, d.index);
        emit IndexVaultV5.StreamFailed(REAL_COIN, 1e18);
        vault.flush(REAL_COIN);
        assertEq(ERC20(REAL_COIN).balanceOf(d.index), 1e18);
        assertEq(ERC20(REAL_COIN).balanceOf(d.staking), 0);
        assertEq(ERC20(REAL_COIN).allowance(d.index, d.staking), 0);
    }

    function test_stalePriceBandAndBreakerSkipWithoutSpending() public forkOnly {
        _launch();
        ConstituentRegistry.Constituent[] memory list = _basket();
        vm.warp(block.timestamp + 72 hours);
        vm.prank(TEAM);
        uint256 id = registry.propose(list, bytes32(0), "");
        vm.warp(block.timestamp + 24 hours);
        registry.execute(id);
        deal(USDC, d.index, 10e6);
        vm.expectEmit(true, false, false, true, d.index);
        emit IndexVaultV5.BasketSkip(REAL_COIN, IndexVaultV5.Skip.STALE_AVERAGE);
        vault.rebalance(1);
        assertEq(ERC20(USDC).balanceOf(d.index), 10e6);
        _buy(list[1].token, 1_000e6);
        vm.expectEmit(true, false, false, true, d.index);
        emit IndexVaultV5.BasketSkip(list[1].token, IndexVaultV5.Skip.PRICE_OUT_OF_BAND);
        vault.rebalance(1);
        assertEq(ERC20(USDC).balanceOf(d.index), 10e6);
        vault.rebalance(4);
        assertEq(vault.cursor(), 1);
        for (uint256 i; i < 3; ++i) {
            _buy(list[1].token, 1_000e6);
        }
        vm.warp(block.timestamp + 6 hours);
        _buy(list[1].token, 1e6);
        vm.expectEmit(true, false, false, true, d.index);
        emit IndexVaultV5.BasketSkip(list[1].token, IndexVaultV5.Skip.BREAKER);
        vault.rebalance(1);
        assertEq(ERC20(USDC).balanceOf(d.index), 10e6);
    }

    function test_environmentParserRejectsIntegerTruncation() public forkOnly {
        vm.setEnv("MAINNET_EXPECTED_NONCE", vm.toString(uint256(config.nonce)));
        vm.setEnv("MAINNET_PNTH_SALT", vm.toString(config.salt));
        vm.setEnv("MAINNET_SEAT_SALT", vm.toString(config.seatSalt));
        vm.setEnv("MAINNET_EXPECTED_RULESET", vm.toString(config.expectedRuleSet));
        vm.setEnv("MAINNET_EXPECTED_START_TICK", "8388608");
        vm.expectRevert(bytes("tick overflow"));
        script.config();
        vm.setEnv("MAINNET_EXPECTED_START_TICK", "-400600");
        vm.setEnv("MAINNET_EXPECTED_NONCE", vm.toString(uint256(type(uint64).max) + 1));
        vm.expectRevert(bytes("nonce overflow"));
        script.config();
        vm.setEnv("MAINNET_EXPECTED_NONCE", vm.toString(uint256(config.nonce)));
        vm.setEnv("MAINNET_MAX_RUN_CAP", vm.toString(uint256(type(uint128).max) + 1));
        vm.expectRevert(bytes("invalid run cap"));
        script.config();
        vm.setEnv("MAINNET_MAX_RUN_CAP", "1000000000");
        vm.setEnv("MAINNET_MAX_STALE", vm.toString(type(uint256).max));
        vm.expectRevert(bytes("invalid staleness"));
        script.config();
    }

    function test_badTermsFailBeforeAnyDeployTransaction() public forkOnly {
        uint64 nonce = vm.getNonce(TEAM);
        config.expectedStartTick = -400599;
        vm.expectRevert(bytes("quote terms changed"));
        script.execute(config);
        assertEq(vm.getNonce(TEAM), nonce);
        assertEq(vm.computeCreateAddress(TEAM, nonce).code.length, 0);
        config.expectedStartTick = -400600;
        config.expectedRuleSet = address(script);
        vm.expectRevert(bytes("RuleSet changed"));
        script.execute(config);
        assertEq(vm.getNonce(TEAM), nonce);
    }

    function test_badDevBuyAndNonceInputsFailBeforeAnyTransaction() public forkOnly {
        uint64 nonce = vm.getNonce(TEAM);
        config.devBuyQuote = 1;
        vm.expectRevert(bytes("dev buy needs minimum output"));
        script.execute(config);
        assertEq(vm.getNonce(TEAM), nonce);
        config.devBuyQuote = 0;
        config.nonce += 1;
        vm.expectRevert(bytes("deployer nonce changed"));
        script.execute(config);
        assertEq(vm.getNonce(TEAM), nonce);
    }

    function _launch() internal {
        d = script.execute(config);
        registry = ConstituentRegistryV5(d.registry);
        vault = IndexVaultV5(d.index);
        staking = PantheonStaking(d.staking);
    }

    function _slots() internal view {
        (address team, uint16 teamBps,,) = ICreatorSeatV5(d.seat).slot(0);
        (address basket, uint16 basketBps,,) = ICreatorSeatV5(d.seat).slot(1);
        assertEq(team, TEAM);
        assertEq(teamBps, 1500);
        assertEq(basket, d.index);
        assertEq(basketBps, 8500);
    }

    function _buy(address token, uint256 amount) internal {
        vm.prank(buyer);
        (uint256 spent, uint256 out) = swapper.buy(AscendV5Key.keyOf(token, USDC, address(LP)), USDC, amount);
        assertGt(spent, 0);
        assertGt(out, 0);
    }

    function _stake() internal {
        vm.startPrank(buyer);
        ERC20(d.pnth).approve(d.staking, type(uint256).max);
        staking.stake(ERC20(d.pnth).balanceOf(buyer));
        vm.stopPrank();
    }

    function _payout(bool held) internal {
        ICreatorSeatV5 seat = ICreatorSeatV5(d.seat);
        vm.prank(caller);
        seat.harvest();
        if (held) assertGt(IPortEscrow(d.escrow).held(), 0, "pre-graduation fees really held");
        uint256 teamDue = seat.claimable(0, false);
        uint256 basketDue = seat.claimable(1, false);
        assertGt(teamDue, 0);
        assertGt(basketDue, 0);
        uint256 total = teamDue + basketDue;
        assertApproxEqAbs(teamDue, total * 1500 / 10_000, 1);
        assertApproxEqAbs(basketDue, total * 8500 / 10_000, 1);
        uint256 teamBefore = ERC20(USDC).balanceOf(TEAM);
        uint256 vaultBefore = ERC20(USDC).balanceOf(d.index);
        uint256 callerBefore = ERC20(USDC).balanceOf(caller);
        vm.prank(caller);
        assertEq(vault.claimFees(), basketDue);
        vm.prank(caller);
        assertEq(seat.claim(0, false), teamDue);
        assertEq(ERC20(USDC).balanceOf(TEAM) - teamBefore, teamDue);
        assertEq(ERC20(USDC).balanceOf(d.index) - vaultBefore, basketDue);
        assertEq(ERC20(USDC).balanceOf(caller), callerBefore, "crank cannot redirect funds");
        console2.log("Released team / vault USDC base units:", teamDue, basketDue);
        console2.log("Held USDC base units:", IPortEscrow(d.escrow).held());
    }

    function _basket() internal returns (ConstituentRegistry.Constituent[] memory list) {
        list = new ConstituentRegistry.Constituent[](5);
        list[0] = ConstituentRegistry.Constituent(PoolId.wrap(REAL_POOL), REAL_COIN, 2000, 1e6);
        for (uint256 i = 1; i < 5; ++i) {
            DeployMainnet.Config memory c = config;
            c.salt = keccak256(abi.encode("local constituent", i));
            IEscrowFactoryV5.LaunchParams memory p = script.launchParams(c);
            p.name = "Fork constituent";
            p.symbol = "FRK";
            ISeatFactoryV5.SeatConfig memory seatConfig;
            seatConfig.devBuyTo = TEAM;
            seatConfig.payees = new address[](1);
            seatConfig.payees[0] = TEAM;
            seatConfig.bps = new uint16[](1);
            seatConfig.bps[0] = 10_000;
            (address token, bytes32 pool,,) = SF.launchChecked(
                p,
                seatConfig,
                keccak256(abi.encode("local constituent seat", i)),
                address(0),
                c.expectedRuleSet,
                c.expectedStartTick
            );
            list[i] = ConstituentRegistry.Constituent(PoolId.wrap(pool), token, 2000, 1e6);
        }
    }

    function _local(string memory rpc) internal pure returns (bool) {
        bytes memory p = bytes("http://127.0.0.1:");
        bytes memory r = bytes(rpc);
        if (r.length <= p.length) return false;
        for (uint256 i; i < p.length; ++i) {
            if (r[i] != p[i]) return false;
        }
        for (uint256 i = p.length; i < r.length; ++i) {
            if (r[i] < 0x30 || r[i] > 0x39) return false;
        }
        return true;
    }
}
