// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {HypePassportRegistry} from "../src/HypePassportRegistry.sol";

/// Attestations signed by the Passport service's attest.ts (fixtures/attestation.json, written by
/// scripts/make-attestation-fixture.ts) must hash and verify exactly as the registry does.
contract AttestationCrossCheckTest is Test {
    HypePassportRegistry reg;
    string fx;
    uint256 constant T0 = 1791680000;

    function setUp() public {
        fx = vm.readFile("fixtures/attestation.json");
        vm.chainId(99801);
        vm.warp(T0 + 100);
        reg = new HypePassportRegistry(vm.parseJsonAddress(fx, ".attestor"), address(0xBEEF));
    }

    function _att(string memory k) internal view returns (HypePassportRegistry.Attestation memory a) {
        a.account = vm.parseJsonAddress(fx, string.concat(".", k, ".account"));
        a.hlKey = vm.parseJsonBytes32(fx, string.concat(".", k, ".hlKey"));
        a.tier = uint8(vm.parseJsonUint(fx, string.concat(".", k, ".tier")));
        a.stamps = uint32(vm.parseJsonUint(fx, string.concat(".", k, ".stamps")));
        a.issuedAt = uint64(vm.parseJsonUint(fx, string.concat(".", k, ".issuedAt")));
        a.expiry = uint64(vm.parseJsonUint(fx, string.concat(".", k, ".expiry")));
        a.deadline = uint64(vm.parseJsonUint(fx, string.concat(".", k, ".deadline")));
        a.chainId = vm.parseJsonUint(fx, string.concat(".", k, ".chainId"));
    }

    function _sig(string memory k) internal view returns (bytes memory) {
        return vm.parseJsonBytes(fx, string.concat(".", k, ".sig"));
    }

    function test_serviceDigestEqualsRegistryDigest() public view {
        assertEq(address(reg), vm.parseJsonAddress(fx, ".registry"));
        string[3] memory ks = ["first", "renewal", "downgrade"];
        for (uint256 i; i < ks.length; i++) {
            assertEq(reg.hashAttestation(_att(ks[i])), vm.parseJsonBytes32(fx, string.concat(".", ks[i], ".digest")));
        }
    }

    function test_serviceAttestationIsAccepted() public {
        HypePassportRegistry.Attestation memory a = _att("first");
        reg.submit(a, _sig("first"));
        assertTrue(reg.isValid(a.account));
        assertEq(reg.tierOf(a.account), 2);
        assertEq(reg.stampsOf(a.account), 5);
        assertEq(reg.multiplierOf(a.account), 1.2e18);
        assertEq(reg.accountOfHlKey(a.hlKey), a.account);
        assertEq(reg.passportOf(a.account).expiry, a.issuedAt + 7 days);
        assertEq(reg.passportOf(a.account).linkedAt, uint64(block.timestamp));
    }

    function test_renewalUpgradesAndKeepsLinkedAt() public {
        HypePassportRegistry.Attestation memory a = _att("first");
        reg.submit(a, _sig("first"));
        uint64 linked = reg.passportOf(a.account).linkedAt;
        vm.warp(T0 + 3700);
        reg.submit(_att("renewal"), _sig("renewal"));
        assertEq(reg.tierOf(a.account), 3);
        assertEq(reg.multiplierOf(a.account), 1.25e18);
        assertEq(reg.passportOf(a.account).linkedAt, linked);
    }

    function test_tierZeroDowngradeKeepsBinding() public {
        HypePassportRegistry.Attestation memory a = _att("first");
        reg.submit(a, _sig("first"));
        vm.warp(T0 + 3700);
        reg.submit(_att("renewal"), _sig("renewal"));
        vm.warp(T0 + 7300);
        reg.submit(_att("downgrade"), _sig("downgrade"));
        assertTrue(reg.isValid(a.account));
        assertEq(reg.tierOf(a.account), 0);
        assertEq(reg.multiplierOf(a.account), 1e18);
        assertEq(reg.accountOfHlKey(a.hlKey), a.account);
    }

    function test_replayAndOlderAttestationsRejected() public {
        reg.submit(_att("first"), _sig("first"));
        vm.expectRevert(HypePassportRegistry.StaleAttestation.selector);
        reg.submit(_att("first"), _sig("first"));
        vm.warp(T0 + 3700);
        reg.submit(_att("renewal"), _sig("renewal"));
        vm.warp(T0 + 3600); // back inside first's deadline: still stale, never re-accepted
        vm.expectRevert(HypePassportRegistry.StaleAttestation.selector);
        reg.submit(_att("first"), _sig("first"));
    }

    function test_deadlineAndTamperingRejected() public {
        HypePassportRegistry.Attestation memory a = _att("first");
        a.tier = 3;
        vm.expectRevert(HypePassportRegistry.BadSignature.selector);
        reg.submit(a, _sig("first"));
        vm.warp(T0 + 3601);
        vm.expectRevert(HypePassportRegistry.DeadlinePassed.selector);
        reg.submit(_att("first"), _sig("first"));
    }
}
