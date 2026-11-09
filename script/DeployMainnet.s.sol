// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {
    AscendV5Key,
    IEscrowFactoryV5,
    ISeatFactoryV5,
    ICreatorSeatV5,
    IV5StateView,
    IV5LaunchState
} from "../src/common/AscendV5.sol";
import {ConstituentRegistryV5} from "../src/index/ConstituentRegistryV5.sol";
import {IndexVaultV5} from "../src/index/IndexVaultV5.sol";
import {IStakingRewards} from "../src/index/IndexVault.sol";
import {PantheonStaking, IRewardList} from "../src/staking/PantheonStaking.sol";
import {HypePassportRegistry} from "../src/passport/HypePassportRegistry.sol";
import {IHypePassport} from "../src/passport/IHypePassport.sol";

/// @notice Keyless mainnet deployment plan. Simulation needs no signer; never reads a private key.
contract DeployMainnet is Script {
    using SafeTransferLib for ERC20;

    address public constant TEAM = 0xdf6aA48D464d9BC2443096f03cba4Fa750d3bdC6;
    IAscendLaunchpad public constant LAUNCHPAD = IAscendLaunchpad(0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC);
    ISeatFactoryV5 public constant SEAT_FACTORY = ISeatFactoryV5(0xBDB8d64452191041C4dAA3AD0f64bE4380FEA0b1);
    IEscrowFactoryV5 public constant ESCROW_FACTORY = IEscrowFactoryV5(0x63f6a8A8d0257c0363251a50cdE8A8b1046e4d19);
    address public constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address public constant POOL_MANAGER = 0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1;
    IV5StateView public constant STATE_VIEW = IV5StateView(0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE);

    struct Config {
        uint64 nonce;
        bytes32 salt;
        bytes32 seatSalt;
        address expectedRuleSet;
        int24 expectedStartTick;
        uint256 devBuyQuote;
        uint256 minDevOut;
        uint128 maxRunCap;
        uint256 maxStale;
    }

    struct Deployed {
        address passport;
        address registry;
        address staking;
        address index;
        address pnth;
        bytes32 pool;
        address seat;
        address escrow;
    }

    function run() external returns (Deployed memory d) {
        return _run(config());
    }

    function _run(Config memory c) internal returns (Deployed memory d) {
        _checkInputs(c);
        d = predict(c);
        _validate(c, d);
        console2.log("Mainnet chain:", block.chainid);
        console2.log("Deployer and all roles:", TEAM);
        console2.log("Expected nonce:", c.nonce);
        console2.log("Expected RuleSet:", c.expectedRuleSet);
        console2.logInt(c.expectedStartTick);
        console2.log("Dev buy USDC base units:", c.devBuyQuote);
        console2.log("Minimum dev tokens:", c.minDevOut);
        vm.startBroadcast(TEAM);
        require(address(new HypePassportRegistry(TEAM, TEAM)) == d.passport, "passport prediction");
        require(
            address(new ConstituentRegistryV5(LAUNCHPAD, USDC, d.pnth, TEAM, TEAM, c.maxRunCap)) == d.registry,
            "registry prediction"
        );
        require(
            address(new PantheonStaking(ERC20(d.pnth), IHypePassport(d.passport), IRewardList(d.registry)))
                == d.staking,
            "staking prediction"
        );
        require(
            address(
                new IndexVaultV5(
                    LAUNCHPAD,
                    STATE_VIEW,
                    ConstituentRegistryV5(d.registry),
                    IStakingRewards(d.staking),
                    ICreatorSeatV5(d.seat),
                    c.maxStale
                )
            ) == d.index,
            "vault prediction"
        );
        if (c.devBuyQuote > 0) ERC20(USDC).safeApprove(address(SEAT_FACTORY), c.devBuyQuote);
        (address token, bytes32 pool, address seat, address escrow) = SEAT_FACTORY.launchChecked(
            launchParams(c), seatConfig(d.index), c.seatSalt, address(0), c.expectedRuleSet, c.expectedStartTick
        );
        require(token == d.pnth && pool == d.pool && seat == d.seat && escrow == d.escrow, "launch prediction");
        if (c.devBuyQuote > 0) ERC20(USDC).safeApprove(address(SEAT_FACTORY), 0);
        vm.stopBroadcast();
        require(ICreatorSeatV5(d.seat).escrow() == d.escrow, "seat escrow binding");
        require(ICreatorSeatV5(d.seat).quote() == USDC, "seat quote binding");
        require(LAUNCHPAD.poolCreator(PoolId.wrap(d.pool)) == d.escrow, "creator binding");
        require(LAUNCHPAD.currentFee(PoolId.wrap(d.pool)) == 15_000, "launch fee");
        _record(d);
    }

    function config() public view returns (Config memory c) {
        require(block.chainid == 99901, "mainnet chainId required");
        uint256 nonce = vm.envUint("MAINNET_EXPECTED_NONCE");
        require(nonce <= type(uint64).max, "nonce overflow");
        c.nonce = uint64(nonce);
        c.salt = vm.envBytes32("MAINNET_PNTH_SALT");
        c.seatSalt = vm.envBytes32("MAINNET_SEAT_SALT");
        c.expectedRuleSet = vm.envAddress("MAINNET_EXPECTED_RULESET");
        int256 tick = vm.envInt("MAINNET_EXPECTED_START_TICK");
        require(tick >= type(int24).min && tick <= type(int24).max, "tick overflow");
        c.expectedStartTick = int24(tick);
        c.devBuyQuote = vm.envOr("MAINNET_DEV_BUY_QUOTE", uint256(0));
        c.minDevOut = vm.envOr("MAINNET_MIN_DEV_OUT", uint256(0));
        uint256 cap = vm.envOr("MAINNET_MAX_RUN_CAP", uint256(1_000e6));
        require(cap > 0 && cap <= type(uint128).max, "invalid run cap");
        c.maxRunCap = uint128(cap);
        c.maxStale = vm.envOr("MAINNET_MAX_STALE", uint256(2 days));
        _checkInputs(c);
    }

    function _checkInputs(Config memory c) internal pure {
        require(c.nonce <= type(uint64).max - 7, "nonce too high");
        require(c.maxRunCap > 0, "invalid run cap");
        require(c.maxStale > 0 && c.maxStale <= type(uint40).max, "invalid staleness");
        require(c.salt != bytes32(0) && c.seatSalt != bytes32(0), "zero salt");
        require(c.devBuyQuote <= uint256(uint128(type(int128).max)), "dev buy overflow");
        require(c.devBuyQuote == 0 ? c.minDevOut == 0 : c.minDevOut > 0, "dev buy needs minimum output");
    }

    function predict(Config memory c) public view returns (Deployed memory d) {
        d.passport = vm.computeCreateAddress(TEAM, c.nonce);
        d.registry = vm.computeCreateAddress(TEAM, uint256(c.nonce) + 1);
        d.staking = vm.computeCreateAddress(TEAM, uint256(c.nonce) + 2);
        d.index = vm.computeCreateAddress(TEAM, uint256(c.nonce) + 3);
        d.seat = SEAT_FACTORY.predict(TEAM, seatConfig(d.index), c.seatSalt);
        IEscrowFactoryV5.LaunchParams memory p = launchParams(c);
        // SeatFactory namespaces the launch salt before forwarding to EscrowFactory.
        p.salt = keccak256(abi.encode(TEAM, p.salt));
        (d.escrow, d.pnth) =
            ESCROW_FACTORY.predict(address(SEAT_FACTORY), p, IEscrowFactoryV5.Route(d.seat, TEAM, address(0), false));
        d.pool = keccak256(abi.encode(AscendV5Key.keyOf(d.pnth, USDC, address(LAUNCHPAD))));
    }

    function launchParams(Config memory c) public pure returns (IEscrowFactoryV5.LaunchParams memory) {
        return IEscrowFactoryV5.LaunchParams(
            "PANTHEON", "PNTH", USDC, c.devBuyQuote, c.minDevOut, c.salt, address(0), 15_000, 0
        );
    }

    function seatConfig(address index) public pure returns (ISeatFactoryV5.SeatConfig memory c) {
        c.devBuyTo = TEAM;
        c.payees = new address[](2);
        c.payees[0] = TEAM;
        c.payees[1] = index;
        c.bps = new uint16[](2);
        c.bps[0] = 1500;
        c.bps[1] = 8500;
    }

    function _validate(Config memory c, Deployed memory d) internal view {
        require(block.chainid == 99901, "mainnet chainId required");
        require(vm.getNonce(TEAM) == c.nonce, "deployer nonce changed");
        require(TEAM.balance > 0, "deployer needs native gas");
        require(address(LAUNCHPAD).code.length > 0 && USDC.code.length > 0, "missing launchpad/USDC");
        require(address(SEAT_FACTORY).code.length > 0 && address(ESCROW_FACTORY).code.length > 0, "missing factories");
        require(POOL_MANAGER.code.length > 0 && address(STATE_VIEW).code.length > 0, "missing v4 infrastructure");
        require(c.expectedRuleSet.code.length > 0, "missing RuleSet");
        require(!IV5LaunchState(address(LAUNCHPAD)).paused(), "launches paused");
        require(LAUNCHPAD.baseQuote() == USDC && address(LAUNCHPAD.poolManager()) == POOL_MANAGER, "wrong launchpad");
        require(SEAT_FACTORY.launchpad() == address(LAUNCHPAD), "wrong seat launchpad");
        require(SEAT_FACTORY.escrowFactory() == address(ESCROW_FACTORY), "wrong escrow factory");
        require(ESCROW_FACTORY.launchpad() == address(LAUNCHPAD), "wrong escrow launchpad");
        require(ESCROW_FACTORY.ruleSet() == c.expectedRuleSet, "RuleSet changed");
        IAscendLaunchpad.QuoteConfig memory q = LAUNCHPAD.quoteConfig(USDC);
        require(q.allowed && q.startTick == c.expectedStartTick, "quote terms changed");
        require(ERC20(USDC).balanceOf(TEAM) >= c.devBuyQuote, "insufficient dev buy USDC");
        if (c.devBuyQuote > 0) {
            require(ERC20(USDC).allowance(TEAM, address(SEAT_FACTORY)) == 0, "clear seat allowance first");
        }
        require(d.passport.code.length == 0 && d.registry.code.length == 0, "deployment address occupied");
        require(d.staking.code.length == 0 && d.index.code.length == 0, "deployment address occupied");
        require(d.seat.code.length == 0 && d.pnth.code.length == 0 && d.escrow.code.length == 0, "salt already used");
        if (vm.envOr("MAINNET_WRITE_DEPLOYMENT", false)) {
            string memory path = vm.envOr("MAINNET_DEPLOYMENT_FILE", string("deployments/elysium-mainnet.json"));
            require(vm.parseJsonUint(vm.readFile(path), ".network.chainId") == 99901, "wrong output manifest");
        }
    }

    function _record(Deployed memory d) internal virtual {
        console2.log("Passport:", d.passport);
        console2.log("Registry:", d.registry);
        console2.log("Staking:", d.staking);
        console2.log("IndexVault:", d.index);
        console2.log("PNTH:", d.pnth);
        console2.log("Seat:", d.seat);
        console2.log("Escrow:", d.escrow);
        console2.logBytes32(d.pool);
        if (!vm.envOr("MAINNET_WRITE_DEPLOYMENT", false)) return;
        string memory path = vm.envOr("MAINNET_DEPLOYMENT_FILE", string("deployments/elysium-mainnet.json"));
        string memory input = vm.readFile(path);
        require(vm.parseJsonUint(input, ".network.chainId") == 99901, "wrong output manifest");
        string memory k = "mainnet-seat";
        vm.serializeJson(k, input);
        vm.serializeAddress(k, "passportRegistry", d.passport);
        vm.serializeAddress(k, "constituentRegistry", d.registry);
        vm.serializeAddress(k, "staking", d.staking);
        vm.serializeAddress(k, "indexVault", d.index);
        vm.serializeAddress(k, "pnth", d.pnth);
        vm.serializeBytes32(k, "pnthPool", d.pool);
        vm.serializeAddress(k, "creatorSeat", d.seat);
        string memory json = vm.serializeAddress(k, "creatorEscrow", d.escrow);
        vm.writeJson(json, path);
    }
}
