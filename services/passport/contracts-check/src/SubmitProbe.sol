// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HypePassportRegistry} from "./HypePassportRegistry.sol";

/// Read-only live check: sent as an eth_call with NO `to`, so the Elysium node runs this constructor
/// (deploy the reference registry, submit one attestation signed by the service) and returns the
/// registry's answers instead of runtime code. Nothing is broadcast; no gas is spent.
contract SubmitProbe {
    constructor(address attestor, HypePassportRegistry.Attestation memory a, bytes memory sig) {
        HypePassportRegistry reg = new HypePassportRegistry(attestor, address(0xBEEF));
        bytes32 digest = reg.hashAttestation(a);
        reg.submit(a, sig);
        bytes memory out = abi.encode(
            address(reg),
            digest,
            block.chainid,
            block.timestamp,
            reg.isValid(a.account),
            reg.tierOf(a.account),
            reg.stampsOf(a.account),
            reg.multiplierOf(a.account),
            reg.accountOfHlKey(a.hlKey)
        );
        assembly {
            return(add(out, 32), mload(out))
        }
    }
}
