// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solmate/src/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IHypePassport} from "../passport/IHypePassport.sol";

/// Which tokens may be streamed to stakers: the basket's coins and the base quote (USDC).
interface IRewardList {
    function isConstituent(address token) external view returns (bool);
    function baseQuote() external view returns (address);
}

/// @title PantheonStaking
/// @notice Stake PNTH, earn the basket. Every coin the basket buys is streamed to stakers over a day,
/// in proportion to each staker's working balance:
///     working = staked × time bonus (1.0× rising to 1.5× over 30 days) × HYPE Passport (up to 1.25×)
/// Unstaking takes 3 days: the amount stops earning when you ask and can be withdrawn after.
/// While nobody is staking, a stream pauses instead of being lost.
/// Anyone may `poke` an account to bring its bonuses up to date (a lapsed Passport, a time bonus
/// that has grown). No owner, no admin, nothing to upgrade.
contract PantheonStaking is ReentrancyGuard {
    using SafeTransferLib for ERC20;

    uint256 public constant DURATION = 1 days;
    uint256 public constant COOLDOWN = 3 days;
    uint256 public constant AGE_RAMP = 30 days;
    uint256 public constant MAX_AGE_BONUS = 0.5e18; // up to 1.5×
    uint256 public constant MAX_PASSPORT = 1.25e18;
    uint256 public constant MAX_REWARDS = 24;
    uint256 private constant ONE = 1e18;
    uint256 private constant PRECISION = 1e36;

    struct Account {
        uint256 staked;
        uint256 cooling; // asked to unstake: no longer earning
        uint256 working;
        uint64 coolEnd;
        uint64 stakeStart; // weighted by amount when adding; restarts on unstake
    }

    struct Reward {
        uint256 rate; // tokens × 1e18 per second
        uint256 perWorking; // accumulated tokens per working unit × 1e36
        uint64 finish;
        uint64 lastUpdate;
    }

    ERC20 public immutable pnth;
    IHypePassport public immutable passport;
    IRewardList public immutable rewardList;

    mapping(address => Account) public accounts;
    uint256 public totalStaked;
    uint256 public totalWorking;

    address[] internal _rewardTokens;
    mapping(address => Reward) public rewards;
    mapping(address => mapping(address => uint256)) public paidPerWorking; // token => account => perWorking
    mapping(address => mapping(address => uint256)) public owed; // token => account => amount

    event Staked(address indexed account, uint256 amount);
    event UnstakeRequested(address indexed account, uint256 amount, uint64 coolEnd);
    event UnstakeCancelled(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event Claimed(address indexed account, address indexed token, uint256 amount);
    event Poked(address indexed account, uint256 working);
    event RewardNotified(address indexed token, uint256 amount, uint256 rate, uint64 finish);

    error ZeroAmount();
    error TooMuch();
    error NotCooling();
    error StillCooling(uint64 until);
    error NotARewardToken();
    error TooManyRewardTokens();

    constructor(ERC20 pnth_, IHypePassport passport_, IRewardList rewardList_) {
        pnth = pnth_;
        passport = passport_;
        rewardList = rewardList_;
    }

    // ------------------------------------------------------------------ staking

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _update(msg.sender);
        uint256 before = pnth.balanceOf(address(this));
        pnth.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = pnth.balanceOf(address(this)) - before;
        Account storage a = accounts[msg.sender];
        a.stakeStart = a.staked == 0
            ? uint64(block.timestamp)
            : uint64((uint256(a.stakeStart) * a.staked + block.timestamp * received) / (a.staked + received));
        a.staked += received;
        totalStaked += received;
        _sync(msg.sender);
        emit Staked(msg.sender, received);
    }

    /// @notice Start the 3-day unlock. The amount stops earning now; the time bonus restarts.
    function requestUnstake(uint256 amount) external nonReentrant {
        Account storage a = accounts[msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (amount > a.staked) revert TooMuch();
        _update(msg.sender);
        a.staked -= amount;
        a.cooling += amount;
        a.coolEnd = uint64(block.timestamp + COOLDOWN);
        a.stakeStart = uint64(block.timestamp);
        totalStaked -= amount;
        _sync(msg.sender);
        emit UnstakeRequested(msg.sender, amount, a.coolEnd);
    }

    /// @notice Changed your mind: everything unlocking goes back to earning.
    function cancelUnstake() external nonReentrant {
        Account storage a = accounts[msg.sender];
        uint256 amount = a.cooling;
        if (amount == 0) revert NotCooling();
        _update(msg.sender);
        a.cooling = 0;
        a.coolEnd = 0;
        a.staked += amount;
        a.stakeStart = uint64(block.timestamp);
        totalStaked += amount;
        _sync(msg.sender);
        emit UnstakeCancelled(msg.sender, amount);
    }

    function withdraw() external nonReentrant {
        Account storage a = accounts[msg.sender];
        uint256 amount = a.cooling;
        if (amount == 0) revert NotCooling();
        if (block.timestamp < a.coolEnd) revert StillCooling(a.coolEnd);
        a.cooling = 0;
        a.coolEnd = 0;
        pnth.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Pay out everything this account has earned, in every basket coin.
    function claim() external nonReentrant {
        _update(msg.sender);
        uint256 n = _rewardTokens.length;
        for (uint256 i; i < n; ++i) {
            address t = _rewardTokens[i];
            uint256 amount = owed[t][msg.sender];
            if (amount == 0) continue;
            owed[t][msg.sender] = 0;
            ERC20(t).safeTransfer(msg.sender, amount);
            emit Claimed(msg.sender, t, amount);
        }
    }

    /// @notice Bring accounts' bonuses up to date. Permissionless (a keeper does it on Passport events).
    function poke(address[] calldata list) external nonReentrant {
        for (uint256 i; i < list.length; ++i) {
            _update(list[i]);
            _sync(list[i]);
        }
    }

    // ------------------------------------------------------------------ rewards

    /// @notice Stream `amount` of a basket coin (or USDC) to stakers over the next day. Anyone may add
    /// rewards, but only in the basket's coins, so the 24 reward slots can't be filled with junk.
    function notifyReward(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (token == address(pnth)) revert NotARewardToken();
        if (!rewardList.isConstituent(token) && token != rewardList.baseQuote()) revert NotARewardToken();
        _update(address(0));
        Reward storage r = rewards[token];
        if (r.lastUpdate == 0) {
            if (_rewardTokens.length >= MAX_REWARDS) revert TooManyRewardTokens();
            _rewardTokens.push(token);
            r.lastUpdate = uint64(block.timestamp);
        }
        uint256 before = ERC20(token).balanceOf(address(this));
        ERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = ERC20(token).balanceOf(address(this)) - before;

        if (block.timestamp >= r.finish) {
            r.rate = (received * ONE) / DURATION;
            r.finish = uint64(block.timestamp + DURATION);
        } else {
            uint256 remaining = r.finish - block.timestamp;
            if (remaining >= 1 hours) {
                r.rate += (received * ONE) / remaining; // top up the running stream
            } else {
                r.rate = (r.rate * remaining + received * ONE) / DURATION; // restart with the leftover
                r.finish = uint64(block.timestamp + DURATION);
            }
        }
        r.lastUpdate = uint64(block.timestamp);
        emit RewardNotified(token, received, r.rate, r.finish);
    }

    // ------------------------------------------------------------------ views

    function rewardTokens() external view returns (address[] memory) {
        return _rewardTokens;
    }

    function earned(address token, address account) public view returns (uint256) {
        Reward memory r = rewards[token];
        uint256 pw = r.perWorking;
        uint256 to = block.timestamp < r.finish ? block.timestamp : r.finish;
        if (totalWorking > 0 && to > r.lastUpdate) {
            pw += Math.mulDiv((to - r.lastUpdate) * r.rate, ONE, totalWorking);
        }
        return owed[token][account] + Math.mulDiv(accounts[account].working, pw - paidPerWorking[token][account], PRECISION);
    }

    /// The account's working balance if it were poked now.
    function workingOf(address account) public view returns (uint256) {
        Account memory a = accounts[account];
        if (a.staked == 0) return 0;
        uint256 age = block.timestamp - a.stakeStart;
        if (age > AGE_RAMP) age = AGE_RAMP;
        uint256 ageMult = ONE + (age * MAX_AGE_BONUS) / AGE_RAMP;
        return (((a.staked * ageMult) / ONE) * _passportMultiplier(account)) / ONE;
    }

    // ------------------------------------------------------------------ internal

    function _update(address account) internal {
        uint256 n = _rewardTokens.length;
        for (uint256 i; i < n; ++i) {
            address t = _rewardTokens[i];
            Reward storage r = rewards[t];
            if (totalWorking == 0) {
                // Nobody has been earning since the last update: the stream waits for stakers.
                if (r.lastUpdate < r.finish) r.finish += uint64(block.timestamp - r.lastUpdate);
                r.lastUpdate = uint64(block.timestamp);
            } else {
                uint256 to = block.timestamp < r.finish ? block.timestamp : r.finish;
                if (to > r.lastUpdate) {
                    r.perWorking += Math.mulDiv((to - r.lastUpdate) * r.rate, ONE, totalWorking);
                    r.lastUpdate = uint64(to);
                }
            }
            if (account != address(0)) {
                owed[t][account] += Math.mulDiv(
                    accounts[account].working, r.perWorking - paidPerWorking[t][account], PRECISION
                );
                paidPerWorking[t][account] = r.perWorking;
            }
        }
    }

    function _sync(address account) internal {
        Account storage a = accounts[account];
        uint256 w = workingOf(account);
        totalWorking = totalWorking - a.working + w;
        a.working = w;
        emit Poked(account, w);
    }

    function _passportMultiplier(address account) internal view returns (uint256 m) {
        if (address(passport) == address(0)) return ONE;
        try passport.multiplierOf(account) returns (uint256 v) {
            m = v < ONE ? ONE : (v > MAX_PASSPORT ? MAX_PASSPORT : v);
        } catch {
            m = ONE;
        }
    }
}
