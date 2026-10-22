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
///
/// Streams: each coin streams through its own accumulator. At most MAX_REWARDS streams are live at
/// once (that bounds the gas of every stake and claim). When a coin has left the basket and its
/// stream has finished, its stream is retired (by anyone, or automatically when a new coin needs the
/// slot). A retired stream never earns again; each staker's share of it is settled the next time
/// their account is touched, at the working balance they held while it ran, and stays claimable
/// forever. If the coin comes back into the basket it gets a fresh stream. So the basket can rotate
/// through any number of coins over the years and no reward is ever lost or paid twice.
contract PantheonStaking is ReentrancyGuard {
    using SafeTransferLib for ERC20;

    uint256 public constant DURATION = 1 days;
    uint256 public constant COOLDOWN = 3 days;
    uint256 public constant AGE_RAMP = 30 days;
    uint256 public constant MAX_AGE_BONUS = 0.5e18; // up to 1.5×
    uint256 public constant MAX_PASSPORT = 1.25e18;
    /// Live streams at once. The basket holds at most 10 coins, plus USDC, plus coins that just left
    /// and are finishing their last day: well under this.
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

    struct Stream {
        address token;
        uint64 finish;
        uint64 lastUpdate;
        uint256 rate; // tokens × 1e18 per second
        uint256 perWorking; // accumulated tokens per working unit × 1e36
    }

    ERC20 public immutable pnth;
    IHypePassport public immutable passport;
    IRewardList public immutable rewardList;

    mapping(address => Account) public accounts;
    uint256 public totalStaked;
    uint256 public totalWorking;

    Stream[] internal _streams; // every stream ever opened; its index is its id
    uint256[] internal _liveIds; // streams still earning (≤ MAX_REWARDS)
    uint256[] internal _retiredIds; // retired streams, oldest first
    mapping(address => uint256) internal _liveSlot; // token => live stream id + 1 (0 = none)
    mapping(uint256 => mapping(address => uint256)) internal _paid; // stream id => account => perWorking settled
    mapping(address => mapping(address => uint256)) public owed; // token => account => amount
    mapping(address => uint256) public retiredSeen; // account => retired streams already settled

    event Staked(address indexed account, uint256 amount);
    event UnstakeRequested(address indexed account, uint256 amount, uint64 coolEnd);
    event UnstakeCancelled(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event Claimed(address indexed account, address indexed token, uint256 amount);
    event Poked(address indexed account, uint256 working);
    event RewardNotified(address indexed token, uint256 amount, uint256 rate, uint64 finish);
    event RewardRetired(address indexed token, uint256 streamId);

    error ZeroAmount();
    error TooMuch();
    error NotCooling();
    error StillCooling(uint64 until);
    error NotARewardToken();
    error TooManyRewardTokens();
    error NotRetirable();

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

    /// @notice Pay out everything this account has earned, in every coin the basket ever streamed.
    function claim() external nonReentrant {
        _update(msg.sender);
        uint256 n = _liveIds.length;
        for (uint256 i; i < n; ++i) {
            _pay(_streams[_liveIds[i]].token, msg.sender);
        }
        n = _retiredIds.length;
        for (uint256 i; i < n; ++i) {
            _pay(_streams[_retiredIds[i]].token, msg.sender);
        }
    }

    /// @notice Pay out what this account has earned in the listed coins only (cheaper than `claim`
    /// once the basket has rotated through many coins).
    function claimTokens(address[] calldata tokens) external nonReentrant {
        _update(msg.sender);
        for (uint256 i; i < tokens.length; ++i) {
            _pay(tokens[i], msg.sender);
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
    /// rewards, but only in the basket's coins, so the live slots can't be filled with junk.
    function notifyReward(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (token == address(pnth)) revert NotARewardToken();
        if (!rewardList.isConstituent(token) && token != rewardList.baseQuote()) revert NotARewardToken();
        _update(address(0));
        uint256 slot = _liveSlot[token];
        if (slot == 0) {
            if (_liveIds.length >= MAX_REWARDS && !_retireOne()) revert TooManyRewardTokens();
            _streams.push(
                Stream({token: token, finish: 0, lastUpdate: uint64(block.timestamp), rate: 0, perWorking: 0})
            );
            slot = _streams.length;
            _liveIds.push(slot - 1);
            _liveSlot[token] = slot;
        }
        Stream storage r = _streams[slot - 1];
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

    /// @notice Free the slot of a coin that has left the basket and finished streaming. Anyone may
    /// call it; `notifyReward` also does it by itself when it needs a slot.
    function retire(address token) external nonReentrant {
        _update(address(0)); // first: a stream paused for lack of stakers has not finished
        if (!_retirable(token)) revert NotRetirable();
        uint256 n = _liveIds.length;
        for (uint256 i; i < n; ++i) {
            if (_streams[_liveIds[i]].token == token) {
                _retireAt(i);
                return;
            }
        }
    }

    // ------------------------------------------------------------------ views

    /// The coins streaming now.
    function rewardTokens() external view returns (address[] memory out) {
        uint256 n = _liveIds.length;
        out = new address[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = _streams[_liveIds[i]].token;
        }
    }

    /// The coins of retired streams, oldest first (a coin that left and came back twice appears twice).
    function retiredTokens() external view returns (address[] memory out) {
        uint256 n = _retiredIds.length;
        out = new address[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = _streams[_retiredIds[i]].token;
        }
    }

    /// The live stream of a coin (all zero if it isn't streaming).
    function rewards(address token)
        external
        view
        returns (uint256 rate, uint256 perWorking, uint64 finish, uint64 lastUpdate)
    {
        uint256 slot = _liveSlot[token];
        if (slot == 0) return (0, 0, 0, 0);
        Stream memory r = _streams[slot - 1];
        return (r.rate, r.perWorking, r.finish, r.lastUpdate);
    }

    /// What the account has settled against a coin's live stream.
    function paidPerWorking(address token, address account) external view returns (uint256) {
        uint256 slot = _liveSlot[token];
        return slot == 0 ? 0 : _paid[slot - 1][account];
    }

    /// Everything the account could claim in this coin right now: settled, live and retired.
    function earned(address token, address account) public view returns (uint256 e) {
        uint256 w = accounts[account].working;
        e = owed[token][account];
        uint256 slot = _liveSlot[token];
        if (slot != 0) {
            Stream memory r = _streams[slot - 1];
            uint256 pw = r.perWorking;
            uint256 to = block.timestamp < r.finish ? block.timestamp : r.finish;
            if (totalWorking > 0 && to > r.lastUpdate) {
                pw += Math.mulDiv((to - r.lastUpdate) * r.rate, ONE, totalWorking);
            }
            e += Math.mulDiv(w, pw - _paid[slot - 1][account], PRECISION);
        }
        if (w == 0) return e;
        uint256 n = _retiredIds.length;
        for (uint256 i = retiredSeen[account]; i < n; ++i) {
            uint256 id = _retiredIds[i];
            if (_streams[id].token == token) {
                e += Math.mulDiv(w, _streams[id].perWorking - _paid[id][account], PRECISION);
            }
        }
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

    /// Accrue every live stream to now; with an account, settle its share of every live stream and of
    /// every stream retired since its last update (its working balance was constant since then).
    function _update(address account) internal {
        uint256 n = _liveIds.length;
        uint256 w = account == address(0) ? 0 : accounts[account].working;
        for (uint256 i; i < n; ++i) {
            uint256 id = _liveIds[i];
            Stream storage r = _streams[id];
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
                owed[r.token][account] += Math.mulDiv(w, r.perWorking - _paid[id][account], PRECISION);
                _paid[id][account] = r.perWorking;
            }
        }
        if (account == address(0)) return;
        uint256 m = _retiredIds.length;
        uint256 seen = retiredSeen[account];
        if (seen == m) return;
        if (w > 0) {
            for (uint256 i = seen; i < m; ++i) {
                uint256 id = _retiredIds[i];
                Stream storage r = _streams[id];
                owed[r.token][account] += Math.mulDiv(w, r.perWorking - _paid[id][account], PRECISION);
            }
        }
        // With no working balance there is nothing to settle; retired streams never earn again.
        retiredSeen[account] = m;
    }

    function _sync(address account) internal {
        Account storage a = accounts[account];
        uint256 w = workingOf(account);
        totalWorking = totalWorking - a.working + w;
        a.working = w;
        emit Poked(account, w);
    }

    function _pay(address token, address account) internal {
        uint256 amount = owed[token][account];
        if (amount == 0) return;
        owed[token][account] = 0;
        ERC20(token).safeTransfer(account, amount);
        emit Claimed(account, token, amount);
    }

    /// A live coin that has left the basket and finished its last stream (USDC never retires).
    /// Only meaningful right after `_update(address(0))`, which moves a paused stream's finish on.
    function _retirable(address token) internal view returns (bool) {
        uint256 slot = _liveSlot[token];
        if (slot == 0) return false;
        if (block.timestamp < _streams[slot - 1].finish) return false;
        return token != rewardList.baseQuote() && !rewardList.isConstituent(token);
    }

    /// Retire the first live stream that can go. Callers have accrued every live stream first.
    function _retireOne() internal returns (bool) {
        uint256 n = _liveIds.length;
        for (uint256 i; i < n; ++i) {
            if (_retirable(_streams[_liveIds[i]].token)) {
                _retireAt(i);
                return true;
            }
        }
        return false;
    }

    function _retireAt(uint256 i) internal {
        uint256 id = _liveIds[i];
        _liveIds[i] = _liveIds[_liveIds.length - 1];
        _liveIds.pop();
        _retiredIds.push(id);
        address token = _streams[id].token;
        delete _liveSlot[token];
        emit RewardRetired(token, id);
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
