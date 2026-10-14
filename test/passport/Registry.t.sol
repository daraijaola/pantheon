// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {HypePassportRegistry} from "../../src/passport/HypePassportRegistry.sol";

contract RegistryTest is Test {
    HypePassportRegistry reg;
    string fx;

    function setUp() public {
        fx = vm.readFile("test/passport/fixtures/attestation.json");
        vm.chainId(99801);
        vm.warp(1791680100);
        reg = new HypePassportRegistry(vm.parseJsonAddress(fx, ".attestor"), address(0xBEEF));
    }

    function _att() internal view returns (HypePassportRegistry.Attestation memory a) {
        a.account = vm.parseJsonAddress(fx, ".account");
        a.hlKey = vm.parseJsonBytes32(fx, ".hlKey");
        a.tier = uint8(vm.parseJsonUint(fx, ".tier"));
        a.stamps = uint32(vm.parseJsonUint(fx, ".stamps"));
        a.issuedAt = uint64(vm.parseJsonUint(fx, ".issuedAt"));
        a.expiry = uint64(vm.parseJsonUint(fx, ".expiry"));
        a.deadline = uint64(vm.parseJsonUint(fx, ".deadline"));
        a.chainId = 99801;
    }

    function test_viemDigestAndSignatureMatch() public {
        assertEq(address(reg), vm.parseJsonAddress(fx, ".registry"));
        HypePassportRegistry.Attestation memory a = _att();
        assertEq(reg.hashAttestation(a), vm.parseJsonBytes32(fx, ".digest"));
        reg.submit(a, vm.parseJsonBytes(fx, ".sig"));
        assertEq(reg.tierOf(a.account), 2);
        assertEq(reg.multiplierOf(a.account), 1.2e18);
        assertEq(reg.accountOfHlKey(a.hlKey), a.account);
        // replay rejected
        vm.expectRevert(HypePassportRegistry.StaleAttestation.selector);
        reg.submit(a, vm.parseJsonBytes(fx, ".sig"));
        // expiry -> multiplier back to 1x
        vm.warp(a.expiry);
        assertEq(reg.multiplierOf(a.account), 1e18);
    }

    function test_wrongChainRejected() public {
        vm.chainId(999);
        vm.expectRevert(HypePassportRegistry.WrongChain.selector);
        reg.submit(_att(), vm.parseJsonBytes(fx, ".sig"));
    }

    function test_tamperedTierRejected() public {
        HypePassportRegistry.Attestation memory a = _att();
        a.tier = 3;
        vm.expectRevert(HypePassportRegistry.BadSignature.selector);
        reg.submit(a, vm.parseJsonBytes(fx, ".sig"));
    }

    function test_unlinkSetsCooldown() public {
        HypePassportRegistry.Attestation memory a = _att();
        reg.submit(a, vm.parseJsonBytes(fx, ".sig"));
        vm.prank(a.account);
        reg.unlink();
        assertEq(reg.accountOfHlKey(a.hlKey), address(0));
        assertEq(reg.rebindableAt(a.hlKey), uint64(block.timestamp) + 7 days);
        assertEq(reg.multiplierOf(a.account), 1e18);
    }

    function test_retireIsOneWaySafeState() public {
        HypePassportRegistry.Attestation memory a = _att();
        reg.submit(a, vm.parseJsonBytes(fx, ".sig"));
        vm.expectRevert(HypePassportRegistry.NotAuthorized.selector);
        reg.retire();
        vm.prank(address(0xBEEF));
        reg.retire();
        assertEq(reg.multiplierOf(a.account), 1e18);
        assertEq(reg.tierOf(a.account), 0);
        vm.expectRevert(HypePassportRegistry.IsRetired.selector);
        reg.submit(a, vm.parseJsonBytes(fx, ".sig"));
    }

    function testFuzz_multiplierBounded(uint8 tier, uint64 dt) public {
        HypePassportRegistry.Attestation memory a = _att();
        vm.assume(tier <= 3);
        // tier changes the digest so signature fails unless tier==2; check bound on the view only
        if (tier == 2) reg.submit(a, vm.parseJsonBytes(fx, ".sig"));
        vm.warp(block.timestamp + (dt % 30 days));
        uint256 m = reg.multiplierOf(a.account);
        assertGe(m, 1e18);
        assertLe(m, 1.25e18);
    }

    function test_renewalKeepsLinkedAt() public {
        HypePassportRegistry.Attestation memory a = _att();
        reg.submit(a, vm.parseJsonBytes(fx, ".sig"));
        uint64 linked = reg.passportOf(a.account).linkedAt;
        assertEq(linked, uint64(block.timestamp));
        vm.warp(block.timestamp + 3600);
        a.tier = 3;
        a.stamps = 133;
        a.issuedAt = uint64(vm.parseJsonUint(fx, ".att2.issuedAt"));
        a.expiry = uint64(vm.parseJsonUint(fx, ".att2.expiry"));
        a.deadline = uint64(vm.parseJsonUint(fx, ".att2.deadline"));
        reg.submit(a, vm.parseJsonBytes(fx, ".att2.sig"));
        assertEq(reg.tierOf(a.account), 3);
        assertEq(reg.multiplierOf(a.account), 1.25e18);
        assertEq(reg.passportOf(a.account).linkedAt, linked);
    }
}
