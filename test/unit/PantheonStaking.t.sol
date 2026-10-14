// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {PantheonStaking, IRewardList} from "../../src/staking/PantheonStaking.sol";
import {IHypePassport} from "../../src/passport/IHypePassport.sol";

contract Token is ERC20 {
    constructor(string memory s) ERC20(s, s, 18) {}

    function mint(address to, uint256 v) external {
        _mint(to, v);
    }
}

contract List is IRewardList {
    mapping(address => bool) public isConstituent;
    address public baseQuote;

    function set(address t, bool on) external {
        isConstituent[t] = on;
    }

    function setQuote(address q) external {
        baseQuote = q;
    }
}

contract Passport {
    mapping(address => uint256) public mult;

    function set(address a, uint256 m) external {
        mult[a] = m;
    }

    function multiplierOf(address a) external view returns (uint256) {
        return mult[a] == 0 ? 1e18 : mult[a];
    }
}

/// Staking maths: fair shares, both bonuses, the pause with no stakers, the 3-day unlock, the
/// reward whitelist, and (fuzzed) that it never pays out more than it was given.
contract PantheonStakingTest is Test {
    Token pnth = new Token("PNTH");
    Token coin = new Token("COIN");
    Token usdc = new Token("USDC");
    List list = new List();
    Passport passport = new Passport();
    PantheonStaking staking;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address basket = makeAddr("basket");

    function setUp() public {
        staking = new PantheonStaking(ERC20(address(pnth)), IHypePassport(address(passport)), IRewardList(address(list)));
        list.set(address(coin), true);
        list.setQuote(address(usdc));
        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? alice : bob;
            pnth.mint(who, 1_000_000e18);
            vm.prank(who);
            pnth.approve(address(staking), type(uint256).max);
        }
        coin.mint(basket, 1e30);
        usdc.mint(basket, 1e30);
        vm.startPrank(basket);
        coin.approve(address(staking), type(uint256).max);
        usdc.approve(address(staking), type(uint256).max);
        vm.stopPrank();
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        staking.stake(amount);
    }

    function _notify(uint256 amount) internal {
        vm.prank(basket);
        staking.notifyReward(address(coin), amount);
    }

    function _claim(address who) internal returns (uint256) {
        uint256 before = coin.balanceOf(who);
        vm.prank(who);
        staking.claim();
        return coin.balanceOf(who) - before;
    }

    function test_twoStakersSplitByStake() public {
        _stake(alice, 100e18);
        _stake(bob, 300e18);
        _notify(1_000e18);
        vm.warp(block.timestamp + 1 days);
        assertApproxEqAbs(_claim(alice), 250e18, 1e6);
        assertApproxEqAbs(_claim(bob), 750e18, 1e6);
    }

    function test_streamWaitsForStakers() public {
        _notify(1_000e18);
        vm.warp(block.timestamp + 12 hours); // nobody staking: the stream pauses
        _stake(alice, 100e18);
        vm.warp(block.timestamp + 1 days);
        assertApproxEqAbs(_claim(alice), 1_000e18, 1e6); // the whole stream, not half of it
    }

    function test_passportBoost() public {
        passport.set(bob, 1.25e18);
        _stake(alice, 100e18);
        _stake(bob, 100e18);
        _notify(900e18);
        vm.warp(block.timestamp + 1 days);
        assertApproxEqAbs(_claim(alice), 400e18, 1e6); // 1.00 / 2.25
        assertApproxEqAbs(_claim(bob), 500e18, 1e6); // 1.25 / 2.25
    }

    function test_passportCappedAt125() public {
        passport.set(bob, 9e18); // a broken registry can't give more than 1.25×
        _stake(bob, 100e18);
        assertEq(staking.workingOf(bob), 125e18);
    }

    function test_timeBonusRisesTo150AfterAPoke() public {
        _stake(alice, 100e18);
        assertEq(staking.workingOf(alice), 100e18);
        vm.warp(block.timestamp + 15 days);
        assertEq(staking.workingOf(alice), 125e18);
        vm.warp(block.timestamp + 30 days);
        assertEq(staking.workingOf(alice), 150e18); // capped at 1.5×
        address[] memory who = new address[](1);
        who[0] = alice;
        staking.poke(who);
        (,, uint256 working,,) = staking.accounts(alice);
        assertEq(working, 150e18);
    }

    function test_unlockStopsEarningAndTakesThreeDays() public {
        _stake(alice, 100e18);
        _stake(bob, 100e18);
        vm.prank(alice);
        staking.requestUnstake(100e18);
        _notify(1_000e18);
        vm.warp(block.timestamp + 1 days);
        assertEq(_claim(alice), 0, "unlocking amount earns nothing");
        assertApproxEqAbs(_claim(bob), 1_000e18, 1e6);

        vm.prank(alice);
        vm.expectRevert();
        staking.withdraw(); // a day in: still unlocking
        vm.warp(block.timestamp + 2 days);
        vm.prank(alice);
        staking.withdraw();
        assertEq(pnth.balanceOf(alice), 1_000_000e18);
    }

    function test_cancelUnstakeEarnsAgain() public {
        _stake(alice, 100e18);
        vm.startPrank(alice);
        staking.requestUnstake(40e18);
        staking.cancelUnstake();
        vm.stopPrank();
        (uint256 staked, uint256 cooling,,,) = staking.accounts(alice);
        assertEq(staked, 100e18);
        assertEq(cooling, 0);
    }

    function test_onlyBasketCoinsAndUsdc() public {
        Token junk = new Token("JUNK");
        junk.mint(address(this), 1e18);
        junk.approve(address(staking), 1e18);
        vm.expectRevert(PantheonStaking.NotARewardToken.selector);
        staking.notifyReward(address(junk), 1e18);

        pnth.mint(address(this), 1e18);
        pnth.approve(address(staking), 1e18);
        list.set(address(pnth), true); // even if a list ever named it, PNTH is never a reward
        vm.expectRevert(PantheonStaking.NotARewardToken.selector);
        staking.notifyReward(address(pnth), 1e18);

        vm.prank(basket);
        staking.notifyReward(address(usdc), 1e18); // the no-basket fallback
    }

    function test_topUpKeepsTheStreamRunning() public {
        _stake(alice, 100e18);
        _notify(500e18);
        vm.warp(block.timestamp + 12 hours);
        _notify(500e18);
        vm.warp(block.timestamp + 1 days);
        assertApproxEqAbs(_claim(alice), 1_000e18, 1e6);
    }

    /// Whatever the order of stakes, unstakes, rewards and time, stakers are never paid more than
    /// the stream received, and what's left in the contract covers what is still owed.
    function testFuzz_neverPaysMoreThanItReceived(uint96 a, uint96 b, uint96 r1, uint96 r2, uint32 t1, uint32 t2, bool bobLeaves)
        public
    {
        uint256 sa = bound(a, 1e15, 1_000_000e18);
        uint256 sb = bound(b, 1e15, 1_000_000e18);
        uint256 n1 = bound(r1, 1e6, 1e27);
        uint256 n2 = bound(r2, 1e6, 1e27);
        _stake(alice, sa);
        _notify(n1);
        vm.warp(block.timestamp + bound(t1, 0, 3 days));
        _stake(bob, sb);
        _notify(n2);
        if (bobLeaves) {
            vm.prank(bob);
            staking.requestUnstake(sb);
        }
        vm.warp(block.timestamp + bound(t2, 0, 5 days));
        uint256 paid = _claim(alice) + _claim(bob);
        assertLe(paid, n1 + n2, "paid more than received");
        vm.warp(block.timestamp + 10 days);
        paid += _claim(alice) + _claim(bob);
        assertLe(paid, n1 + n2, "paid more than received");
        // After every stream has ended, almost nothing is left behind (rounding dust only).
        assertApproxEqAbs(paid, n1 + n2, 1e12);
    }
}
