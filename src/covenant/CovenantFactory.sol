// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {CovenantRouter} from "./CovenantRouter.sol";

/// @title CovenantFactory
/// @notice Puts an Ascend coin's creator fees under a CovenantRouter, in one of two ways:
///  - `launch`: launches a new coin on Ascend and, in the same transaction, hands its creator role
///    to a router with the jobs you chose. There is never a moment when a person holds the role.
///  - `adopt`: for a coin that already exists. Its creator first offers the role to the router's
///    address (`predictRouter`), then anyone calls `adopt` to deploy the router, which accepts it.
/// The router's address commits to its exact jobs, so nobody can deploy a different policy at the
/// address a creator offered. The factory has no owner and keeps no funds or state.
contract CovenantFactory {
    IAscendLaunchpad public immutable launchpad;
    address public immutable burnSink;

    event RouterDeployed(
        PoolId indexed poolId, address indexed router, address indexed token, bytes32 policyHash, bool launched
    );

    error RoleNotHandedOver();

    constructor(IAscendLaunchpad launchpad_, address burnSink_) {
        launchpad = launchpad_;
        burnSink = burnSink_;
    }

    /// @notice Launch a coin whose creator fees belong to a new router from the first block.
    /// No dev-buy: a router that received the launch's coins would treat them as fees.
    function launch(
        string calldata name,
        string calldata symbol,
        address quote,
        bytes32 salt,
        CovenantRouter.Leg[] calldata tokenLegs,
        CovenantRouter.Leg[] calldata quoteLegs
    ) external returns (address token, PoolId poolId, address router) {
        (token, poolId) = _launchToken(name, symbol, quote, salt);
        router = _handOver(poolId, token, quote, tokenLegs, quoteLegs);
        emit RouterDeployed(poolId, router, token, policyHash(tokenLegs, quoteLegs), true);
    }

    /// @notice Deploy the router a creator has already offered the role to. Permissionless.
    function adopt(
        PoolId poolId,
        address token,
        address quote,
        CovenantRouter.Leg[] calldata tokenLegs,
        CovenantRouter.Leg[] calldata quoteLegs
    ) external returns (address router) {
        router = _deploy(poolId, token, quote, tokenLegs, quoteLegs); // reverts unless the role was offered to it
        emit RouterDeployed(poolId, router, token, policyHash(tokenLegs, quoteLegs), false);
    }

    /// @notice Where the router for this pool and these jobs will live.
    function predictRouter(
        PoolId poolId,
        address token,
        address quote,
        CovenantRouter.Leg[] calldata tokenLegs,
        CovenantRouter.Leg[] calldata quoteLegs
    ) public view returns (address) {
        bytes32 initHash = keccak256(
            abi.encodePacked(
                type(CovenantRouter).creationCode,
                abi.encode(launchpad, poolId, token, quote, burnSink, tokenLegs, quoteLegs)
            )
        );
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), PoolId.unwrap(poolId), initHash))))
        );
    }

    function policyHash(CovenantRouter.Leg[] calldata tokenLegs, CovenantRouter.Leg[] calldata quoteLegs)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(tokenLegs, quoteLegs));
    }

    function _launchToken(string calldata name, string calldata symbol, address quote, bytes32 salt)
        internal
        returns (address token, PoolId poolId)
    {
        (token, poolId) = launchpad.launch(
            IAscendLaunchpad.LaunchParams({
                name: name,
                symbol: symbol,
                quote: quote,
                devBuyQuote: 0,
                minDevOut: 0,
                salt: keccak256(abi.encode(msg.sender, salt)),
                creator: address(this)
            })
        );
    }

    /// The factory is the creator for this one transaction: it offers the role to the router's
    /// address, deploys the router there, and the router's constructor accepts.
    function _handOver(
        PoolId poolId,
        address token,
        address quote,
        CovenantRouter.Leg[] calldata tokenLegs,
        CovenantRouter.Leg[] calldata quoteLegs
    ) internal returns (address router) {
        address predicted = predictRouter(poolId, token, quote, tokenLegs, quoteLegs);
        launchpad.transferCreator(poolId, predicted);
        router = _deploy(poolId, token, quote, tokenLegs, quoteLegs);
        if (router != predicted || launchpad.poolCreator(poolId) != router) revert RoleNotHandedOver();
    }

    function _deploy(
        PoolId poolId,
        address token,
        address quote,
        CovenantRouter.Leg[] calldata tokenLegs,
        CovenantRouter.Leg[] calldata quoteLegs
    ) internal returns (address) {
        return address(
            new CovenantRouter{salt: PoolId.unwrap(poolId)}(
                launchpad, poolId, token, quote, burnSink, tokenLegs, quoteLegs
            )
        );
    }
}
