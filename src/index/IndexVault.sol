// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {LaunchpadKey} from "ascend/libraries/LaunchpadKey.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solmate/src/utils/ReentrancyGuard.sol";
import {AscendSwap} from "../common/AscendSwap.sol";
import {ConstituentRegistry} from "./ConstituentRegistry.sol";

interface IStakingRewards {
    function notifyReward(address token, uint256 amount) external;
}

/// @title IndexVault
/// @notice The basket. It receives the USDC half of PNTH's creator fees (from Covenant) and,
/// whenever anyone calls `rebalance`, buys the active coins by weight and streams what it bought
/// to PNTH stakers. It never holds coins for itself and has no owner.
///
/// Price guard: a buy may not push a coin's price more than BAND_BPS above Ascend's own moving
/// average of that pool (`emaSqrtPrice`), the same 5% band Ascend's own buyback trusts. If the
/// price is already outside the band, or the average jumped more than BREAKER_BPS since our last
/// buy, or the average is too old, that coin is skipped this run and its USDC waits. A per-run cap
/// per coin keeps each buy small next to the pool, which bounds what a manipulator could gain.
contract IndexVault is AscendSwap, ReentrancyGuard {
    using SafeTransferLib for ERC20;

    /// ±5% in price around the average (±2.5% in the square-root price the pools use): Ascend's
    /// own FILL_BAND_BPS, the band its buyback fills inside.
    uint256 public constant BAND_BPS = 500;
    /// A move of more than ~20% in price since our last buy pauses that coin for one run.
    uint256 public constant BREAKER_BPS = 2_000;

    IAscendLaunchpad public immutable launchpad;
    ConstituentRegistry public immutable registry;
    IStakingRewards public immutable staking;
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

    constructor(IAscendLaunchpad launchpad_, ConstituentRegistry registry_, IStakingRewards staking_, uint256 maxStale_)
        AscendSwap(launchpad_.vault(), launchpad_.poolManager())
    {
        launchpad = launchpad_;
        registry = registry_;
        staking = staking_;
        quote = ERC20(registry_.baseQuote());
        maxStale = maxStale_;
    }

    /// @notice Buy the next `k` coins of the basket (round-robin) with this vault's USDC.
    /// Permissionless and unpaid. With no active list yet, the USDC itself streams to stakers.
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
        uint256 spend = (budget * c.weightBps) / 10_000;
        if (spend > c.perRunCap) spend = c.perRunCap;
        uint256 have = quote.balanceOf(address(this));
        if (spend > have) spend = have;
        if (spend == 0) {
            _skip(c.token, Skip.NOTHING_TO_SPEND);
            return;
        }

        uint160 ema = launchpad.emaSqrtPrice(c.poolId);
        if (ema == 0) {
            _skip(c.token, Skip.NO_AVERAGE);
            return;
        }
        if (block.timestamp > uint256(launchpad.emaUpdatedAt(c.poolId)) + maxStale) {
            _skip(c.token, Skip.STALE_AVERAGE);
            return;
        }
        uint160 last = lastEma[c.token];
        lastEma[c.token] = ema;
        // sqrt-price moved by more than half the breaker ≈ price moved by more than the breaker
        if (last != 0 && _diffBps(ema, last) > BREAKER_BPS / 2) {
            _skip(c.token, Skip.BREAKER);
            return;
        }

        PoolKey memory key = LaunchpadKey.keyOf(c.token, address(quote), address(launchpad), address(poolManager));
        // Buying the coin = paying USDC. If USDC is currency0 we sell currency0 and the price falls.
        bool zeroForOne = Currency.unwrap(key.currency0) == address(quote);
        uint160 limit = zeroForOne
            ? uint160((uint256(ema) * (20_000 - BAND_BPS)) / 20_000)
            : uint160((uint256(ema) * (20_000 + BAND_BPS)) / 20_000);
        (uint160 spot,,,) = poolManager.getSlot0(c.poolId);
        if (zeroForOne ? spot <= limit : spot >= limit) {
            _skip(c.token, Skip.PRICE_OUT_OF_BAND);
            return;
        }

        (uint256 spent, uint256 out) = _swapExactIn(key, zeroForOne, spend, limit, address(this));
        emit BasketBuy(c.token, spent, out, ema, spot);
        if (out > 0) _stream(ERC20(c.token), out);
    }

    function _stream(ERC20 asset, uint256 amount) internal {
        asset.safeApprove(address(staking), amount);
        staking.notifyReward(address(asset), amount);
        asset.safeApprove(address(staking), 0);
        emit Streamed(address(asset), amount);
    }

    function _skip(address token, Skip reason) internal {
        emit BasketSkip(token, reason);
    }

    function _diffBps(uint160 a, uint160 b) internal pure returns (uint256) {
        uint256 d = a > b ? uint256(a) - uint256(b) : uint256(b) - uint256(a);
        return (d * 10_000) / uint256(b);
    }
}
