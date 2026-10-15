// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {LaunchpadKey} from "ascend/libraries/LaunchpadKey.sol";
import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {Swapper} from "../test/fork/AscendPoC.t.sol";
import {CovenantFactory} from "../src/covenant/CovenantFactory.sol";
import {CovenantRouter} from "../src/covenant/CovenantRouter.sol";
import {ConstituentRegistry} from "../src/index/ConstituentRegistry.sol";
import {IndexVault} from "../src/index/IndexVault.sol";
import {PantheonStaking} from "../src/staking/PantheonStaking.sol";
import {TestDrip} from "../src/testnet/TestDrip.sol";

interface IMintable {
    function mint(address to, uint256 value) external;
}

/// Hands-on actions on the LIVE Elysium testnet deployment, signed by the deployer key from the
/// DEPLOYER_KEY environment variable. Each is its own run, so a person decides when it happens:
///   fundRelayer(to, wei)      gas money for the Passport relayer
///   propose(file)             the curator proposes a basket from a Trials round file (24 h before it can start)
///   execute(id)               starts a proposed basket once its 24 h are up
///   buyAndStake(usdc, bps)    buys PNTH with Ascend's test USDC (public mint) and stakes part of it
///   sell(amount)              sells PNTH; Covenant burns PNTH's share of the fee
///   settle(file)              a 1 USDC trade on each basket coin, so its price average is fresh
///   launchDemo(name, symbol)  a coin launched on Covenant, like the site's launch screen does
///   deployDrip(per, fund)     free PNTH, once per wallet, for when the pool is sold out
///   keep(k)                   what the keeper bot does: route PNTH's fees, then buy the basket
contract Testnet is Script {
    IAscendLaunchpad constant LP = IAscendLaunchpad(0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9);
    string constant DEPLOYMENT = "deployments/elysium-testnet.json";
    string constant TOOLS = "deployments/elysium-testnet-tools.json";

    function fundRelayer(address to, uint256 amount) external {
        _start();
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "transfer failed");
        vm.stopBroadcast();
    }

    function propose(string calldata file) external {
        string memory json = vm.readFile(file);
        address[] memory tokens = vm.parseJsonAddressArray(json, ".tokens");
        bytes32[] memory pools = vm.parseJsonBytes32Array(json, ".pools");
        uint256[] memory weights = vm.parseJsonUintArray(json, ".weightsBps");
        uint256[] memory caps = vm.parseJsonUintArray(json, ".perRunCaps");
        ConstituentRegistry.Constituent[] memory list = new ConstituentRegistry.Constituent[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            list[i] = ConstituentRegistry.Constituent(PoolId.wrap(pools[i]), tokens[i], uint16(weights[i]), uint128(caps[i]));
        }
        // The score root commits to the whole round file: anyone can hash it and compare.
        bytes32 root = keccak256(bytes(json));
        _start();
        uint256 id = ConstituentRegistry(_addr(".constituentRegistry")).propose(list, root, "https://pantheonindex.com/trials");
        vm.stopBroadcast();
        console2.log("proposal id:", id);
        console2.logBytes32(root);
    }

    function execute(uint256 id) external {
        _start();
        ConstituentRegistry(_addr(".constituentRegistry")).execute(id);
        vm.stopBroadcast();
    }

    function buyAndStake(uint256 usdcIn, uint256 stakeBps) external {
        address me = _start();
        Swapper sw = _swapper();
        address usdc = LP.baseQuote();
        address pnth = _addr(".pnth");
        IMintable(usdc).mint(me, usdcIn);
        ERC20(usdc).approve(address(sw), usdcIn);
        uint256 got = sw.swapExactIn(_key(pnth, usdc), usdc < pnth, usdcIn);
        uint256 toStake = got * stakeBps / 10_000;
        PantheonStaking staking = PantheonStaking(_addr(".staking"));
        ERC20(pnth).approve(address(staking), toStake);
        staking.stake(toStake);
        vm.stopBroadcast();
        console2.log("PNTH bought:", got / 1e18);
        console2.log("PNTH staked:", toStake / 1e18);
    }

    function sell(uint256 amount) external {
        _start();
        Swapper sw = _swapper();
        address usdc = LP.baseQuote();
        address pnth = _addr(".pnth");
        ERC20(pnth).approve(address(sw), amount);
        uint256 got = sw.swapExactIn(_key(pnth, usdc), pnth < usdc, amount);
        vm.stopBroadcast();
        console2.log("USDC received (6 dp):", got);
    }

    function settle(string calldata file) external {
        address[] memory tokens = vm.parseJsonAddressArray(vm.readFile(file), ".tokens");
        address me = _start();
        Swapper sw = _swapper();
        address usdc = LP.baseQuote();
        IMintable(usdc).mint(me, tokens.length * 1e6);
        ERC20(usdc).approve(address(sw), tokens.length * 1e6);
        for (uint256 i; i < tokens.length; ++i) {
            sw.swapExactIn(_key(tokens[i], usdc), usdc < tokens[i], 1e6);
        }
        vm.stopBroadcast();
    }

    /// A coin launched on Covenant the way the site's launch screen does it: sell fees half burned, half
    /// paid to the deployer; buy fees half paid to the deployer, half sent to the PANTHEON basket.
    function launchDemo(string calldata name, string calldata symbol) external {
        address me = _start();
        CovenantRouter.Leg[] memory sells = new CovenantRouter.Leg[](2);
        sells[0] = CovenantRouter.Leg(CovenantRouter.Job.BURN, 5_000, address(0));
        sells[1] = CovenantRouter.Leg(CovenantRouter.Job.PAY, 5_000, me);
        CovenantRouter.Leg[] memory buys = new CovenantRouter.Leg[](2);
        buys[0] = CovenantRouter.Leg(CovenantRouter.Job.PAY, 5_000, me);
        buys[1] = CovenantRouter.Leg(CovenantRouter.Job.INDEX, 5_000, _addr(".indexVault"));
        (address token,, address router) = CovenantFactory(_addr(".covenantFactory")).launch(
            name, symbol, LP.baseQuote(), keccak256(bytes(symbol)), sells, buys
        );
        vm.stopBroadcast();
        console2.log("coin:", token);
        console2.log("its Covenant:", router);
    }

    /// Testnet only: a drip that gives each wallet `perClaim` PNTH once, filled with `fund` PNTH from the
    /// deployer, for when PNTH's pool is sold out. Its address is saved with WRITE_TOOLS.
    function deployDrip(uint256 perClaim, uint256 fund) external {
        _start();
        ERC20 pnth = ERC20(_addr(".pnth"));
        TestDrip drip = new TestDrip(pnth, perClaim);
        require(pnth.transfer(address(drip), fund), "fund failed");
        vm.stopBroadcast();
        console2.log("drip:", address(drip));
        if (vm.envOr("WRITE_TOOLS", false)) {
            vm.serializeAddress("tools2", "swapper", vm.parseJsonAddress(vm.readFile(TOOLS), ".swapper"));
            vm.writeJson(vm.serializeAddress("tools2", "drip", address(drip)), TOOLS);
        }
    }

    function keep(uint256 k) external {
        _start();
        CovenantRouter(_addr(".pnthRouter")).run();
        IndexVault(_addr(".indexVault")).rebalance(k);
        vm.stopBroadcast();
    }

    // ------------------------------------------------------------------ helpers

    function _start() internal returns (address me) {
        require(block.chainid == 99801, "Elysium testnet only");
        uint256 pk = vm.envUint("DEPLOYER_KEY");
        me = vm.addr(pk);
        vm.startBroadcast(pk);
    }

    /// The swap helper from an earlier run, or a new one. Its address is saved only when WRITE_TOOLS is
    /// set (the broadcast run), so a dry run never records a helper that was not really deployed.
    function _swapper() internal returns (Swapper sw) {
        if (vm.exists(TOOLS)) return Swapper(vm.parseJsonAddress(vm.readFile(TOOLS), ".swapper"));
        sw = new Swapper(LP.vault(), LP.poolManager());
        if (vm.envOr("WRITE_TOOLS", false)) vm.writeJson(vm.serializeAddress("tools", "swapper", address(sw)), TOOLS);
    }

    function _addr(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(vm.readFile(DEPLOYMENT), key);
    }

    function _key(address token, address usdc) internal view returns (PoolKey memory) {
        return LaunchpadKey.keyOf(token, usdc, address(LP), address(LP.poolManager()));
    }
}
