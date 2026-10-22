// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {LaunchpadKey} from "ascend/libraries/LaunchpadKey.sol";
import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solmate/src/utils/ReentrancyGuard.sol";

/// Anything that takes a reward stream (PantheonStaking).
interface IRewardSink {
    function notifyReward(address token, uint256 amount) external;
}

/// @title CovenantRouter
/// @notice Holds the creator role of one Ascend pool and gives the creator's fees fixed jobs.
/// On Ascend a coin's creator earns half of every 1% trade fee, in two legs: the coin itself
/// (from sells) and the quote, USDC (from buys). This contract is that creator. Anyone may call
/// `run()`: it collects and claims the fees, then splits each leg across the jobs it was given
/// when it was created, for example PNTH's sells burned and its USDC sent to the basket.
///
/// It has no owner, no admin, no upgrade, no sweep and no way to hand the creator role on.
/// Its jobs are written once, in the constructor, and can never change.
contract CovenantRouter is ReentrancyGuard {
    using SafeTransferLib for ERC20;
    using PoolIdLibrary for PoolKey;

    /// PAY: send to `target`. BURN: send to the burn sink, where nothing can move it again.
    /// INDEX: send to the basket vault (`target`). STREAM: stream to stakers (`target` takes it).
    enum Job {
        PAY,
        BURN,
        INDEX,
        STREAM
    }

    struct Leg {
        Job job;
        uint16 bps;
        address target;
    }

    uint8 public constant TOKEN_SIDE = 0;
    uint8 public constant QUOTE_SIDE = 1;
    uint256 public constant MAX_LEGS = 6;

    IAscendLaunchpad public immutable launchpad;
    PoolId public immutable poolId;
    ERC20 public immutable token;
    ERC20 public immutable quote;
    address public immutable burnSink;

    Leg[][2] internal _legs;
    /// Allocated to a leg but not yet delivered (a job that failed stays pending for the next run).
    uint256[][2] public pending;
    /// Sum of `pending` per side: what of this contract's balance is already spoken for.
    uint256[2] public accounted;
    uint256 public runCount;

    event Run(
        uint256 indexed runId, bool collected, bool claimedToken, bool claimedQuote, uint256 newToken, uint256 newQuote
    );
    event LegExecuted(
        uint256 indexed runId, uint8 indexed side, uint256 indexed leg, Job job, address to, uint256 amount
    );
    event LegDeferred(uint256 indexed runId, uint8 indexed side, uint256 indexed leg, uint256 amount);

    error BadPolicy();
    error WrongPool();
    error OnlySelf();

    constructor(
        IAscendLaunchpad launchpad_,
        PoolId poolId_,
        address token_,
        address quote_,
        address burnSink_,
        Leg[] memory tokenLegs,
        Leg[] memory quoteLegs
    ) {
        // The pair must be the pool: an Ascend pool's id is a pure function of its token and quote.
        if (
            PoolId.unwrap(
                    LaunchpadKey.keyOf(token_, quote_, address(launchpad_), address(launchpad_.poolManager())).toId()
                ) != PoolId.unwrap(poolId_)
        ) revert WrongPool();
        if (burnSink_ == address(0)) revert BadPolicy();
        launchpad = launchpad_;
        poolId = poolId_;
        token = ERC20(token_);
        quote = ERC20(quote_);
        burnSink = burnSink_;
        _store(TOKEN_SIDE, tokenLegs);
        _store(QUOTE_SIDE, quoteLegs);
        // Take the creator role. The current creator must have offered it to this address first.
        launchpad_.acceptCreator(poolId_);
    }

    /// @notice Collect and claim this pool's creator fees, then deliver every leg. Permissionless.
    /// Each Ascend call and each job is isolated: one that fails is skipped and its share stays
    /// pending, so a stuck leg can never block the others.
    function run() external nonReentrant returns (uint256 newToken, uint256 newQuote) {
        uint256 id = ++runCount;
        bool okCollect;
        bool okToken;
        bool okQuote;
        try launchpad.collect(poolId) {
            okCollect = true;
        } catch {}
        try launchpad.claimToken(poolId) {
            okToken = true;
        } catch {}
        try launchpad.claimQuote(poolId) {
            okQuote = true;
        } catch {}

        newToken = _allocate(TOKEN_SIDE, token);
        newQuote = _allocate(QUOTE_SIDE, quote);
        _deliver(id, TOKEN_SIDE);
        _deliver(id, QUOTE_SIDE);
        emit Run(id, okCollect, okToken, okQuote, newToken, newQuote);
    }

    /// @dev One job, called by `run` on itself so a revert can be caught without losing the rest.
    function deliverLeg(uint8 side, uint256 i, uint256 amount) external {
        if (msg.sender != address(this)) revert OnlySelf();
        Leg memory l = _legs[side][i];
        ERC20 asset = side == TOKEN_SIDE ? token : quote;
        if (l.job == Job.BURN) {
            asset.safeTransfer(burnSink, amount);
        } else if (l.job == Job.STREAM) {
            asset.safeApprove(l.target, amount);
            IRewardSink(l.target).notifyReward(address(asset), amount);
            asset.safeApprove(l.target, 0);
        } else {
            asset.safeTransfer(l.target, amount); // PAY, INDEX
        }
    }

    function legs(uint8 side) external view returns (Leg[] memory) {
        return _legs[side];
    }

    function pendingOf(uint8 side) external view returns (uint256[] memory) {
        return pending[side];
    }

    // ------------------------------------------------------------------ internal

    function _store(uint8 side, Leg[] memory list) internal {
        uint256 n = list.length;
        if (n == 0 || n > MAX_LEGS) revert BadPolicy();
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            Leg memory l = list[i];
            if (l.bps == 0) revert BadPolicy();
            // What each side may do: the coin can be paid, burned or streamed; the quote can be paid,
            // sent to the basket or streamed.
            if (side == TOKEN_SIDE && l.job == Job.INDEX) revert BadPolicy();
            if (side == QUOTE_SIDE && l.job == Job.BURN) revert BadPolicy();
            if (l.job != Job.BURN && l.target == address(0)) revert BadPolicy();
            sum += l.bps;
            _legs[side].push(l);
            pending[side].push(0);
        }
        if (sum != 10_000) revert BadPolicy();
    }

    /// New money on a side is whatever this contract holds beyond what is already pending.
    /// It is split by each leg's share; the last leg takes the rounding remainder.
    function _allocate(uint8 side, ERC20 asset) internal returns (uint256 fresh) {
        fresh = asset.balanceOf(address(this)) - accounted[side];
        if (fresh == 0) return 0;
        Leg[] storage list = _legs[side];
        uint256 n = list.length;
        uint256 given;
        for (uint256 i; i < n; ++i) {
            uint256 part = i == n - 1 ? fresh - given : (fresh * list[i].bps) / 10_000;
            pending[side][i] += part;
            given += part;
        }
        accounted[side] += fresh;
    }

    function _deliver(uint256 id, uint8 side) internal {
        uint256 n = _legs[side].length;
        for (uint256 i; i < n; ++i) {
            uint256 amount = pending[side][i];
            if (amount == 0) continue;
            try this.deliverLeg(side, i, amount) {
                pending[side][i] = 0;
                accounted[side] -= amount;
                Leg memory l = _legs[side][i];
                emit LegExecuted(id, side, i, l.job, l.job == Job.BURN ? burnSink : l.target, amount);
            } catch {
                emit LegDeferred(id, side, i, amount);
            }
        }
    }
}
