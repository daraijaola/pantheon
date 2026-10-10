// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TwoStepOwned} from "../base/TwoStepOwned.sol";
import {Treasury} from "../Treasury.sol";
import {AscendYieldVault} from "./AscendYieldVault.sol";
import {StakingQuoteOracle} from "./StakingQuoteOracle.sol";
import {StakerDistributor} from "./StakerDistributor.sol";

interface IStakingSwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256);
}

interface IWrappedHype { function withdraw(uint256 amount) external; }
interface IKinetiqStaking { function stake() external payable; }

/// @notice Fixed routes and destinations for one protocol fee leg. The keeper
/// calls its StakingFeeTreasury, never a user deposit flow. Each execution has
/// an independent, fresh oracle floor, epoch budget and caller slippage floors.
/// Conversion failures revert atomically and leave fees in their treasury.
///
/// Both legs buy HYPE on the same fixed route. The stake leg stakes it with
/// Kinetiq and deposits the kHYPE as the protocol's own vault position. The
/// extra-yield leg pays the HYPE itself, unstaked, into the staker
/// distributor's current week: it never stakes
/// and never touches the vault, whose address it carries only so the launchpad
/// can require that both legs serve one vault.
/// Consumer: the protocol conversion keeper; receipts support custody reconciliation.
contract StakingFeeConverter is TwoStepOwned, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Route { address asset; bytes path; uint256 maxEpochInput; }
    /// @notice The venue every route sells on (the Uniswap V3 `SwapRouter` shape).
    IStakingSwapRouter public immutable router;
    /// @notice The feeds' value of an asset in HYPE: the floor under every sale.
    StakingQuoteOracle public immutable oracle;
    /// @notice The protocol's vault. The stake leg deposits here; the extra-yield leg only names it.
    AscendYieldVault public immutable vault;
    /// @notice Wrapped HYPE: what every route buys, unwrapped inside `convert`.
    address public immutable wrappedHype;
    /// @notice Kinetiq's staking entry, used by the stake leg alone.
    address public immutable stakingManager;
    /// @notice The one account a treasury lets run `convert`. Never the owner at deployment; fixed for this contract's life.
    address public immutable executor;
    /// @notice The only source allowed to convert. Created with this converter;
    /// the launchpad uses it as the fee leg's custody. No donor can consume its budget.
    StakingFeeTreasury public immutable treasury;
    /// @notice Where the extra-yield leg pays its HYPE; zero on the stake leg.
    StakerDistributor public immutable distributor;
    /// @dev The constructor's bounds, the budget's day, the deadline's reach, and the V3 path geometry.
    uint256 internal constant MAX_SLIPPAGE_BPS = 500;
    uint256 internal constant MAX_PRICE_AGE = 1 hours;
    uint256 internal constant BUDGET_EPOCH = 1 days;
    uint256 internal constant MAX_DEADLINE = 10 minutes;
    uint256 internal constant PATH_ADDRESS = 20;
    uint256 internal constant PATH_HOP = 23;
    /// @notice How far under the feeds' value a sale, and the stake leg's kHYPE, may land.
    uint256 public immutable maxSlippageBps;
    /// @notice The oldest feed observation a conversion accepts, in seconds.
    uint256 public immutable maxPriceAge;
    /// @notice Executed purchases only; consumed by the public stats page.
    uint256 public totalHypeBought;
    /// @notice kHYPE the stake leg received and deposited, summed. Zero on the extra-yield leg.
    uint256 public totalKHYPEReceived;
    /// @notice The fixed path from each asset to wrapped HYPE; empty for an asset with no route.
    mapping(address => bytes) public paths;
    /// @notice The most of an asset one day may convert.
    mapping(address => uint256) public maxEpochInput;
    /// @notice What an asset's route spent in the last day it converted. It is not reset when a day
    /// ends: read `remainingInput` for the budget left today.
    mapping(address => uint256) public spentInEpoch;
    mapping(address => uint256) private epochOf;

    error InvalidConversion();
    error StalePrice();
    error OutputTooLow();
    error BudgetExceeded();
    event Converted(address indexed source, address indexed asset, uint256 amountIn,
        uint256 hypeBought, uint256 khypeReceived, bool extraYield, uint256 principalShares);
    event ProtocolRedeemed(uint256 shares, uint256 khype, address indexed recipient);

    /// @param distributor_ zero for the stake leg (it stakes into `vault_`); the distributor for the extra-yield leg
    /// @param routes one per asset: the V3 path from the asset to wrapped HYPE (20-byte addresses, 3-byte fees) and its daily budget
    constructor(address owner_, address executor_, address router_, address oracle_,
        address vault_, address wrappedHype_, address stakingManager_, address distributor_,
        uint256 maxSlippageBps_, uint256 maxPriceAge_, Route[] memory routes) TwoStepOwned(owner_) {
        if (executor_ == address(0) || executor_ == owner_ || router_.code.length == 0
            || oracle_.code.length == 0 || vault_.code.length == 0 || wrappedHype_.code.length == 0
            || stakingManager_.code.length == 0 || (distributor_ != address(0) && distributor_.code.length == 0)
            || maxSlippageBps_ > MAX_SLIPPAGE_BPS
            || maxPriceAge_ == 0 || maxPriceAge_ > MAX_PRICE_AGE || routes.length == 0) revert InvalidConversion();
        executor = executor_;
        router = IStakingSwapRouter(router_);
        oracle = StakingQuoteOracle(oracle_);
        vault = AscendYieldVault(vault_);
        wrappedHype = wrappedHype_;
        stakingManager = stakingManager_;
        distributor = StakerDistributor(distributor_);
        maxSlippageBps = maxSlippageBps_;
        maxPriceAge = maxPriceAge_;
        for (uint256 i; i < routes.length; ++i) {
            Route memory r = routes[i];
            bytes memory path = r.path;
            if (r.asset.code.length == 0 || r.maxEpochInput == 0 || paths[r.asset].length != 0
                || path.length < PATH_ADDRESS + PATH_HOP || (path.length - PATH_ADDRESS) % PATH_HOP != 0) revert InvalidConversion();
            address first;
            address last;
            assembly ("memory-safe") {
                first := shr(96, mload(add(path, 32)))
                last := shr(96, mload(add(add(path, 32), sub(mload(path), 20))))
            }
            if (first != r.asset || last != wrappedHype_ || r.asset == wrappedHype_) revert InvalidConversion();
            paths[r.asset] = path;
            maxEpochInput[r.asset] = r.maxEpochInput;
        }
        treasury = new StakingFeeTreasury(owner_, this);
    }

    /// @dev Only the wrapper's `withdraw` pays native HYPE here, inside `convert`.
    receive() external payable {
        if (msg.sender != wrappedHype) revert InvalidConversion();
    }

    /// @notice True on the extra-yield leg: exactly when `distributor` is set.
    function extraYield() public view returns (bool) {
        return address(distributor) != address(0);
    }

    /// @notice Keeper reads the remaining input budget before simulating.
    function remainingInput(address asset) external view returns (uint256) {
        return maxEpochInput[asset] - (epochOf[asset] == block.timestamp / BUDGET_EPOCH ? spentInEpoch[asset] : 0);
    }

    /// @notice Sell `amount` of `asset` for HYPE on the fixed path (at least
    /// `minHype`, raised to the feeds' value less `maxSlippageBps`), then stake
    /// it into the protocol's vault (the stake leg) or pay it into the
    /// distributor's current week (the extra-yield leg). Only the bound treasury,
    /// inside the asset's daily budget; `deadline` at most ten minutes ahead.
    /// @param minKHYPE the stake leg's floor on kHYPE received, never zero;
    /// the extra-yield leg receives none and takes exactly zero
    function convert(address asset, uint256 amount, uint256 minHype, uint256 minKHYPE, uint256 deadline)
        external nonReentrant returns (uint256 received)
    {
        // The treasury authenticates the executor. No other source can consume
        // its daily budget or grow the protocol position through this entry.
        if (msg.sender != address(treasury)) revert Unauthorized();
        if (amount == 0 || paths[asset].length == 0 || deadline < block.timestamp
            || deadline > block.timestamp + MAX_DEADLINE || minHype == 0 || (minKHYPE == 0) != extraYield()) revert InvalidConversion();
        uint256 epoch = block.timestamp / BUDGET_EPOCH;
        uint256 spent = epochOf[asset] == epoch ? spentInEpoch[asset] : 0;
        if (amount > maxEpochInput[asset] - spent) revert BudgetExceeded();
        (uint256 expected, uint256 observedAt) = oracle.quoteHype(asset, amount);
        if (expected == 0 || observedAt == 0 || observedAt > block.timestamp
            || block.timestamp - observedAt > maxPriceAge) revert StalePrice();
        uint256 floor = Math.mulDiv(expected, 10_000 - maxSlippageBps, 10_000);
        minHype = Math.max(minHype, floor);
        uint256 rate;
        if (!extraYield()) {
            bool valid;
            (rate, valid) = vault.currentRate();
            if (!valid) revert InvalidConversion();
        }
        epochOf[asset] = epoch;
        spentInEpoch[asset] = spent + amount;
        uint256 inputBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(asset).balanceOf(address(this)) != inputBefore + amount) revert InvalidConversion();
        uint256 beforeWrapped = IERC20(wrappedHype).balanceOf(address(this));
        IERC20(asset).forceApprove(address(router), amount);
        router.exactInput(IStakingSwapRouter.ExactInputParams(paths[asset], address(this), deadline, amount, minHype));
        IERC20(asset).forceApprove(address(router), 0);
        if (IERC20(asset).balanceOf(address(this)) != inputBefore) revert InvalidConversion();
        uint256 bought = IERC20(wrappedHype).balanceOf(address(this)) - beforeWrapped;
        if (bought < minHype) revert OutputTooLow();
        uint256 nativeBefore = address(this).balance;
        IWrappedHype(wrappedHype).withdraw(bought);
        if (address(this).balance != nativeBefore + bought) revert InvalidConversion();
        uint256 shares;
        if (extraYield()) {
            // The week is credited with at least what was paid (more only when
            // unaccounted HYPE was already waiting there to be absorbed).
            if (distributor.fund{value: bought}(address(0), bought) < bought) revert InvalidConversion();
        } else {
            IERC20 khype = vault.khype();
            uint256 beforeKHYPE = khype.balanceOf(address(this));
            IKinetiqStaking(stakingManager).stake{value: bought}();
            received = khype.balanceOf(address(this)) - beforeKHYPE;
            uint256 stakeFloor = Math.mulDiv(Math.mulDiv(bought, 1e18, rate), 10_000 - maxSlippageBps, 10_000);
            if (received < minKHYPE || received < stakeFloor || address(this).balance != nativeBefore) revert OutputTooLow();
            uint256 vaultBefore = khype.balanceOf(address(vault));
            khype.forceApprove(address(vault), received);
            shares = vault.deposit(received, 1);
            khype.forceApprove(address(vault), 0);
            if (khype.balanceOf(address(this)) != beforeKHYPE
                || khype.balanceOf(address(vault)) != vaultBefore + received) revert InvalidConversion();
            totalKHYPEReceived += received;
        }
        totalHypeBought += bought;
        emit Converted(msg.sender, asset, amount, bought, received, extraYield(), shares);
    }

    /// @notice The owner redeems only the protocol's own shares, including for
    /// listing standby. User shares cannot be withdrawn, and the extra-yield
    /// leg holds nothing: its HYPE is in the distributor before `convert` returns.
    function redeemProtocol(uint256 shares, uint256 minKHYPE) external onlyOwner nonReentrant {
        if (extraYield()) revert InvalidConversion();
        uint256 amount = vault.redeem(shares, minKHYPE);
        vault.khype().safeTransfer(owner, amount);
        emit ProtocolRedeemed(shares, amount, owner);
    }
}

/// @notice One of the two automated fee custody legs. Owner sweeps retain the
/// existing Treasury boundary. The separate keeper can only use its fixed
/// converter; it cannot select a recipient, venue or route. No swap runs in a hook.
contract StakingFeeTreasury is Treasury {
    using SafeERC20 for IERC20;
    StakingFeeConverter public immutable converter;

    constructor(address owner_, StakingFeeConverter converter_) Treasury(owner_) {
        // The converter creates its treasury in its constructor, before its
        // runtime exists. A third party cannot create another source for it.
        if (msg.sender != address(converter_)) revert Unauthorized();
        converter = converter_;
    }

    /// @notice The converter's executor converts `amount` of this treasury's `asset` through the
    /// fixed converter, with that call's floors and deadline. The allowance is given for the call and withdrawn after it.
    function convert(address asset, uint256 amount, uint256 minHype, uint256 minKHYPE, uint256 deadline) external {
        if (msg.sender != converter.executor()) revert Unauthorized();
        IERC20(asset).forceApprove(address(converter), amount);
        converter.convert(asset, amount, minHype, minKHYPE, deadline);
        IERC20(asset).forceApprove(address(converter), 0);
        emit Swept(asset, address(converter), amount);
    }
}
