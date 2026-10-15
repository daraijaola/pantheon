// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {TestDrip} from "../../src/testnet/TestDrip.sol";

contract Coin is ERC20 {
    constructor() ERC20("PNTH", "PNTH", 18) {}

    function mint(address to, uint256 v) external {
        _mint(to, v);
    }
}

/// The testnet drip: one claim per wallet, nothing left to anyone once it runs dry.
contract TestDripTest is Test {
    Coin coin = new Coin();
    TestDrip drip = new TestDrip(ERC20(address(coin)), 10_000e18);

    function test_eachWalletClaimsOnce() public {
        coin.mint(address(drip), 25_000e18);
        address a = makeAddr("a");
        vm.prank(a);
        drip.claim();
        assertEq(coin.balanceOf(a), 10_000e18);
        vm.prank(a);
        vm.expectRevert(TestDrip.AlreadyClaimed.selector);
        drip.claim();
    }

    function test_stopsWhenEmpty() public {
        coin.mint(address(drip), 15_000e18);
        vm.prank(makeAddr("a"));
        drip.claim();
        vm.prank(makeAddr("b"));
        vm.expectRevert(TestDrip.Empty.selector);
        drip.claim(); // 5,000 left: less than one claim
    }
}
