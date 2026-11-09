// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {HypePassportRegistry} from "../src/passport/HypePassportRegistry.sol";
import {IHypePassport} from "../src/passport/IHypePassport.sol";
import {CovenantFactory} from "../src/covenant/CovenantFactory.sol";
import {CovenantRouter} from "../src/covenant/CovenantRouter.sol";
import {ConstituentRegistry} from "../src/index/ConstituentRegistry.sol";
import {IndexVault, IStakingRewards} from "../src/index/IndexVault.sol";
import {PantheonStaking, IRewardList} from "../src/staking/PantheonStaking.sol";

/// Deploys PANTHEON on Elysium and launches PNTH through Covenant, in this order (each a transaction):
///   1 HYPE Passport registry · 2 Covenant factory · 3 launch PNTH (its router takes the creator role)
///   4 constituent registry · 5 staking · 6 basket vault (at the address PNTH's router already names)
///
/// Settings come from the environment:
///   ATTESTOR   the Passport service's signing address (Ayinde's attestor key, public address only)
///   CURATOR    who may propose basket lists        GUARDIAN  who may veto them (offered to Ascend)
///   MAX_RUN_CAP  most USDC per coin per basket run (6 decimals)   MAX_STALE  oldest usable price average (s)
///   PNTH_NAME / PNTH_SYMBOL / PNTH_SALT
///   TEAM / TEAM_BPS  the team's wallet and its fixed share of PNTH's fees on both sides (1500 = 15%;
///                    unset = 0%). Set at launch: Covenant can never change it.
/// Simulate with forge script script/Deploy.s.sol:Deploy and FOUNDRY_ETH_RPC_URL set to the selected RPC.
contract Deploy is Script {
    struct Config {
        IAscendLaunchpad launchpad;
        address burnSink;
        string deploymentFile;
        address attestor;
        address curator;
        address guardian;
        uint128 maxRunCap;
        uint256 maxStale;
        string name;
        string symbol;
        bytes32 salt;
        address usdc;
        address team;
        uint16 teamBps;
    }

    struct Deployed {
        address passport;
        address factory;
        address pnth;
        PoolId pool;
        address router;
        address registry;
        address staking;
        address index;
    }

    function run() external returns (Deployed memory d) {
        Config memory c = _config();
        // The deployer's key comes from the DEPLOYER_KEY environment variable (filled from its key file
        // at launch, so it never sits on a command line), or from forge's own wallet flags.
        uint256 pk = vm.envOr("DEPLOYER_KEY", uint256(0));
        address deployer;
        if (pk != 0) {
            deployer = vm.addr(pk);
        } else {
            deployer = msg.sender;
        }
        _validateDeployer(deployer);
        if (block.chainid == 99901) {
            require(vm.getNonce(deployer) == vm.envUint("EXPECTED_NONCE"), "unexpected deployer nonce");
        }
        // Validation and dependency reads must finish before recording any transaction.
        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();
        d = _deploy(c, deployer);
        vm.stopBroadcast();
        require(c.launchpad.poolCreator(d.pool) == d.router, "router does not hold the creator role");
        _record(c, d);
    }

    function _config() internal view returns (Config memory c) {
        require(block.chainid == 99801 || block.chainid == 99901, "unsupported deployment chain");
        c.deploymentFile = vm.envOr(
            "DEPLOYMENT_FILE",
            block.chainid == 99901
                ? string("deployments/elysium-mainnet.json")
                : string("deployments/elysium-testnet.json")
        );
        string memory manifest = vm.readFile(c.deploymentFile);
        require(vm.parseJsonUint(manifest, ".chainId") == block.chainid, "deployment chainId mismatch");
        require(vm.parseJsonUint(manifest, ".network.chainId") == block.chainid, "network chainId mismatch");
        c.launchpad = IAscendLaunchpad(_inputAddress("LAUNCHPAD", manifest, ".launchpad"));
        c.burnSink = _inputAddress("BURN_SINK", manifest, ".burnSink");
        c.usdc = _inputAddress("USDC", manifest, ".usdc");
        require(address(c.launchpad) != address(0), "missing LAUNCHPAD / manifest.launchpad");
        require(c.burnSink != address(0), "missing BURN_SINK / manifest.burnSink");
        require(c.usdc != address(0), "missing USDC / manifest.usdc");
        require(address(c.launchpad).code.length > 0, "LAUNCHPAD has no code");
        require(c.usdc.code.length > 0, "USDC has no code");
        require(c.burnSink.code.length > 0, "BURN_SINK has no code");
        require(c.launchpad.baseQuote() == c.usdc, "USDC differs from launchpad baseQuote");
        require(address(c.launchpad.poolManager()).code.length > 0, "poolManager has no code");
        require(address(c.launchpad.vault()).code.length > 0, "Ascend vault has no code");
        c.attestor = vm.envAddress("ATTESTOR");
        c.curator = vm.envAddress("CURATOR");
        c.guardian = vm.envAddress("GUARDIAN");
        uint256 maxRunCap = vm.envOr("MAX_RUN_CAP", uint256(1_000e6));
        require(maxRunCap <= type(uint128).max, "MAX_RUN_CAP overflow");
        c.maxRunCap = uint128(maxRunCap);
        c.maxStale = vm.envOr("MAX_STALE", uint256(2 days));
        c.name = vm.envOr("PNTH_NAME", string("PANTHEON"));
        c.symbol = vm.envOr("PNTH_SYMBOL", string("PNTH"));
        c.salt = keccak256(bytes(vm.envOr("PNTH_SALT", string("pantheon-v1"))));
        c.team = vm.envOr("TEAM", address(0));
        uint256 teamBps = vm.envOr("TEAM_BPS", uint256(0));
        require(teamBps <= 2_000, "team share above 20%");
        c.teamBps = uint16(teamBps);
        require(c.teamBps == 0 || c.team != address(0), "TEAM_BPS needs a TEAM wallet");
        require(c.attestor != address(0) && c.curator != address(0) && c.guardian != address(0), "zero role address");
        require(c.maxRunCap > 0 && c.maxStale > 0, "zero cap or staleness");
        if (block.chainid == 99901) {
            require(teamBps == 1500, "mainnet requires TEAM_BPS=1500");
            require(c.team != address(0), "mainnet requires TEAM");
        }
    }

    function _inputAddress(string memory name, string memory manifest, string memory key)
        internal
        view
        returns (address)
    {
        address value = vm.envOr(name, address(0));
        if (value != address(0)) return value;
        try vm.parseJsonAddress(manifest, key) returns (address parsed) {
            return parsed;
        } catch {
            return address(0);
        }
    }

    function _validateDeployer(address deployer) internal view {
        if (block.chainid == 99901) {
            address expected = vm.envAddress("DEPLOYER_ADDRESS");
            require(expected != address(0) && deployer == expected, "deployer does not match DEPLOYER_ADDRESS");
        }
    }

    function preflight() external view {
        require(block.chainid == 99901, "preflight requires chainId 99901");
        Config memory c = _config();
        uint256 pk = vm.envUint("DEPLOYER_KEY");
        require(pk != 0, "missing deployer key");
        address deployer = vm.addr(pk);
        _validateDeployer(deployer);
        uint256 nonce = vm.getNonce(deployer);
        uint256 expectedNonce = vm.envUint("EXPECTED_NONCE");
        console2.log("RPC chainId:", block.chainid);
        console2.log("Deployer (key verified):", deployer);
        console2.log("Nonce:", nonce);
        if (nonce != expectedNonce) {
            console2.log("WARNING: nonce differs from EXPECTED_NONCE; prediction uses current nonce");
        }
        console2.log("Balance (wei):", deployer.balance);
        uint256 minimum = vm.envUint("MIN_DEPLOYER_BALANCE_WEI");
        require(minimum > 0 && deployer.balance >= minimum, "insufficient deployer balance");
        console2.log("Launchpad:", address(c.launchpad));
        console2.log("USDC:", c.usdc);
        console2.log("Burn sink:", c.burnSink);
        console2.log("TEAM_BPS:", c.teamBps);
        console2.log("TEAM:", c.team);
        console2.log("CURATOR:", c.curator);
        console2.log("GUARDIAN:", c.guardian);
        console2.log("ATTESTOR:", c.attestor);
        console2.log("MAX_RUN_CAP:", c.maxRunCap);
        console2.log("MAX_STALE:", c.maxStale);
        console2.log("Deploy: Passport, CovenantFactory, PNTH launch/router, registry, staking, IndexVault");
        console2.log("Predicted IndexVault:", vm.computeCreateAddress(deployer, nonce + 5));
    }

    function _deploy(Config memory c, address deployer) internal returns (Deployed memory d) {
        d.passport = address(new HypePassportRegistry(c.attestor, c.guardian));
        CovenantFactory factory = new CovenantFactory(c.launchpad, c.burnSink);
        d.factory = address(factory);

        // The launch, the registry and staking come next; the basket vault is the third deploy after it.
        address predictedIndex = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 3);
        (d.pnth, d.pool, d.router) =
            factory.launch(c.name, c.symbol, c.usdc, c.salt, _tokenLegs(c), _quoteLegs(c, predictedIndex));

        d.registry = address(new ConstituentRegistry(c.launchpad, c.usdc, d.pnth, c.curator, c.guardian, c.maxRunCap));
        d.staking = address(new PantheonStaking(ERC20(d.pnth), IHypePassport(d.passport), IRewardList(d.registry)));
        d.index = address(
            new IndexVault(c.launchpad, ConstituentRegistry(d.registry), IStakingRewards(d.staking), c.maxStale)
        );
        require(d.index == predictedIndex, "basket vault is not where PNTH's router sends USDC");
        _logJobs(d.router);
    }

    /// PNTH's jobs: PNTH fees (from sells) are burned and USDC fees (from buys) go to the basket, less the
    /// team's fixed share of each when TEAM_BPS is set.
    function _tokenLegs(Config memory c) internal pure returns (CovenantRouter.Leg[] memory legs) {
        return _withTeam(CovenantRouter.Leg(CovenantRouter.Job.BURN, 10_000, address(0)), c);
    }

    function _quoteLegs(Config memory c, address index) internal pure returns (CovenantRouter.Leg[] memory legs) {
        return _withTeam(CovenantRouter.Leg(CovenantRouter.Job.INDEX, 10_000, index), c);
    }

    function _withTeam(CovenantRouter.Leg memory main, Config memory c)
        internal
        pure
        returns (CovenantRouter.Leg[] memory legs)
    {
        if (c.teamBps == 0) {
            legs = new CovenantRouter.Leg[](1);
            legs[0] = main;
            return legs;
        }
        legs = new CovenantRouter.Leg[](2);
        main.bps = 10_000 - c.teamBps;
        legs[0] = main;
        legs[1] = CovenantRouter.Leg(CovenantRouter.Job.PAY, c.teamBps, c.team);
    }

    /// PNTH's jobs as its router stored them (side 0: PNTH fees, side 1: USDC fees), for the log.
    function _logJobs(address router) internal view {
        for (uint8 side; side < 2; ++side) {
            CovenantRouter.Leg[] memory legs = CovenantRouter(router).legs(side);
            for (uint256 i; i < legs.length; ++i) {
                console2.log(
                    side == 0 ? "PNTH fees, job / bps:" : "USDC fees, job / bps:", uint8(legs[i].job), legs[i].bps
                );
                console2.log("  to:", legs[i].target);
            }
        }
    }

    function _record(Config memory c, Deployed memory d) internal {
        string memory k = "deploy";
        vm.serializeJson(k, vm.readFile(c.deploymentFile));
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "launchpad", address(c.launchpad));
        vm.serializeAddress(k, "usdc", c.usdc);
        vm.serializeAddress(k, "burnSink", c.burnSink);
        vm.serializeAddress(k, "passportRegistry", d.passport);
        vm.serializeAddress(k, "covenantFactory", d.factory);
        vm.serializeAddress(k, "pnth", d.pnth);
        vm.serializeBytes32(k, "pnthPool", PoolId.unwrap(d.pool));
        vm.serializeAddress(k, "pnthRouter", d.router);
        vm.serializeAddress(k, "constituentRegistry", d.registry);
        vm.serializeAddress(k, "staking", d.staking);
        if (c.teamBps > 0) {
            vm.serializeAddress(k, "team", c.team);
            vm.serializeUint(k, "teamBps", c.teamBps);
        }
        string memory json = vm.serializeAddress(k, "indexVault", d.index);
        console2.log("Passport:", d.passport);
        console2.log("CovenantFactory:", d.factory);
        console2.log("PNTH:", d.pnth);
        console2.log("PNTH router:", d.router);
        console2.log("ConstituentRegistry:", d.registry);
        console2.log("Staking:", d.staking);
        console2.log("IndexVault:", d.index);
        if (vm.envOr("WRITE_DEPLOYMENT", false)) {
            vm.writeJson(json, c.deploymentFile);
        }
    }
}
