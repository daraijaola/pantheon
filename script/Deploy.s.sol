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
/// Run: forge script script/Deploy.s.sol --rpc-url elysium --broadcast (with the deployer's key)
contract Deploy is Script {
    IAscendLaunchpad constant LP = IAscendLaunchpad(0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9);
    address constant BURN_SINK = 0xC889ac2f59A88afb3B2FB3f2C452DBa336fE5f0F;

    struct Config {
        address attestor;
        address curator;
        address guardian;
        uint128 maxRunCap;
        uint256 maxStale;
        string name;
        string symbol;
        bytes32 salt;
        address usdc;
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
        vm.startBroadcast();
        d = _deploy(c, msg.sender);
        vm.stopBroadcast();
        require(LP.poolCreator(d.pool) == d.router, "router does not hold the creator role");
        _record(c, d);
    }

    function _config() internal view returns (Config memory c) {
        c.attestor = vm.envAddress("ATTESTOR");
        c.curator = vm.envAddress("CURATOR");
        c.guardian = vm.envAddress("GUARDIAN");
        c.maxRunCap = uint128(vm.envOr("MAX_RUN_CAP", uint256(1_000e6)));
        c.maxStale = vm.envOr("MAX_STALE", uint256(2 days));
        c.name = vm.envOr("PNTH_NAME", string("PANTHEON"));
        c.symbol = vm.envOr("PNTH_SYMBOL", string("PNTH"));
        c.salt = keccak256(bytes(vm.envOr("PNTH_SALT", string("pantheon-v1"))));
        c.usdc = LP.baseQuote();
    }

    function _deploy(Config memory c, address deployer) internal returns (Deployed memory d) {
        d.passport = address(new HypePassportRegistry(c.attestor, c.guardian));
        CovenantFactory factory = new CovenantFactory(LP, BURN_SINK);
        d.factory = address(factory);

        // The launch, the registry and staking come next; the basket vault is the third deploy after it.
        address predictedIndex = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 3);
        (d.pnth, d.pool, d.router) =
            factory.launch(c.name, c.symbol, c.usdc, c.salt, _tokenLegs(), _quoteLegs(predictedIndex));

        d.registry = address(new ConstituentRegistry(LP, c.usdc, d.pnth, c.curator, c.guardian, c.maxRunCap));
        d.staking = address(new PantheonStaking(ERC20(d.pnth), IHypePassport(d.passport), IRewardList(d.registry)));
        d.index = address(new IndexVault(LP, ConstituentRegistry(d.registry), IStakingRewards(d.staking), c.maxStale));
        require(d.index == predictedIndex, "basket vault is not where PNTH's router sends USDC");
    }

    /// PNTH's jobs: every PNTH fee (from sells) is burned; every USDC fee (from buys) goes to the basket.
    function _tokenLegs() internal pure returns (CovenantRouter.Leg[] memory legs) {
        legs = new CovenantRouter.Leg[](1);
        legs[0] = CovenantRouter.Leg(CovenantRouter.Job.BURN, 10_000, address(0));
    }

    function _quoteLegs(address index) internal pure returns (CovenantRouter.Leg[] memory legs) {
        legs = new CovenantRouter.Leg[](1);
        legs[0] = CovenantRouter.Leg(CovenantRouter.Job.INDEX, 10_000, index);
    }

    function _record(Config memory c, Deployed memory d) internal {
        string memory k = "deploy";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "launchpad", address(LP));
        vm.serializeAddress(k, "usdc", c.usdc);
        vm.serializeAddress(k, "burnSink", BURN_SINK);
        vm.serializeAddress(k, "passportRegistry", d.passport);
        vm.serializeAddress(k, "covenantFactory", d.factory);
        vm.serializeAddress(k, "pnth", d.pnth);
        vm.serializeBytes32(k, "pnthPool", PoolId.unwrap(d.pool));
        vm.serializeAddress(k, "pnthRouter", d.router);
        vm.serializeAddress(k, "constituentRegistry", d.registry);
        vm.serializeAddress(k, "staking", d.staking);
        string memory json = vm.serializeAddress(k, "indexVault", d.index);
        console2.log(json);
        if (vm.envOr("WRITE_DEPLOYMENT", false)) {
            vm.writeJson(json, vm.envOr("DEPLOYMENT_FILE", string("deployments/elysium-testnet.json")));
        }
    }
}
