// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {PoolId} from "infinity-core/src/types/PoolId.sol";
import {AscendV5Key} from "../common/AscendV5.sol";
import {ConstituentRegistry} from "./ConstituentRegistry.sol";

contract ConstituentRegistryV5 is ConstituentRegistry {
    constructor(
        IAscendLaunchpad launchpad_,
        address quote_,
        address pnth_,
        address curator_,
        address guardian_,
        uint128 cap_
    ) ConstituentRegistry(launchpad_, quote_, pnth_, curator_, guardian_, cap_) {}

    function _poolMatches(Constituent memory c) internal view override returns (bool) {
        return
            keccak256(abi.encode(AscendV5Key.keyOf(c.token, baseQuote, address(launchpad)))) == PoolId.unwrap(c.poolId);
    }
}
