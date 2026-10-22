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
        staking =
            new PantheonStaking(ERC20(address(pnth)), IHypePassport(address(passport)), IRewardList(address(list)));
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
    function testFuzz_neverPaysMoreThanItReceived(
        uint96 a,
        uint96 b,
        uint96 r1,
        uint96 r2,
        uint32 t1,
        uint32 t2,
        bool bobLeaves
    ) public {
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

/// The basket rotates: coins join, stream, leave. Streams of coins that left are retired so the live
/// slots never run out, and every staker still gets exactly their share of every retired stream.
contract PantheonStakingRotationTest is Test {
    Token pnth = new Token("PNTH");
    Token usdc = new Token("USDC");
    List list = new List();
    PantheonStaking staking;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address basket = makeAddr("basket");

    function setUp() public {
        staking = new PantheonStaking(ERC20(address(pnth)), IHypePassport(address(0)), IRewardList(address(list)));
        list.setQuote(address(usdc));
        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? alice : bob;
            pnth.mint(who, 1_000_000e18);
            vm.prank(who);
            pnth.approve(address(staking), type(uint256).max);
        }
        usdc.mint(basket, 1e30);
        vm.prank(basket);
        usdc.approve(address(staking), type(uint256).max);
    }

    function _coin(string memory name) internal returns (Token t) {
        t = new Token(name);
        t.mint(basket, 1e30);
        vm.prank(basket);
        t.approve(address(staking), type(uint256).max);
        list.set(address(t), true);
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        staking.stake(amount);
    }

    function _notify(Token t, uint256 amount) internal {
        vm.prank(basket);
        staking.notifyReward(address(t), amount);
    }

    function _claimed(address who, Token t) internal returns (uint256) {
        uint256 before = t.balanceOf(who);
        vm.prank(who);
        staking.claim();
        return t.balanceOf(who) - before;
    }

    function _liveCount() internal view returns (uint256) {
        return staking.rewardTokens().length;
    }

    /// The bug this design fixes: with a fixed list of 24 reward tokens, the 25th coin the basket
    /// ever bought made every later buy revert. Now 60 coins rotate through and nothing reverts.
    function test_basketRotatesThroughSixtyCoins() public {
        _stake(alice, 100e18);
        Token[] memory coins = new Token[](60);
        for (uint256 i; i < 60; ++i) {
            coins[i] = _coin(string.concat("C", vm.toString(i)));
            _notify(coins[i], 1_000e18);
            vm.warp(block.timestamp + 1 days + 1);
            list.set(address(coins[i]), false); // it leaves the basket
            assertLe(_liveCount(), staking.MAX_REWARDS());
        }
        // The only staker gets every coin in full, retired or not.
        vm.prank(alice);
        staking.claim();
        for (uint256 i; i < 60; ++i) {
            assertApproxEqAbs(coins[i].balanceOf(alice), 1_000e18, 1e6, "every coin paid in full");
            assertEq(coins[i].balanceOf(address(staking)) <= 1e6, true, "only dust left");
        }
    }

    /// A staker who adds to their stake after a stream was retired is paid at the balance they held
    /// while it ran, not the new one.
    function test_retiredStreamPaysAtTheBalanceHeldWhileItRan() public {
        Token a = _coin("A");
        _stake(alice, 100e18);
        _stake(bob, 100e18);
        _notify(a, 1_000e18);
        vm.warp(block.timestamp + 1 days + 1);
        list.set(address(a), false);
        staking.retire(address(a));
        assertEq(_liveCount(), 0);

        _stake(alice, 900e18); // alice's balance grows ninefold after the stream ended
        assertApproxEqAbs(staking.earned(address(a), alice), 500e18, 1e6);
        assertApproxEqAbs(staking.earned(address(a), bob), 500e18, 1e6);
        assertApproxEqAbs(_claimed(alice, a), 500e18, 1e6);
        assertApproxEqAbs(_claimed(bob, a), 500e18, 1e6);
        assertEq(_claimed(alice, a), 0, "never paid twice");
    }

    /// Someone who only stakes after a stream was retired gets none of it.
    function test_lateStakerGetsNothingFromRetiredStreams() public {
        Token a = _coin("A");
        _stake(alice, 100e18);
        _notify(a, 1_000e18);
        vm.warp(block.timestamp + 1 days + 1);
        list.set(address(a), false);
        staking.retire(address(a));
        _stake(bob, 100e18);
        assertEq(staking.earned(address(a), bob), 0);
        assertEq(_claimed(bob, a), 0);
        assertApproxEqAbs(_claimed(alice, a), 1_000e18, 1e6);
    }

    /// A coin that comes back gets a fresh stream: the first one still pays its own stakers, and
    /// the new one is shared by whoever stakes now.
    function test_aCoinThatComesBackGetsAFreshStream() public {
        Token a = _coin("A");
        _stake(alice, 100e18);
        _notify(a, 1_000e18);
        vm.warp(block.timestamp + 1 days + 1);
        list.set(address(a), false);
        staking.retire(address(a));

        _stake(bob, 100e18);
        list.set(address(a), true); // back in the basket
        _notify(a, 600e18);
        vm.warp(block.timestamp + 1 days + 1);
        assertApproxEqAbs(_claimed(alice, a), 1_300e18, 1e6); // all of the first, half of the second
        assertApproxEqAbs(_claimed(bob, a), 300e18, 1e6);
    }

    function test_retireOnlyAfterTheCoinLeftAndItsStreamEnded() public {
        Token a = _coin("A");
        _stake(alice, 100e18);
        _notify(a, 1_000e18);
        vm.expectRevert(PantheonStaking.NotRetirable.selector);
        staking.retire(address(a)); // still in the basket and streaming
        list.set(address(a), false);
        vm.expectRevert(PantheonStaking.NotRetirable.selector);
        staking.retire(address(a)); // left, but still streaming
        vm.warp(block.timestamp + 1 days);
        staking.retire(address(a));
        vm.expectRevert(PantheonStaking.NotRetirable.selector);
        staking.retire(address(a)); // already retired

        _notify(usdc, 1e18);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(PantheonStaking.NotRetirable.selector);
        staking.retire(address(usdc)); // USDC never retires
    }

    /// A stream paused because nobody was staking hasn't finished, so it can't be retired.
    function test_aPausedStreamIsNotRetired() public {
        Token a = _coin("A");
        _notify(a, 1_000e18); // nobody staking: it waits
        vm.warp(block.timestamp + 3 days);
        list.set(address(a), false);
        vm.expectRevert(PantheonStaking.NotRetirable.selector);
        staking.retire(address(a));
        _stake(alice, 100e18);
        vm.warp(block.timestamp + 1 days + 1);
        assertApproxEqAbs(_claimed(alice, a), 1_000e18, 1e6); // nothing was lost
        staking.retire(address(a));
    }

    /// When the live slots are full, a new coin frees one by itself.
    function test_aNewCoinRetiresAFinishedOneByItself() public {
        _stake(alice, 100e18);
        uint256 max = staking.MAX_REWARDS();
        for (uint256 i; i < max; ++i) {
            Token c = _coin(string.concat("F", vm.toString(i)));
            _notify(c, 1e18);
            list.set(address(c), false);
        }
        assertEq(_liveCount(), max);
        vm.warp(block.timestamp + 1 days + 1);
        Token fresh = _coin("NEW");
        _notify(fresh, 1e18);
        assertEq(_liveCount(), max);
        assertEq(staking.retiredTokens().length, 1);
    }

    /// Only if every live slot is a coin still in the basket (impossible with a 10-coin basket) is
    /// there no room.
    function test_noRoomWhileEveryLiveCoinIsStillInTheBasket() public {
        _stake(alice, 100e18);
        uint256 max = staking.MAX_REWARDS();
        for (uint256 i; i < max; ++i) {
            _notify(_coin(string.concat("K", vm.toString(i))), 1e18);
        }
        vm.warp(block.timestamp + 2 days);
        Token extra = _coin("EXTRA");
        vm.prank(basket);
        vm.expectRevert(PantheonStaking.TooManyRewardTokens.selector);
        staking.notifyReward(address(extra), 1e18);
    }

    function test_claimTokensPaysOnlyTheListedCoins() public {
        Token a = _coin("A");
        Token b = _coin("B");
        _stake(alice, 100e18);
        _notify(a, 100e18);
        _notify(b, 100e18);
        vm.warp(block.timestamp + 1 days + 1);
        address[] memory only = new address[](1);
        only[0] = address(a);
        vm.prank(alice);
        staking.claimTokens(only);
        assertApproxEqAbs(a.balanceOf(alice), 100e18, 1e6);
        assertEq(b.balanceOf(alice), 0);
    }

    /// Fuzzed rotation: coins join and leave, two stakers come and go, and streams retire along the
    /// way. Per coin, stakers are never paid more than it streamed, and once everything has ended
    /// only rounding dust is left.
    function testFuzz_rotationNeverOverpays(uint256 seed) public {
        Token[] memory coins = new Token[](30);
        uint256[] memory sent = new uint256[](30);
        _stake(alice, 1e18 + (seed % 900_000e18));
        for (uint256 i; i < 30; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            coins[i] = _coin(string.concat("R", vm.toString(i)));
            uint256 amount = 1e6 + (r % 1e27);
            _notify(coins[i], amount);
            sent[i] = amount;
            if (r % 3 == 0) _stake(bob, 1e15 + (r % 1_000e18));
            if (r % 5 == 0) {
                (uint256 staked,,,,) = staking.accounts(bob);
                if (staked > 0) {
                    vm.prank(bob);
                    staking.requestUnstake(staked);
                }
            }
            vm.warp(block.timestamp + (r % 2 days));
            if (r % 2 == 0) list.set(address(coins[i]), false);
            if (i >= 10) list.set(address(coins[i - 10]), false); // the basket holds at most 10 coins
            if (r % 7 == 0) {
                vm.prank(alice);
                staking.claim();
            }
        }
        vm.warp(block.timestamp + 10 days);
        vm.prank(alice);
        staking.claim();
        vm.prank(bob);
        staking.claim();
        for (uint256 i; i < 30; ++i) {
            uint256 paid = coins[i].balanceOf(alice) + coins[i].balanceOf(bob);
            assertLe(paid, sent[i], "paid more than it streamed");
            assertApproxEqAbs(paid, sent[i], 1e12, "only dust left behind");
        }
    }
}

