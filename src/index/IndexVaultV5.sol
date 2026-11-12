// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solmate/src/utils/ReentrancyGuard.sol";
import {AscendSwapV5} from "../common/AscendSwapV5.sol";
import {AscendV5Key, V5PoolKey, IV5PoolManager, IV5StateView, ICreatorSeatV5} from "../common/AscendV5.sol";
import {ConstituentRegistry} from "./ConstituentRegistry.sol";
import {IStakingRewards} from "./IndexVault.sol";

/// @notice Ownerless Ascend v4 basket. Only fixed-destination seat claims, guarded buys and reward streams.
contract IndexVaultV5 is AscendSwapV5, ReentrancyGuard {
    using SafeTransferLib for ERC20;

    uint256 public constant BAND_BPS = 500;
    uint256 public constant BREAKER_BPS = 2_000;
    IAscendLaunchpad public immutable launchpad;
    IV5StateView public immutable stateView;
    ConstituentRegistry public immutable registry;
    IStakingRewards public immutable staking;
    ICreatorSeatV5 public immutable seat;
    ERC20 public immutable quote;
    uint256 public immutable maxStale;
    mapping(address => uint160) public lastEma;
    uint256 public cursor;

    enum Skip {
        NONE,
        NO_AVERAGE,
        STALE_AVERAGE,
        BREAKER,
        PRICE_OUT_OF_BAND,
        NOTHING_TO_SPEND
    }

    event BasketBuy(address indexed token, uint256 quoteIn, uint256 tokensOut, uint160 emaSqrt, uint160 spotSqrt);
    event BasketSkip(address indexed token, Skip reason);
    event Streamed(address indexed token, uint256 amount);
    event StreamFailed(address indexed token, uint256 amount);
    event FeesClaimed(uint256 amount);

    error QuoteIsBudget();
    error WrongSeat();

    constructor(
        IAscendLaunchpad launchpad_,
        IV5StateView stateView_,
        ConstituentRegistry registry_,
        IStakingRewards staking_,
        ICreatorSeatV5 seat_,
        uint256 maxStale_
    ) AscendSwapV5(IV5PoolManager(address(launchpad_.poolManager()))) {
        require(
            maxStale_ > 0 && maxStale_ <= type(uint40).max && address(seat_) != address(0),
            "invalid vault configuration"
        );
        launchpad = launchpad_;
        stateView = stateView_;
        registry = registry_;
        staking = staking_;
        seat = seat_;
        quote = ERC20(registry_.baseQuote());
        maxStale = maxStale_;
    }

    /// @notice Harvest escrow proceeds into the seat and pull slot 1's USDC to this vault.
    function claimFees() external nonReentrant returns (uint256 amount) {
        (address payee, uint16 bps,,) = seat.slot(1);
        if (payee != address(this) || bps != 8500 || seat.quote() != address(quote)) revert WrongSeat();
        seat.harvest();
        amount = seat.claim(1, false);
        emit FeesClaimed(amount);
    }

    function rebalance(uint256 k) external nonReentrant {
        uint256 budget = quote.balanceOf(address(this));
        if (budget == 0) return;
        ConstituentRegistry.Constituent[] memory list = registry.active();
        uint256 n = list.length;
        if (n == 0) {
            _stream(quote, budget);
            return;
        }
        if (k == 0 || k > n) k = n;
        uint256 start = cursor % n;
        for (uint256 j; j < k; ++j) {
            _buy(list[(start + j) % n], budget);
        }
        cursor = (start + k) % n;
    }

    function _buy(ConstituentRegistry.Constituent memory c, uint256 budget) internal {
        uint256 spend = budget * c.weightBps / 10_000;
        if (spend > c.perRunCap) spend = c.perRunCap;
        uint256 have = quote.balanceOf(address(this));
        if (spend > have) spend = have;
        if (spend == 0) return _skip(c.token, Skip.NOTHING_TO_SPEND);
        uint160 ema = launchpad.emaSqrtPrice(c.poolId);
        if (ema == 0) return _skip(c.token, Skip.NO_AVERAGE);
        if (block.timestamp > uint256(launchpad.emaUpdatedAt(c.poolId)) + maxStale) {
            return _skip(c.token, Skip.STALE_AVERAGE);
        }
        uint160 last = lastEma[c.token];
        lastEma[c.token] = ema;
        if (last != 0 && _diffBps(ema, last) > BREAKER_BPS / 2) return _skip(c.token, Skip.BREAKER);
        V5PoolKey memory key = AscendV5Key.keyOf(c.token, address(quote), address(launchpad));
        bool zeroForOne = key.currency0 == address(quote);
        uint256 adjusted = uint256(ema) * (zeroForOne ? 20_000 - BAND_BPS : 20_000 + BAND_BPS) / 20_000;
        if (adjusted <= TickMath.MIN_SQRT_RATIO) adjusted = TickMath.MIN_SQRT_RATIO + 1;
        if (adjusted >= TickMath.MAX_SQRT_RATIO) adjusted = TickMath.MAX_SQRT_RATIO - 1;
        uint160 limit = uint160(adjusted);
        (uint160 spot,,,) = stateView.getSlot0(PoolId.unwrap(c.poolId));
        if (zeroForOne ? spot <= limit : spot >= limit) return _skip(c.token, Skip.PRICE_OUT_OF_BAND);
        (uint256 spent, uint256 out) = _swapExactIn(key, zeroForOne, spend, limit, address(this));
        emit BasketBuy(c.token, spent, out, ema, spot);
        if (out > 0) _stream(ERC20(c.token), out);
    }

    function flush(address token) external nonReentrant {
        if (token == address(quote)) revert QuoteIsBudget();
        uint256 amount = ERC20(token).balanceOf(address(this));
        if (amount > 0) _stream(ERC20(token), amount);
    }

    function _stream(ERC20 asset, uint256 amount) internal {
        asset.safeApprove(address(staking), amount);
        try staking.notifyReward(address(asset), amount) {
            emit Streamed(address(asset), amount);
        } catch {
            emit StreamFailed(address(asset), amount);
        }
        asset.safeApprove(address(staking), 0);
    }

    function _skip(address token, Skip reason) internal {
        emit BasketSkip(token, reason);
    }

    function _diffBps(uint160 a, uint160 b) internal pure returns (uint256) {
        uint256 difference = a > b ? uint256(a) - b : uint256(b) - a;
        return difference * 10_000 / b;
    }
}
