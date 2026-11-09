// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

contract TokenTimelock {
    using SafeTransferLib for ERC20;

    ERC20 public immutable token;
    address public immutable beneficiary;
    uint64 public immutable releaseTime;

    error InvalidBeneficiary();
    error InvalidReleaseTime();
    error StillLocked();
    error NothingToRelease();

    event Released(uint256 amount);

    constructor(ERC20 token_, address beneficiary_, uint64 releaseTime_) {
        if (beneficiary_ == address(0)) revert InvalidBeneficiary();
        if (releaseTime_ <= block.timestamp) revert InvalidReleaseTime();

        token = token_;
        beneficiary = beneficiary_;
        releaseTime = releaseTime_;
    }

    function release() external {
        if (block.timestamp < releaseTime) revert StillLocked();

        uint256 amount = token.balanceOf(address(this));
        if (amount == 0) revert NothingToRelease();

        token.safeTransfer(beneficiary, amount);
        emit Released(amount);
    }
}
