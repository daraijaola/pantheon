// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal two-step ownership: privilege handoffs always name a counterparty
/// and complete only when the new key proves it can act (custody-rotation doctrine).
abstract contract TwoStepOwned {
    address public owner;
    address public pendingOwner;

    event OwnerUpdated(address indexed previousOwner, address indexed newOwner);
    event OwnerProposed(address indexed proposedOwner);

    error Unauthorized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address initialOwner) {
        // There is no recovery path for a zero owner; reject it before custody
        // and administrative entry points become permanently inaccessible.
        if (initialOwner == address(0)) revert Unauthorized();
        owner = initialOwner;
        emit OwnerUpdated(address(0), initialOwner);
    }

    /// @notice Propose `newOwner`; nothing moves until it accepts. The zero address cancels a pending proposal.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnerProposed(newOwner);
    }

    /// @notice The proposed owner takes the seat; the contract's own hook runs after.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        emit OwnerUpdated(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
        _afterOwnershipTransfer();
    }

    /// @dev CTO invalidates approvals on every reviewer rotation, including a
    /// later rotation back to an earlier wallet. The yield router and the staker
    /// distributor refuse a new owner that is their guardian (the router: or its
    /// executor). Every other owner has no hook.
    function _afterOwnershipTransfer() internal virtual {}
}
