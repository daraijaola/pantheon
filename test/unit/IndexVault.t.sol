// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {ConstituentRegistry} from "../../src/index/ConstituentRegistry.sol";
import {IndexVault, IStakingRewards} from "../../src/index/IndexVault.sol";

contract VaultToken is ERC20 {
    constructor(string memory s) ERC20(s, s, 18) {}

    function mint(address to, uint256 v) external {
        _mint(to, v);
    }
}

/// Just enough of the launchpad for the vault's constructor.
contract FakeLaunchpad {
    function vault() external pure returns (address) {
        return address(0x1111);
    }

    function poolManager() external pure returns (address) {
        return address(0x2222);
    }
}

/// An empty basket list with USDC as the quote.
contract FakeRegistry {
    address public baseQuote;

    constructor(address q) {
        baseQuote = q;
    }

    function active() external pure returns (ConstituentRegistry.Constituent[] memory none) {}
}

/// Staking that can be told to refuse.
contract FakeStaking is IStakingRewards {
    bool public refuse;
    mapping(address => uint256) public got;

    function setRefuse(bool r) external {
        refuse = r;
    }

    function notifyReward(address token, uint256 amount) external {
        require(!refuse, "refused");
        ERC20(token).transferFrom(msg.sender, address(this), amount);
        got[token] += amount;
    }
}

/// When staking refuses a stream, the basket keeps going: the coins wait in the vault and anyone
/// can flush them once staking accepts again. USDC is never flushed (it's the budget).
contract IndexVaultStreamTest is Test {
    VaultToken usdc = new VaultToken("USDC");
    VaultToken coin = new VaultToken("COIN");
    FakeStaking staking = new FakeStaking();
    IndexVault vault;

    function setUp() public {
        FakeRegistry registry = new FakeRegistry(address(usdc));
        vault = new IndexVault(
            IAscendLaunchpad(address(new FakeLaunchpad())), ConstituentRegistry(address(registry)), staking, 1 hours
        );
    }

    function test_aRefusedStreamDoesNotRevertTheRun() public {
        usdc.mint(address(vault), 500e18);
        staking.setRefuse(true);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IndexVault.StreamFailed(address(usdc), 500e18);
        vault.rebalance(0); // no basket yet: USDC itself streams, and staking refuses
        assertEq(usdc.balanceOf(address(vault)), 500e18, "the USDC waits for the next run");
        assertEq(usdc.allowance(address(vault), address(staking)), 0, "no approval left behind");

        staking.setRefuse(false);
        vault.rebalance(0);
        assertEq(staking.got(address(usdc)), 500e18);
    }

    function test_flushStreamsCoinsLeftInTheVault() public {
        coin.mint(address(vault), 42e18);
        staking.setRefuse(true);
        vault.flush(address(coin));
        assertEq(coin.balanceOf(address(vault)), 42e18);
        staking.setRefuse(false);
        vault.flush(address(coin));
        assertEq(coin.balanceOf(address(vault)), 0);
        assertEq(staking.got(address(coin)), 42e18);
    }

    function test_flushNeverTouchesTheBudget() public {
        usdc.mint(address(vault), 1e18);
        vm.expectRevert(IndexVault.QuoteIsBudget.selector);
        vault.flush(address(usdc));
    }
}
