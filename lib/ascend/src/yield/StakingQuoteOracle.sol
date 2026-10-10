// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// AggregatorV3 interface: https://docs.chain.link/data-feeds/api-reference
interface IStakingPriceFeed {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice Independent USD feeds establish the minimum acceptable HYPE output.
/// Feed identities are fixed at construction. An invalid input is refused
/// here: an answer that is not positive, an observation never made or ahead
/// of the clock, more decimals than the bound. Age is not judged here: each
/// quote reports the older of its two observations, and each consumer
/// (StakingFeeConverter, YieldRouter) refuses one older than its own bound.
contract StakingQuoteOracle {
    struct Feed { address asset; address usdFeed; }
    /// @notice The HYPE/USD feed every quote divides or multiplies by.
    address public immutable hypeUsdFeed;
    /// @notice Each priced asset's USD feed; zero for an asset this oracle does not price.
    mapping(address => address) public usdFeeds;
    /// @notice One whole unit of each priced asset, in its own decimals.
    mapping(address => uint256) public assetScale;
    error InvalidFeed();
    /// @dev A feed with more than 18 decimals cannot be scaled up to 18; an asset with more than 36 would overflow the scale.
    uint8 internal constant MAX_FEED_DECIMALS = 18;
    uint8 internal constant MAX_ASSET_DECIMALS = 36;
    /// @notice Binds the HYPE/USD feed and one USD feed per asset; every feed must answer now.
    constructor(address hypeUsdFeed_, Feed[] memory feeds) {
        if (hypeUsdFeed_.code.length == 0 || feeds.length == 0) revert InvalidFeed();
        hypeUsdFeed = hypeUsdFeed_;
        _price(hypeUsdFeed_);
        for (uint256 i; i < feeds.length; ++i) {
            Feed memory f = feeds[i];
            if (f.asset.code.length == 0 || f.usdFeed.code.length == 0 || usdFeeds[f.asset] != address(0)) revert InvalidFeed();
            uint8 decimals = IERC20Metadata(f.asset).decimals();
            if (decimals > MAX_ASSET_DECIMALS) revert InvalidFeed();
            _price(f.usdFeed);
            usdFeeds[f.asset] = f.usdFeed;
            assetScale[f.asset] = 10 ** decimals;
        }
    }
    /// @dev A feed's latest answer in 18-decimal USD, and when it was observed.
    /// Refused: a feed over 18 decimals, an answer at or under zero, an observation
    /// never made or made in the future. `answeredInRound` is not read: Chainlink
    /// deprecated it and adapters may return zero. The consumer applies its own
    /// maximum age; a min or max answer bound is a question for the mainnet feeds
    /// (D26), not a constant here (round 7, R7-10).
    function _price(address feed) private view returns (uint256 value, uint256 observedAt) {
        uint8 decimals = IStakingPriceFeed(feed).decimals();
        (, int256 answer,, uint256 updatedAt,) = IStakingPriceFeed(feed).latestRoundData();
        if (decimals > MAX_FEED_DECIMALS || answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) revert InvalidFeed();
        value = uint256(answer) * 10 ** (18 - decimals);
        observedAt = updatedAt;
    }
    /// @dev Both prices in 18-decimal USD and the older of their two observations.
    function _prices(address asset) private view returns (uint256 quoteUsd, uint256 hypeUsd, uint256 observedAt) {
        address feed = usdFeeds[asset];
        if (feed == address(0)) revert InvalidFeed();
        uint256 quoteAt;
        uint256 hypeAt;
        (quoteUsd, quoteAt) = _price(feed);
        (hypeUsd, hypeAt) = _price(hypeUsdFeed);
        observedAt = Math.min(quoteAt, hypeAt);
    }
    /// @notice The HYPE `amount` of `asset` is worth by the two feeds, and the older of their observations.
    function quoteHype(address asset, uint256 amount) external view returns (uint256 hype, uint256 observedAt) {
        uint256 quoteUsd;
        uint256 hypeUsd;
        (quoteUsd, hypeUsd, observedAt) = _prices(asset);
        uint256 usdValue = Math.mulDiv(amount, quoteUsd, assetScale[asset]);
        hype = Math.mulDiv(usdValue, 1e18, hypeUsd);
    }
    /// @notice The inverse of `quoteHype`: the amount of `asset` that `hype`
    /// wei of HYPE is worth. Consumer: YieldRouter, as the floor on what a
    /// sale of released kHYPE must return in the purchase's quote.
    function quoteAsset(address asset, uint256 hype) external view returns (uint256 amount, uint256 observedAt) {
        uint256 quoteUsd;
        uint256 hypeUsd;
        (quoteUsd, hypeUsd, observedAt) = _prices(asset);
        uint256 usdValue = Math.mulDiv(hype, hypeUsd, 1e18);
        amount = Math.mulDiv(usdValue, assetScale[asset], quoteUsd);
    }
}
