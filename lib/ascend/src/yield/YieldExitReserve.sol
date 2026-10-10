// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice In-kind custody for one ended vault generation. Only its creating
/// vault can settle a holder's shares, to that holder. No owner, admission,
/// yield release or sweep. Consumers: vault redemption/previews and reconciler.
/// Separate custody keeps later generations independent of abandoned claims.
contract YieldExitReserve {
    using SafeERC20 for IERC20;

    IERC20 public immutable khype;
    address public immutable vault;
    uint256 public shares;
    uint256 public accountedKHYPE;

    error Unauthorized();
    error InvalidAmount();
    error TransferMismatch();

    constructor(IERC20 token, uint256 shares_, uint256 backing) {
        khype = token;
        vault = msg.sender;
        shares = shares_;
        accountedKHYPE = backing;
    }

    /// @notice Donations never increase claims. Custody losses reduce the
    /// remaining holders' backing pro rata, as observed at each redemption.
    function preview(uint256 amountShares) public view returns (uint256) {
        if (amountShares == 0 || amountShares > shares) return 0;
        return Math.mulDiv(Math.min(accountedKHYPE, khype.balanceOf(address(this))), amountShares, shares);
    }

    function redeem(address holder, uint256 amountShares) external returns (uint256 paid) {
        if (msg.sender != vault) revert Unauthorized();
        if (amountShares == 0 || amountShares > shares) revert InvalidAmount();
        uint256 backing = Math.min(accountedKHYPE, khype.balanceOf(address(this)));
        paid = Math.mulDiv(backing, amountShares, shares);
        shares -= amountShares;
        accountedKHYPE = backing - paid;
        if (paid != 0) {
            uint256 beforeBalance = khype.balanceOf(address(this));
            uint256 beforeHolder = khype.balanceOf(holder);
            khype.safeTransfer(holder, paid);
            if (beforeBalance - khype.balanceOf(address(this)) != paid || khype.balanceOf(holder) - beforeHolder != paid) revert TransferMismatch();
        }
    }
}
