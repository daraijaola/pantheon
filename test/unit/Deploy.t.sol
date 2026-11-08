// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {LaunchpadKey} from "ascend/libraries/LaunchpadKey.sol";
import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

contract DeployDependencyMock {}

contract DeployTokenMock is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s, 18) {}
}

contract DeployLaunchpadMock {
    using PoolIdLibrary for *;
    mapping(PoolId => address) public poolCreator;
    mapping(PoolId => address) public pending;

    function baseQuote() external pure returns (address) {
        return address(0x1001);
    }

    function poolManager() external pure returns (ICLPoolManager) {
        return ICLPoolManager(address(0x1003));
    }

    function vault() external pure returns (IVault) {
        return IVault(address(0x1004));
    }

    function launch(IAscendLaunchpad.LaunchParams calldata p) external returns (address token, PoolId id) {
        token = address(new DeployTokenMock(p.name, p.symbol));
        id = LaunchpadKey.keyOf(token, p.quote, address(this), address(0x1003)).toId();
        poolCreator[id] = p.creator;
    }

    function transferCreator(PoolId id, address next) external {
        require(msg.sender == poolCreator[id]);
        pending[id] = next;
    }

    function acceptCreator(PoolId id) external {
        require(msg.sender == pending[id]);
        poolCreator[id] = msg.sender;
    }
}

contract DeployConfigHarness is Deploy {
    function config() external view returns (Config memory) {
        return _config();
    }
}

contract DeployConfigTest is Test {
    DeployConfigHarness harness;

    function setUp() public {
        vm.chainId(99901);
        harness = new DeployConfigHarness();
        vm.etch(address(0x1001), address(new DeployDependencyMock()).code);
        vm.etch(address(0x1002), address(new DeployLaunchpadMock()).code);
        vm.etch(address(0x1003), address(new DeployDependencyMock()).code);
        vm.etch(address(0x1004), address(new DeployDependencyMock()).code);
        vm.etch(address(0x1005), address(new DeployDependencyMock()).code);
        vm.setEnv("DEPLOYMENT_FILE", "deployments/elysium-mainnet.json");
        vm.setEnv("LAUNCHPAD", vm.toString(address(0x1002)));
        vm.setEnv("USDC", vm.toString(address(0x1001)));
        vm.setEnv("BURN_SINK", vm.toString(address(0x1005)));
        vm.setEnv("TEAM_BPS", "1500");
        for (uint256 i; i < 4; i++) {
            string[4] memory names = [string("TEAM"), "CURATOR", "GUARDIAN", "ATTESTOR"];
            vm.setEnv(names[i], vm.toString(address(0x1234)));
        }
    }

    function test_mainnetConfigAndGuards() public {
        _mainnetConfig();
        _missingDependency();
        setUp();
        _wrongTeamShare();
        setUp();
        _noTeamShareTruncation();
        setUp();
        _zeroRole();
        setUp();
        _wrongQuote();
    }

    function _mainnetConfig() internal view {
        Deploy.Config memory c = harness.config();
        assertEq(c.teamBps, 1500);
        assertEq(address(c.launchpad), address(0x1002));
    }

    function _missingDependency() internal {
        vm.setEnv("LAUNCHPAD", vm.toString(address(0)));
        vm.expectRevert("missing LAUNCHPAD / manifest.launchpad");
        harness.config();
    }

    function _wrongTeamShare() internal {
        vm.setEnv("TEAM_BPS", "0");
        vm.expectRevert("mainnet requires TEAM_BPS=1500");
        harness.config();
    }

    function _noTeamShareTruncation() internal {
        vm.setEnv("TEAM_BPS", "67036");
        vm.expectRevert("team share above 20%");
        harness.config();
    }

    function _zeroRole() internal {
        vm.setEnv("GUARDIAN", vm.toString(address(0)));
        vm.expectRevert("zero role address");
        harness.config();
    }

    function _wrongQuote() internal {
        vm.setEnv("USDC", vm.toString(address(0x1003)));
        vm.expectRevert("USDC differs from launchpad baseQuote");
        harness.config();
    }
}
