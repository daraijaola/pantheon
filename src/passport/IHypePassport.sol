// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IHypePassport: stable read interface (v1 attestor registry and v2 precompile registry both implement it)
interface IHypePassport {
    struct Passport {
        bytes32 hlKey; // keccak256(abi.encodePacked(PEPPER, hlAccount)); never the raw HL address in v1
        uint8 tier; // 0..3
        uint32 stamps; // bitmap, see spec section 4.3
        uint64 issuedAt; // unix seconds (attestor clock) of the latest attestation
        uint64 expiry; // unix seconds; passport is valid while block.timestamp < expiry
        uint64 linkedAt; // block.timestamp when this hlKey<->account binding was created; kept across renewals
    }

    event PassportIssued(
        address indexed account, bytes32 indexed hlKey, uint8 tier, uint32 stamps, uint64 issuedAt, uint64 expiry
    );
    event Unlinked(address indexed account, bytes32 indexed hlKey, uint64 rebindableAt);

    /// raw record (may be expired)
    function passportOf(address account) external view returns (Passport memory);
    /// true iff linked and block.timestamp < expiry
    function isValid(address account) external view returns (bool);
    /// 0 if not linked or expired
    function tierOf(address account) external view returns (uint8);
    /// 0 if not linked or expired
    function stampsOf(address account) external view returns (uint32);
    /// 1e18 (none/expired), 1.10e18 (T1), 1.20e18 (T2), 1.25e18 (T3)
    function multiplierOf(address account) external view returns (uint256);
    /// Elysium account currently bound to an hlKey (address(0) if none)
    function accountOfHlKey(bytes32 hlKey) external view returns (address);
}
