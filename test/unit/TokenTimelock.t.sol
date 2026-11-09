// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {TokenTimelock} from "../../src/common/TokenTimelock.sol";

contract LockToken is ERC20 {
    constructor() ERC20("PANTHEON", "PNTH", 18) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TokenTimelockTest is Test {
    LockToken token = new LockToken();
    address beneficiary = makeAddr("beneficiary");
    uint64 releaseTime;
    TokenTimelock lock;

    function setUp() public {
        releaseTime = uint64(block.timestamp + 365 days);
        lock = new TokenTimelock(token, beneficiary, releaseTime);
        token.mint(address(lock), 166_420_366e18);
    }

    function testImmutables() public view {
        assertEq(address(lock.token()), address(token));
        assertEq(lock.beneficiary(), beneficiary);
        assertEq(lock.releaseTime(), releaseTime);
    }

    function testCannotReleaseEarly() public {
        vm.expectRevert(TokenTimelock.StillLocked.selector);
        lock.release();
    }

    function testAnyoneCanReleaseToBeneficiaryAfterOneYear() public {
        vm.warp(releaseTime);
        vm.prank(makeAddr("caller"));
        lock.release();

        assertEq(token.balanceOf(beneficiary), 166_420_366e18);
        assertEq(token.balanceOf(address(lock)), 0);
    }

    function testCannotDeployUnlocked() public {
        vm.expectRevert(TokenTimelock.InvalidReleaseTime.selector);
        new TokenTimelock(token, beneficiary, uint64(block.timestamp));
    }

    function testCannotChangeDestinationOrReleaseDate() public {
        (bool beneficiaryChanged,) =
            address(lock).call(abi.encodeWithSignature("setBeneficiary(address)", makeAddr("attacker")));
        (bool releaseChanged,) = address(lock).call(abi.encodeWithSignature("setReleaseTime(uint64)", block.timestamp));

        assertFalse(beneficiaryChanged);
        assertFalse(releaseChanged);
        assertEq(lock.beneficiary(), beneficiary);
        assertEq(lock.releaseTime(), releaseTime);
    }
}
