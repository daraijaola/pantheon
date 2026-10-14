// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {LaunchpadKey} from "ascend/libraries/LaunchpadKey.sol";
import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {Swapper} from "../../test/fork/AscendPoC.t.sol";
import {CovenantRouter} from "../../src/covenant/CovenantRouter.sol";
import {ConstituentRegistry} from "../../src/index/ConstituentRegistry.sol";
import {IndexVault} from "../../src/index/IndexVault.sol";
import {PantheonStaking} from "../../src/staking/PantheonStaking.sol";

interface IMintable {
    function mint(address to, uint256 value) external;
}

/// DEV ONLY, for a local anvil fork of Elysium testnet: fills a fresh deployment with a realistic
/// state so the site's app screens have something real to show. Never run against a live chain.
/// Phases (time moves between them with `cast rpc evm_increaseTime`):
///   coins()    launch 5 basket coins and trade them          → then +3 days
///   activity() trade PNTH, run Covenant, propose the basket  → then +1 day
///   basket()   execute the list, settle prices, buy the basket, stake for the test wallet
/// Addresses come from deployments/local.json (written by Deploy.s.sol) and dev/coins.json.
contract Seed is Script {
    IAscendLaunchpad constant LP = IAscendLaunchpad(0xE2f6254508DEB93Da081837F545e0bAF7b00d8E9);
    uint256 constant N = 5;

    function coins() external {
        require(block.chainid == 99801 && _isLocal(), "dev seed: local anvil fork only");
        address usdc = LP.baseQuote();
        vm.startBroadcast();
        Swapper sw = new Swapper(LP.vault(), LP.poolManager());
        IMintable(usdc).mint(msg.sender, 10_000_000e6);
        ERC20(usdc).approve(address(sw), type(uint256).max);
        string memory names = "HELIOS,AETHER,NYX,KRONOS,ATLAS";
        string[] memory list = vm.split(names, ",");
        string memory k = "coins";
        string memory json;
        for (uint256 i; i < N; ++i) {
            (address token, PoolId id) = LP.launch(
                IAscendLaunchpad.LaunchParams({
                    name: list[i],
                    symbol: list[i],
                    quote: usdc,
                    devBuyQuote: 0,
                    minDevOut: 0,
                    salt: keccak256(abi.encode("seed", list[i])),
                    creator: msg.sender
                })
            );
            sw.swapExactIn(_key(token, usdc), usdc < token, (i + 2) * 1_000e6);
            vm.serializeAddress(k, string.concat("token", vm.toString(i)), token);
            json = vm.serializeBytes32(k, string.concat("pool", vm.toString(i)), PoolId.unwrap(id));
        }
        json = vm.serializeAddress(k, "swapper", address(sw));
        vm.stopBroadcast();
        vm.writeJson(json, "deployments/dev-coins.json");
    }

    function activity() external {
        require(_isLocal(), "dev seed: local anvil fork only");
        (address pnth, address router, address registry, address usdc) = _deployment();
        Swapper sw = Swapper(vm.parseJsonAddress(vm.readFile("deployments/dev-coins.json"), ".swapper"));
        vm.startBroadcast();
        // A few days of trading PNTH: buys and sells pay fees; Covenant burns and sends to the basket.
        uint256 got = sw.swapExactIn(_key(pnth, usdc), usdc < pnth, 40_000e6);
        ERC20(pnth).approve(address(sw), type(uint256).max);
        sw.swapExactIn(_key(pnth, usdc), pnth < usdc, got / 3);
        CovenantRouter(router).run();
        ConstituentRegistry(registry).propose(_list(), keccak256("dev scores"), "https://pantheonindex.com/trials");
        vm.stopBroadcast();
    }

    function settle() external {
        require(_isLocal(), "dev seed: local anvil fork only");
        (,,, address usdc) = _deployment();
        string memory c = vm.readFile("deployments/dev-coins.json");
        Swapper sw = Swapper(vm.parseJsonAddress(c, ".swapper"));
        vm.startBroadcast();
        for (uint256 i; i < N; ++i) {
            address token = vm.parseJsonAddress(c, string.concat(".token", vm.toString(i)));
            sw.swapExactIn(_key(token, usdc), usdc < token, 1e6);
        }
        vm.stopBroadcast();
    }

    function basket(address staker) external {
        require(_isLocal(), "dev seed: local anvil fork only");
        (address pnth,, address registry, address usdc) = _deployment();
        string memory d = vm.readFile("deployments/local.json");
        Swapper sw = Swapper(vm.parseJsonAddress(vm.readFile("deployments/dev-coins.json"), ".swapper"));
        vm.startBroadcast();
        ConstituentRegistry(registry).execute(0);
        IndexVault(vm.parseJsonAddress(d, ".indexVault")).rebalance(N);
        // Give the test wallet some PNTH and stake most of it.
        uint256 got = sw.swapExactIn(_key(pnth, usdc), usdc < pnth, 5_000e6);
        ERC20(pnth).transfer(staker, got);
        vm.stopBroadcast();
        console2.log("staker got PNTH:", got / 1e18);
    }

    // ------------------------------------------------------------------ helpers

    function _list() internal view returns (ConstituentRegistry.Constituent[] memory l) {
        string memory c = vm.readFile("deployments/dev-coins.json");
        l = new ConstituentRegistry.Constituent[](N);
        for (uint256 i; i < N; ++i) {
            l[i] = ConstituentRegistry.Constituent(
                PoolId.wrap(vm.parseJsonBytes32(c, string.concat(".pool", vm.toString(i)))),
                vm.parseJsonAddress(c, string.concat(".token", vm.toString(i))),
                2_000,
                1_000e6
            );
        }
    }

    function _deployment() internal view returns (address pnth, address router, address registry, address usdc) {
        string memory d = vm.readFile("deployments/local.json");
        pnth = vm.parseJsonAddress(d, ".pnth");
        router = vm.parseJsonAddress(d, ".pnthRouter");
        registry = vm.parseJsonAddress(d, ".constituentRegistry");
        usdc = vm.parseJsonAddress(d, ".usdc");
    }

    function _key(address token, address usdc) internal view returns (PoolKey memory) {
        return LaunchpadKey.keyOf(token, usdc, address(LP), address(LP.poolManager()));
    }

    /// Anvil answers `anvil_nodeInfo`; a live RPC does not.
    function _isLocal() internal returns (bool) {
        try vm.rpc("anvil_nodeInfo", "[]") returns (bytes memory) {
            return true;
        } catch {
            return false;
        }
    }
}
