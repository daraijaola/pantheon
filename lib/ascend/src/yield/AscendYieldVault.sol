// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {YieldExitReserve} from "./YieldExitReserve.sol";

/// @notice The one read the vault makes of Kinetiq's accountant: HYPE per `amount` of kHYPE.
interface IStakingAccountant {
    function kHYPEToHYPE(uint256 amount) external view returns (uint256);
}

/// @notice Immutable, ownerless kHYPE principal vault with a fixed yield sink.
/// Consumers: wallet and /stake (deposit/redeem/position), permissionless
/// keepers (checkpoint/release), ceremony (identities and limits).
/// A deposit buys only its proportional principal backing, never earlier
/// holders' booked yield. The kHYPE principal no longer needs as
/// the rate grows is segregated (`yieldBackingKHYPE`), released to the sink
/// under a weekly cap, and each wallet is credited with the yield it gave up.
/// Staker rewards are claimed from StakerDistributor. Within a generation,
/// the principal index is at most one: a lower rate reduces its valuation,
/// but the same kHYPE remains principal and recovers before new yield is
/// booked. Nobody else's deposit or accrued rewards fund that recovery.
contract AscendYieldVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant EPOCH_SECONDS = 7 days;
    uint256 internal constant RATE_READ_GAS = 100_000;
    uint256 internal constant RATE_CALL_GAS_FLOOR = 210_000;
    /// @dev The largest amount, cap or rate the limits and the reads admit.
    uint256 internal constant MAX_MAGNITUDE = 1e36;
    /// @dev The most initial headroom a sheet may give the deployment ceiling: 1%.
    uint256 internal constant MAX_INITIAL_HEADROOM_BPS = 100;
    /// @dev How long a rate must stand before the floor is hung from it: the
    /// high water rises only to a level two samples this far apart both reached.
    uint256 internal constant RATE_CONFIRMATION = 1 days;
    /// @dev A generation that has lost all but a billionth of its principal
    /// ends. Its remaining active backing moves to an immutable in-kind exit
    /// reserve, preserving old claims without blocking the next generation.
    uint256 internal constant MIN_INDEX = 1e18;

    struct Limits {
        /// @dev Cap on target principal (one HYPE per share), including claims
        /// temporarily valued below their target that can later recover.
        uint256 maxPrincipalHype;
        uint256 maxEpochReleaseKHYPE;
        uint256 maxRateGrowthBpsPerYear;
        uint256 minDepositKHYPE;
        uint256 initialRateHeadroomBps;
        /// @dev How far below the highest confirmed rate a reading may sit and
        /// still be believed. Below it the rate is invalid: no haircut is
        /// booked and exits are in kind until it returns. A reading inside it
        /// is believed at once, but does not discard the recovery claim on
        /// the position's remaining kHYPE. 10,000
        /// disables the floor; zero is refused (any dip would be unbelieved).
        /// The deployment sheet and VerifyStaking pin the value.
        uint256 maxRateDrawdownBps;
        /// @dev How far above the rate that last stood a reading may sit and
        /// still be believed, on top of the growth bound for the time since.
        /// Above it the rate is invalid: nothing is booked, deposits and
        /// releases wait, exits are in kind until it returns or the bound has
        /// grown to it. 10,000 allows a doubling of the standing rate, which
        /// leaves the deployment envelope to decide in practice; zero is refused.
        uint256 maxRateStepBps;
    }

    /// @dev accountedKHYPE = principalReserveKHYPE + yieldBackingKHYPE; the
    /// token balance = accountedKHYPE + unassignedKHYPE.
    struct AccountingState {
        uint256 accountedKHYPE;
        uint256 principalReserveKHYPE;
        uint256 yieldBackingKHYPE;
        uint256 unassignedKHYPE;
        uint256 totalPrincipalShares;
        uint256 principalIndex;
        uint256 principalGeneration;
    }

    struct Position {
        uint256 shares;
        uint256 generation;
        /// @dev `yieldPerShare` when this position last settled.
        uint256 yieldPerSharePaid;
        /// @dev kHYPE of staking yield this wallet's principal has given up to
        /// the surplus, settled to its last deposit or redemption.
        uint256 yieldSurrendered;
        uint256 depositedKHYPE;
        uint256 redeemedKHYPE;
    }

    struct PositionView {
        uint256 shares;
        uint256 principalHype;
        uint256 equivalentKHYPE;
        uint256 inKindKHYPE;
        uint256 rate;
        bool rateValid;
        uint256 depositedKHYPE;
        uint256 redeemedKHYPE;
        /// @notice An ended generation's in-kind claim, independent of the
        /// current rate and active principal. Redeem it before depositing again.
        bool retired;
    }

    /// @notice The staked token: the only asset this vault takes, holds and pays.
    IERC20 public immutable khype;
    /// @notice The one source of the kHYPE rate (`kHYPEToHYPE`): Kinetiq's staking accountant.
    address public immutable accountant;
    /// @notice Where `release` sends the surplus. Fixed at deployment; no seat can change it.
    address public immutable yieldSink;
    /// @notice The only account allowed to deposit, or zero for the public user
    /// vault. The protocol instance names its fee converter at construction.
    address public immutable depositor;
    /// @notice The rate read at deployment: the origin of the growth bound.
    uint256 public immutable rateAtDeployment;
    /// @notice When this vault was deployed: the origin of the growth bound's clock.
    uint256 public immutable deployedAt;
    /// @notice The seven limits, in the order of `Limits` (an integrator reads the tuple positionally).
    Limits public limits;
    AccountingState private _state;
    mapping(address => Position) private _positions;
    /// @notice The epoch (`block.timestamp / 7 days`) `epochReleasedKHYPE` counts. Consumer: the keeper's weekly release.
    uint256 public releaseEpoch;
    /// @notice kHYPE released to the sink in `releaseEpoch`, counted against `limits.maxEpochReleaseKHYPE`.
    uint256 public epochReleasedKHYPE;
    /// @notice The highest rate that has stood: the lower of two believed
    /// samples at least a day apart. The floor of what the next checkpoint
    /// will believe hangs from it (`limits.maxRateDrawdownBps`).
    uint256 public rateHighWater;
    /// @dev The sample: the lowest believed reading since it was taken, and
    /// when it was taken. A reading is believed only up to the allowance above
    /// the higher of the high water and the sample (`currentRate`), so one
    /// reading above that allowance books nothing: no surplus, no credit, no
    /// deposit at it. A reading inside the allowance is believed at once, and
    /// the allowance grows with the time since the sample: the daily
    /// checkpoint is what holds it to one step (round 11, R11-A2).
    uint256 public rateSample;
    /// @notice When `rateSample` was taken.
    uint256 public rateSampledAt;
    /// @notice Staking yield the surplus has taken per principal share, in
    /// kHYPE scaled by RAY, summed over every checkpoint where the surplus
    /// grew while shares stood. Booked credit never falls. A rate decrease
    /// does not reclaim booked rewards; recovery of remaining principal is
    /// not surrendered again. Reward
    /// allocations weight a wallet by differences of `yieldSurrendered`.
    uint256 public yieldPerShare;
    /// @dev `yieldPerShare` when each ended generation ended: what a position
    /// left behind in it settles against.
    mapping(uint256 generation => uint256) private generationYieldPerShare;

    error InvalidConfiguration();
    error InvalidRate();
    error InsufficientRateGas();
    error InvalidAmount();
    error MinimumNotMet();
    error MinimumRemainder();
    error PrincipalLimit();
    error TransferMismatch();
    error UnauthorizedDepositor();
    error UnsettledGeneration();

    /// @notice Every kHYPE ever released to the sink.
    uint256 public totalReleasedKHYPE;
    /// @notice All booked yield is segregated from principal, even before its
    /// weekly release. Retained custody getter for existing reconciliation
    /// consumers; always equals the stored `yieldBackingKHYPE`.
    uint256 public retiredYieldKHYPE;
    /// @notice Separate custody for an extreme-loss generation's residual
    /// principal. Zero for a generation with no residual. Consumers: previews,
    /// withdrawals, and custody reconciliation. No claim deadline.
    mapping(uint256 generation => YieldExitReserve) public exitReserve;

    event Checkpoint(uint256 rate, bool valid, AccountingState accounting);
    /// @dev `principalHype` is what the minted shares represent at the current
    /// index — the claim the depositor actually holds, never more than the
    /// credit the received kHYPE was worth.
    event Deposited(address indexed wallet, uint256 receivedKHYPE, uint256 principalHype, uint256 shares, uint256 rate);
    event Redeemed(address indexed wallet, uint256 shares, uint256 liabilityReductionHype, uint256 paidKHYPE, bool inKind);
    event YieldReleased(uint256 amountKHYPE, uint256 epoch);
    /// @dev The surplus grew by `amountKHYPE` at this checkpoint, taken pro
    /// rata from the principal standing. Consumers: the reward allocation
    /// builder (weights by yield given up) and the indexer.
    event YieldSurrendered(uint256 amountKHYPE, uint256 yieldPerShare);
    event RoundingQuarantined(uint256 amountKHYPE);
    event GenerationRetired(uint256 indexed generation, address indexed reserve, uint256 shares, uint256 amountKHYPE);

    /// @param khype_ the staked token, 18 decimals
    /// @param accountant_ the rate source; its answer at deployment must be readable and non-zero
    /// @param yieldSink_ where the surplus is released, for good
    /// @param limits_ the seven limits, each inside the bounds checked here
    /// @param depositor_ zero for public deposits; otherwise the sole depositor,
    /// which may be a converter deployed after this vault
    constructor(address khype_, address accountant_, address yieldSink_, Limits memory limits_, address depositor_) {
        if (
            khype_.code.length == 0 || accountant_.code.length == 0 || yieldSink_.code.length == 0 || yieldSink_ == address(this) || yieldSink_ == khype_
                || IERC20Metadata(khype_).decimals() != 18
                || limits_.maxPrincipalHype == 0 || limits_.maxPrincipalHype > MAX_MAGNITUDE || limits_.maxEpochReleaseKHYPE == 0
                || limits_.maxEpochReleaseKHYPE > MAX_MAGNITUDE || limits_.minDepositKHYPE == 0
                || limits_.maxRateGrowthBpsPerYear == 0 || limits_.maxRateGrowthBpsPerYear > 10_000
                || limits_.initialRateHeadroomBps > MAX_INITIAL_HEADROOM_BPS || limits_.maxRateDrawdownBps == 0
                || limits_.maxRateDrawdownBps > 10_000 || limits_.maxRateStepBps == 0 || limits_.maxRateStepBps > 10_000
        ) revert InvalidConfiguration();
        khype = IERC20(khype_);
        accountant = accountant_;
        yieldSink = yieldSink_;
        depositor = depositor_;
        limits = limits_;
        deployedAt = block.timestamp;
        (uint256 initial, bool ok) = _readRate();
        if (!ok || initial == 0 || initial > MAX_MAGNITUDE) revert InvalidRate();
        // A minimum deposit worth nothing, or one the cap could never admit, is a vault nobody can enter.
        uint256 minimumHype = Math.mulDiv(limits_.minDepositKHYPE, initial, WAD);
        if (minimumHype == 0 || minimumHype > limits_.maxPrincipalHype) revert InvalidConfiguration();
        rateAtDeployment = initial;
        rateHighWater = initial;
        rateSample = initial;
        rateSampledAt = block.timestamp;
        _state.principalIndex = RAY;
        _state.principalGeneration = 1;
    }

    /// @dev Fixed-size return buffer and gas ensure a failed dependency cannot
    /// allocate unbounded returndata. Low caller gas REVERTS, never selects an
    /// unvalued exit. The floor includes EIP-150 headroom and post-read work.
    /// A failed read reports rate 0, never the scratch memory it did not fill.
    function _readRate() private view returns (uint256 rate, bool ok) {
        if (gasleft() < RATE_CALL_GAS_FLOOR) revert InsufficientRateGas();
        address target = accountant;
        bytes memory input = abi.encodeCall(IStakingAccountant.kHYPEToHYPE, (WAD));
        assembly ("memory-safe") {
            let output := mload(0x40)
            ok := staticcall(RATE_READ_GAS, target, add(input, 32), mload(input), output, 32)
            ok := and(ok, eq(returndatasize(), 32))
            rate := mul(ok, mload(output))
        }
    }

    /// @notice Observed now; the accountant provides no last-update timestamp.
    /// A reading is believed between a floor and two ceilings.
    function currentRate() public view returns (uint256 rate, bool valid) {
        (rate, valid) = _readRate();
        // Rewards arrive in batches that can include time before deployment.
        // The explicit initial allowance is capped at 1% and never resets;
        // checkpoints cannot ratchet the deployment-anchored envelope upward.
        uint256 ceiling = _allowed(rateAtDeployment, deployedAt, limits.initialRateHeadroomBps);
        // A step from where the rate last stood (round 4): a reading far
        // above it is more likely a fault than a reward. Believed, it would
        // book surplus the correction takes back; releasing it would take
        // backing from the holders standing there. An unbelieved rate books
        // nothing; exits are in kind against a reserve
        // that is whole.
        uint256 standing = _allowed(Math.max(rateHighWater, rateSample), rateSampledAt, limits.maxRateStepBps);
        // The floor: one reading far below every rate that has stood is more
        // likely a fault than a loss. An unbelieved rate changes no valuation
        // or generation; holders can still leave in kind.
        uint256 floor = rateHighWater - Math.mulDiv(rateHighWater, limits.maxRateDrawdownBps, 10_000);
        valid = valid && rate >= floor && rate > 0 && rate <= Math.min(ceiling, standing) && rate <= MAX_MAGNITUDE;
    }

    /// @dev The most a reading may be, measured from `from` since `since`:
    /// `headroomBps` at once, and the growth bound for the time passed.
    function _allowed(uint256 from, uint256 since, uint256 headroomBps) private view returns (uint256) {
        return from + Math.mulDiv(from, headroomBps, 10_000)
            + Math.mulDiv(from, limits.maxRateGrowthBpsPerYear * (block.timestamp - since), 10_000 * 365 days);
    }

    /// @notice The accounting as the last checkpoint stored it (not projected to this block).
    function state() external view returns (AccountingState memory) {
        return _state;
    }

    /// @notice The principal the vault owes now, projected like `position()`
    /// (today's rate), not the last checkpoint. The deposit cap additionally
    /// reserves capacity for recovery: it bounds total target shares.
    function principalLiabilityHype() external view returns (uint256) {
        (AccountingState memory s,,,,) = _project();
        return _liability(s);
    }

    function _project() private view returns (AccountingState memory s, uint256 rate, bool valid, uint256 retired, uint256 residual) {
        (rate, valid) = currentRate();
        (s, retired, residual) = _projectState(_state, khype.balanceOf(address(this)), rate, valid);
    }

    function _checkpoint(bool requireRate) private returns (uint256 rate, bool valid) {
        AccountingState memory s;
        uint256 retired;
        uint256 residual;
        (s, rate, valid, retired, residual) = _project();
        if (requireRate && !valid) revert InvalidRate();
        uint256 surrendered = _surrendered(s);
        if (surrendered != 0) {
            yieldPerShare += Math.mulDiv(surrendered, RAY, s.totalPrincipalShares);
            emit YieldSurrendered(surrendered, yieldPerShare);
        }
        // One reading cannot hang the floor above the true rate (round 3, C-V1):
        // the high water follows the lowest believed reading across a day or
        // more, so an honest checkpoint inside the day clears a faulty sample.
        if (valid) {
            if (block.timestamp >= rateSampledAt + RATE_CONFIRMATION) {
                uint256 stood = Math.min(rate, rateSample);
                if (stood > rateHighWater) rateHighWater = stood;
                rateSample = rate;
                rateSampledAt = block.timestamp;
            } else if (rate < rateSample) {
                rateSample = rate;
            }
        }
        uint256 previousGeneration = _state.principalGeneration;
        uint256 previousShares = _state.totalPrincipalShares;
        if (s.principalGeneration != previousGeneration) generationYieldPerShare[previousGeneration] = yieldPerShare;
        _state = s;
        retiredYieldKHYPE = retired;
        if (residual != 0) {
            YieldExitReserve reserve = new YieldExitReserve(khype, previousShares, residual);
            exitReserve[previousGeneration] = reserve;
            uint256 beforeBalance = khype.balanceOf(address(this));
            uint256 beforeReserve = khype.balanceOf(address(reserve));
            khype.safeTransfer(address(reserve), residual);
            if (beforeBalance - khype.balanceOf(address(this)) != residual || khype.balanceOf(address(reserve)) - beforeReserve != residual) revert TransferMismatch();
            emit GenerationRetired(previousGeneration, address(reserve), previousShares, residual);
        }
        emit Checkpoint(rate, valid, s);
    }

    /// @dev What a checkpoint adds to the surplus while principal stands is
    /// staking yield its holders gave up, counted gross (see `yieldPerShare`).
    /// A believed rise above the principal recovery target reaches this
    /// difference. Integer entry/conversion rounding can contribute token dust.
    /// Nothing else does: a release is written to storage outside the
    /// projection, and an unvalued projection can only lower the surplus (a
    /// custody deficit) or leave it as it was.
    function _surrendered(AccountingState memory s) private view returns (uint256) {
        if (s.totalPrincipalShares == 0 || s.yieldBackingKHYPE <= _state.yieldBackingKHYPE) return 0;
        return s.yieldBackingKHYPE - _state.yieldBackingKHYPE;
    }

    /// @notice kHYPE of staking yield `wallet`'s principal has given up to the
    /// surplus, to this block. What checkpoints have booked never falls, a
    /// wiped generation included. The part no checkpoint has booked yet is
    /// projected at the current rate, so between checkpoints a reading can be
    /// lower than an earlier one. Consumers: the reward allocation builder (a
    /// week's weight is the rise between its two ends, zero if it fell) and
    /// /stake.
    function yieldSurrendered(address wallet) external view returns (uint256) {
        (AccountingState memory s,,,,) = _project();
        Position memory p = _positions[wallet];
        uint256 perShare;
        if (p.generation != _state.principalGeneration) {
            perShare = generationYieldPerShare[p.generation];
        } else {
            perShare = yieldPerShare;
            uint256 pending = _surrendered(s); // zero when the projection wipes the generation
            if (pending != 0) perShare += Math.mulDiv(pending, RAY, s.totalPrincipalShares);
        }
        return p.yieldSurrendered + Math.mulDiv(p.shares, perShare - p.yieldPerSharePaid, RAY);
    }

    /// @notice Book the rate as it stands: credit the yield given up, move the
    /// sample, store the projection. Anyone; needs a believed rate. The keeper's
    /// daily duty.
    function checkpoint() external nonReentrant {
        _checkpoint(true);
    }

    /// @dev Loaded after the checkpoint, so `yieldPerShare` is current: the
    /// yield given up since the wallet last moved is settled before its
    /// shares change. Shares of an ended generation settle against that
    /// generation's end and carry no claim forward.
    function _position(address wallet) private view returns (Position memory p) {
        p = _positions[wallet];
        bool live = p.generation == _state.principalGeneration;
        p.yieldSurrendered +=
            Math.mulDiv(p.shares, (live ? yieldPerShare : generationYieldPerShare[p.generation]) - p.yieldPerSharePaid, RAY);
        if (!live && (p.shares == 0 || address(exitReserve[p.generation]) == address(0))) {
            p.shares = 0;
            p.generation = _state.principalGeneration;
        }
        p.yieldPerSharePaid = p.generation == _state.principalGeneration ? yieldPerShare : generationYieldPerShare[p.generation];
    }

    /// @notice The shares `amount` would mint at this block and their HYPE
    /// principal. The final return value is retained for ABI compatibility:
    /// `bufferKHYPE` is always zero; deposits never buy earlier booked yield.
    /// Zero shares with a valid rate: the amount buys no principal share and `deposit`
    /// would refuse it (`MinimumNotMet`). Applies the target-principal cap;
    /// the minimum deposit is checked by `deposit`.
    function previewDeposit(uint256 amount) external view returns (
        uint256 shares, uint256 rate, bool valid, uint256 principalHype, uint256 bufferKHYPE
    ) {
        AccountingState memory s;
        (s, rate, valid,,) = _project();
        if (valid) {
            (shares, principalHype,) = _depositQuote(s, amount, rate);
        }
        bufferKHYPE = 0;
    }

    /// @dev Price only principal custody. Entry cannot dilute anyone's kHYPE
    /// claim or capture yield held for rewards. Round shares down and backing
    /// up; quarantine what buys no share. The cap covers target claims too, so
    /// recovery can never push the generation above its deployment cap.
    function _depositQuote(AccountingState memory s, uint256 amount, uint256 rate)
        private view returns (uint256 shares, uint256 principalHype, uint256 reserve)
    {
        shares = Math.mulDiv(amount, rate, WAD);
        uint256 backingAdded;
        if (s.totalPrincipalShares != 0 && s.principalIndex < RAY) {
            shares = Math.mulDiv(amount, s.totalPrincipalShares, s.principalReserveKHYPE);
            backingAdded = Math.mulDiv(shares, s.principalReserveKHYPE, s.totalPrincipalShares, Math.Rounding.Ceil);
        } else {
            // At par, ceil-rounded reserve dust is not an entry fee. Price at
            // the actual rate and fund only the additional aggregate reserve.
            backingAdded = Math.mulDiv(s.totalPrincipalShares + shares, WAD, rate, Math.Rounding.Ceil) - s.principalReserveKHYPE;
        }
        principalHype = Math.mulDiv(shares, s.principalIndex, RAY);
        if (s.totalPrincipalShares + shares > limits.maxPrincipalHype) revert PrincipalLimit();
        reserve = s.principalReserveKHYPE + backingAdded;
        if (backingAdded > amount) revert TransferMismatch();
    }

    /// @notice Deposit `amount` kHYPE (at least `limits.minDepositKHYPE`) as
    /// HYPE-denominated principal with no buffer charge, minting at least
    /// `minPrincipalShares`. Refused without a believed rate, above the cap,
    /// or when the amount is worth no share.
    function deposit(uint256 amount, uint256 minPrincipalShares)
        external
        nonReentrant
        returns (uint256 shares)
    {
        if (depositor != address(0) && msg.sender != depositor) revert UnauthorizedDepositor();
        if (amount < limits.minDepositKHYPE) revert InvalidAmount();
        (uint256 rate,) = _checkpoint(true);
        Position memory p = _position(msg.sender);
        if (p.generation != _state.principalGeneration) revert UnsettledGeneration();
        uint256 beforeBalance = khype.balanceOf(address(this));
        uint256 beforeWalletBalance = khype.balanceOf(msg.sender);
        khype.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = khype.balanceOf(address(this)) - beforeBalance;
        // Exit and release require exact transfers. Never admit a taxed entry
        // into a position the same token behavior would prevent withdrawing.
        if (received != amount || khype.balanceOf(msg.sender) != beforeWalletBalance - amount) revert TransferMismatch();
        uint256 principalHype;
        uint256 reserve;
        (shares, principalHype, reserve) = _depositQuote(_state, received, rate);
        if (shares == 0 || shares < minPrincipalShares) revert MinimumNotMet();
        _state.totalPrincipalShares += shares;
        uint256 addedReserve = reserve - _state.principalReserveKHYPE;
        _state.principalReserveKHYPE = reserve;
        _state.accountedKHYPE += addedReserve;
        _quarantine(received - addedReserve);
        p.shares += shares;
        p.depositedKHYPE += received;
        _positions[msg.sender] = p;
        emit Deposited(msg.sender, received, principalHype, shares, rate);
    }

    function _quarantine(uint256 amount) private {
        if (amount == 0) return;
        _state.unassignedKHYPE += amount;
        emit RoundingQuarantined(amount);
    }

    function _payout(AccountingState memory s, uint256 shares)
        private
        pure
        returns (uint256)
    {
        if (shares == 0) return 0;
        return Math.mulDiv(s.principalReserveKHYPE, shares, s.totalPrincipalShares);
    }

    /// @notice What `redeem(shares)` would pay `wallet` now, and whether in kind
    /// (retired generation or rate not believed). Zero for shares it does not hold, and for the
    /// exits `redeem` refuses: no shares, a part worth nothing, or an active
    /// partial exit leaving less than `limits.minDepositKHYPE` withdrawable.
    function previewRedeem(address wallet, uint256 shares) external view returns (uint256 amountKHYPE, bool inKind) {
        Position memory p = _positions[wallet];
        YieldExitReserve reserve = exitReserve[p.generation];
        if (p.shares != 0 && address(reserve) != address(0)) return (shares <= p.shares ? reserve.preview(shares) : 0, true);
        (AccountingState memory s, uint256 rate, bool valid,, uint256 residual) = _project();
        if (p.shares != 0 && p.generation == _state.principalGeneration && residual != 0) {
            return (shares <= p.shares ? Math.mulDiv(residual, shares, _state.totalPrincipalShares) : 0, true);
        }
        if (p.generation != s.principalGeneration || shares > p.shares) return (0, !valid);
        amountKHYPE = _payout(s, shares);
        if (shares != 0 && shares < p.shares) {
            // Both quotes must meet the minimum: exit rounding can lower the
            // old quote, or artificially inflate a final share-wei's payout.
            uint256 remainderBefore = _payout(s, p.shares - shares);
            s.totalPrincipalShares -= shares;
            s.principalReserveKHYPE -= amountKHYPE;
            if (valid) s.principalReserveKHYPE = Math.min(s.principalReserveKHYPE, Math.mulDiv(s.totalPrincipalShares, WAD, rate, Math.Rounding.Ceil));
            if (Math.min(remainderBefore, _payout(s, p.shares - shares)) < limits.minDepositKHYPE) return (0, !valid);
        }
        return (amountKHYPE, !valid);
    }

    /// @notice `wallet`'s position projected to this block: shares (none in an
    /// ended generation without residual custody), its HYPE principal, what it would redeem at value or
    /// in kind, the rate and whether it is believed, and its deposit and
    /// redemption totals.
    function position(address wallet) external view returns (PositionView memory v) {
        (AccountingState memory s, uint256 rate, bool valid,, uint256 residual) = _project();
        Position memory p = _positions[wallet];
        YieldExitReserve reserve = exitReserve[p.generation];
        bool isRetired = p.shares != 0 && (address(reserve) != address(0) || (p.generation == _state.principalGeneration && residual != 0));
        if (isRetired) {
            return PositionView(p.shares, 0, 0, address(reserve) != address(0) ? reserve.preview(p.shares)
                : Math.mulDiv(residual, p.shares, _state.totalPrincipalShares), valid ? rate : 0, valid, p.depositedKHYPE, p.redeemedKHYPE, true);
        }
        uint256 shares = p.generation == s.principalGeneration ? p.shares : 0;
        v = PositionView({
            shares: shares,
            principalHype: Math.mulDiv(shares, s.principalIndex, RAY),
            equivalentKHYPE: valid ? _payout(s, shares) : 0,
            inKindKHYPE: !valid ? _payout(s, shares) : 0,
            rate: valid ? rate : 0,
            rateValid: valid,
            depositedKHYPE: p.depositedKHYPE,
            redeemedKHYPE: p.redeemedKHYPE,
            retired: false
        });
    }

    /// @notice Redeem `shares` for at least `minKHYPEOut` kHYPE: at today's
    /// rate when it is believed, pro rata from the reserve in kind when it is
    /// not. An active partial exit must leave at least `minDepositKHYPE` of
    /// withdrawable principal, avoiding deliberately created rounding-sized
    /// remainders. A full exit is always allowed, including after a loss takes
    /// the position below that minimum. The last share out ends the generation.
    function redeem(uint256 shares, uint256 minKHYPEOut) external nonReentrant returns (uint256 paid) {
        // Stored residual claims do not depend on today's accountant or on a
        // checkpoint of somebody else's active generation.
        Position memory prior = _positions[msg.sender];
        if (address(exitReserve[prior.generation]) != address(0)) return _redeemRetired(_position(msg.sender), shares, minKHYPEOut);
        (uint256 rate, bool valid) = _checkpoint(false);
        Position memory p = _position(msg.sender);
        if (p.generation != _state.principalGeneration) return _redeemRetired(p, shares, minKHYPEOut);
        if (shares == 0 || shares > p.shares) revert InvalidAmount();
        paid = _payout(_state, shares);
        if (paid < minKHYPEOut || (paid == 0 && shares != p.shares)) revert MinimumNotMet();
        uint256 remainderBefore = _payout(_state, p.shares - shares);
        uint256 oldLiability = _liability(_state);
        uint256 oldReserve = _state.principalReserveKHYPE;
        _state.totalPrincipalShares -= shares;
        uint256 liability = _liability(_state);
        uint256 reserve = oldReserve - paid;
        if (valid) reserve = Math.min(reserve, Math.mulDiv(_state.totalPrincipalShares, WAD, rate, Math.Rounding.Ceil));
        uint256 released = oldReserve - reserve;
        _state.principalReserveKHYPE = reserve;
        if (shares < p.shares && Math.min(remainderBefore, _payout(_state, p.shares - shares)) < limits.minDepositKHYPE) revert MinimumRemainder();
        _state.accountedKHYPE -= released;
        _quarantine(released - paid); // exit rounding is not newly earned staking yield
        p.shares -= shares;
        p.redeemedKHYPE += paid;
        _positions[msg.sender] = p;
        if (_state.totalPrincipalShares == 0) {
            generationYieldPerShare[_state.principalGeneration] = yieldPerShare;
            _state.principalIndex = RAY;
            ++_state.principalGeneration;
        }
        emit Redeemed(msg.sender, shares, oldLiability - liability, paid, !valid);
        if (paid != 0) {
            uint256 beforeBalance = khype.balanceOf(address(this));
            uint256 recipientBalance = khype.balanceOf(msg.sender);
            khype.safeTransfer(msg.sender, paid);
            if (
                beforeBalance - khype.balanceOf(address(this)) != paid
                    || khype.balanceOf(msg.sender) - recipientBalance != paid
            ) revert TransferMismatch();
        }
    }

    function _redeemRetired(Position memory p, uint256 shares, uint256 minKHYPEOut) private returns (uint256 paid) {
        if (shares == 0 || shares > p.shares) revert InvalidAmount();
        YieldExitReserve reserve = exitReserve[p.generation];
        paid = reserve.preview(shares);
        if (paid < minKHYPEOut || (paid == 0 && shares != p.shares)) revert MinimumNotMet();
        p.shares -= shares;
        p.redeemedKHYPE += paid;
        _positions[msg.sender] = p;
        if (reserve.redeem(msg.sender, shares) != paid) revert TransferMismatch();
        emit Redeemed(msg.sender, shares, 0, paid, true);
    }

    /// @notice Release only surplus to immutable custody, including after all exits.
    function release(uint256 maxAmountKHYPE) external nonReentrant returns (uint256 amount) {
        _checkpoint(true);
        uint256 epoch = block.timestamp / EPOCH_SECONDS;
        uint256 remaining = limits.maxEpochReleaseKHYPE - (releaseEpoch == epoch ? epochReleasedKHYPE : 0);
        amount = Math.min(maxAmountKHYPE, Math.min(_state.yieldBackingKHYPE, remaining));
        if (amount == 0) return 0;
        _state.yieldBackingKHYPE -= amount;
        _state.accountedKHYPE -= amount;
        retiredYieldKHYPE = _state.yieldBackingKHYPE;
        if (releaseEpoch != epoch) {
            releaseEpoch = epoch;
            epochReleasedKHYPE = 0;
        }
        epochReleasedKHYPE += amount;
        totalReleasedKHYPE += amount;
        uint256 beforeBalance = khype.balanceOf(address(this));
        uint256 destinationBalance = khype.balanceOf(yieldSink);
        khype.safeTransfer(yieldSink, amount);
        if (beforeBalance - khype.balanceOf(address(this)) != amount
            || khype.balanceOf(yieldSink) - destinationBalance != amount) revert TransferMismatch();
        emit YieldReleased(amount, epoch);
    }

    function _liability(AccountingState memory s) private pure returns (uint256) {
        return Math.mulDiv(s.totalPrincipalShares, s.principalIndex, RAY, Math.Rounding.Ceil);
    }

    function _wipePrincipal(AccountingState memory s) private pure {
        s.totalPrincipalShares = 0;
        s.principalIndex = RAY;
        ++s.principalGeneration;
    }

    function _projectState(AccountingState memory s, uint256 balance, uint256 rate, bool valid)
        private
        pure
        returns (AccountingState memory, uint256, uint256)
    {
        // Unassigned tokens absorb a custody deficit first. Any remaining
        // deficit is shared proportionally by principal and booked rewards.
        uint256 oldReserve = s.principalReserveKHYPE;
        if (balance >= s.accountedKHYPE) {
            s.unassignedKHYPE = balance - s.accountedKHYPE;
        } else {
            s.unassignedKHYPE = 0;
            s.principalReserveKHYPE = Math.mulDiv(oldReserve, balance, s.accountedKHYPE);
            s.accountedKHYPE = balance;
            s.yieldBackingKHYPE = balance - s.principalReserveKHYPE;
        }
        uint256 retired = s.yieldBackingKHYPE;

        if (!valid) {
            // No fabricated current HYPE valuation. A token deficit scales the
            // last recorded valuation; future rate recovery still belongs to
            // the principal tokens that survived.
            if (s.principalReserveKHYPE < oldReserve && s.totalPrincipalShares != 0) {
                s.principalIndex = Math.mulDiv(s.principalIndex, s.principalReserveKHYPE, oldReserve);
                if (s.principalIndex < MIN_INDEX) {
                    return _retire(s, retired);
                }
            }
            return (s, retired, 0);
        }

        uint256 backing = s.principalReserveKHYPE;
        // Each share targets one HYPE. A loss changes today's valuation, not
        // this target: recovery must restore holders before creating yield.
        uint256 reserve = Math.mulDiv(s.totalPrincipalShares, WAD, rate, Math.Rounding.Ceil);
        if (backing < reserve) {
            // Only value backing when it is insufficient. Then value is below
            // the capped liability; arbitrarily large surplus cannot overflow
            // a needless backing*rate valuation and block withdrawals.
            uint256 value = Math.mulDiv(backing, rate, WAD);
            s.principalIndex = Math.mulDiv(value, RAY, s.totalPrincipalShares);
            if (s.principalIndex < MIN_INDEX) return _retire(s, retired);
            reserve = backing;
        } else {
            s.principalIndex = RAY;
        }
        uint256 nextYield = backing - reserve + retired;
        if (nextYield > s.yieldBackingKHYPE && s.totalPrincipalShares == 0) {
            // Last-share/wipe rounding is not a new depositor's windfall.
            uint256 growth = nextYield - s.yieldBackingKHYPE;
            s.unassignedKHYPE += growth;
            s.accountedKHYPE -= growth;
            nextYield -= growth;
        }
        s.principalReserveKHYPE = reserve;
        s.yieldBackingKHYPE = nextYield;
        retired = s.yieldBackingKHYPE;
        return (s, retired, 0);
    }

    /// @dev Preserve ALL active backing, including when its HYPE value rounds
    /// to zero. The projection describes custody after the checkpoint's atomic
    /// transfer to a new reserve; it is not quarantined or released as yield.
    function _retire(AccountingState memory s, uint256 retired) private pure returns (AccountingState memory, uint256, uint256 residual) {
        residual = s.accountedKHYPE - retired;
        _wipePrincipal(s);
        s.accountedKHYPE = retired;
        s.principalReserveKHYPE = 0;
        s.yieldBackingKHYPE = retired;
        return (s, retired, residual);
    }
}
