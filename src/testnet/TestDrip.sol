// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

/// Testnet only: free PNTH for people trying PANTHEON when its Ascend pool is sold out (free test USDC
/// lets anyone buy the whole supply). Each wallet can claim once. No owner: what it holds can only leave
/// as claims.
contract TestDrip {
    using SafeTransferLib for ERC20;

    ERC20 public immutable token;
    uint256 public immutable amount;
    mapping(address => bool) public claimed;

    event Claimed(address indexed who, uint256 amount);

    error AlreadyClaimed();
    error Empty();

    constructor(ERC20 token_, uint256 amount_) {
        token = token_;
        amount = amount_;
    }

    function claim() external {
        if (claimed[msg.sender]) revert AlreadyClaimed();
        if (token.balanceOf(address(this)) < amount) revert Empty();
        claimed[msg.sender] = true;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }
}
