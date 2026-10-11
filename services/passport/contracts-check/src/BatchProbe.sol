// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HypePassportRegistry} from "./HypePassportRegistry.sol";

interface IMulticall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory);
}

/// Read-only live check of the relayer's batch path: sent as eth_call / eth_estimateGas with NO `to`,
/// so the node runs this constructor: deploy the reference registry, then submit every attestation
/// through the chain's own Multicall3 (canonical address), and return which ones were issued.
contract BatchProbe {
    constructor(
        address attestor,
        HypePassportRegistry.Attestation[] memory atts,
        bytes[] memory sigs,
        bool allowFailure
    ) {
        HypePassportRegistry reg = new HypePassportRegistry(attestor, address(0xBEEF));
        IMulticall3.Call3[] memory calls = new IMulticall3.Call3[](atts.length);
        for (uint256 i; i < atts.length; i++) {
            calls[i] = IMulticall3.Call3(address(reg), allowFailure, abi.encodeCall(reg.submit, (atts[i], sigs[i])));
        }
        IMulticall3.Result[] memory r = IMulticall3(0xcA11bde05977b3631167028862bE2a173976CA11).aggregate3(calls);
        bool[] memory issued = new bool[](r.length);
        for (uint256 i; i < r.length; i++) {
            issued[i] = r[i].success && reg.isValid(atts[i].account);
        }
        bytes memory out = abi.encode(address(reg), issued);
        assembly {
            return(add(out, 32), mload(out))
        }
    }
}
