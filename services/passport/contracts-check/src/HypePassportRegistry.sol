// SPDX-License-Identifier: MIT
// REFERENCE COPY for the P5 signer cross-check only: docs/PASSPORT_SPEC.md Appendix A (as verified in
// /tmp/passport-check). Not deployed from here. The deployable registry is P6 in src/passport/ (Micheal/Claude).
pragma solidity 0.8.30;

import {IHypePassport} from "./IHypePassport.sol";

/// @title HypePassportRegistry v1: immutable attestor, no owner, bounded trust (<= 1.25x reweighting, no funds)
contract HypePassportRegistry is IHypePassport {
    struct Attestation {
        address account;  // Elysium wallet receiving the passport
        bytes32 hlKey;    // peppered hash of the Hyperliquid address
        uint8 tier;       // 0..3 (0 = downgrade/revoke but keep binding)
        uint32 stamps;
        uint64 issuedAt;
        uint64 expiry;
        uint64 deadline;  // must be submitted before this (short, e.g. 1h)
        uint256 chainId;  // must equal block.chainid (99801 on Elysium testnet)
    }

    // Domain deliberately has NO chainId (MetaMask rejects typed data whose domain.chainId != active chain);
    // chainId is a struct field instead and is checked against block.chainid.
    bytes32 public constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,address verifyingContract)");
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(address account,bytes32 hlKey,uint8 tier,uint32 stamps,uint64 issuedAt,uint64 expiry,uint64 deadline,uint256 chainId)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;
    address public immutable ATTESTOR;
    address public immutable GUARDIAN; // may be address(0); can only retire()
    bool public retired;               // one-way kill switch: everyone back to 1.0x, no new submits

    uint64 public constant MAX_VALIDITY = 8 days;
    uint64 public constant MAX_CLOCK_SKEW = 10 minutes;
    uint64 public constant REBIND_COOLDOWN = 7 days;
    uint8 public constant MAX_TIER = 3;

    mapping(address => Passport) internal _passports;
    mapping(bytes32 => address) public accountOfHlKey;
    mapping(bytes32 => uint64) public rebindableAt;
    mapping(address => uint64) public lastIssuedAt; // never reset: strict replay protection per account

    error WrongChain();
    error DeadlinePassed();
    error InvalidTier();
    error InvalidExpiry();
    error IssuedInFuture();
    error BadSignature();
    error StaleAttestation();
    error ZeroHlKey();
    error ZeroAccount();
    error AccountBoundToOtherHl();
    error HlBoundToOtherAccount();
    error RebindCooldown(uint64 until);
    error NotLinked();
    error NotAuthorized();
    error IsRetired();

    event Retired(address indexed by);

    constructor(address attestor, address guardian) {
        if (attestor == address(0)) revert ZeroAccount();
        ATTESTOR = attestor;
        GUARDIAN = guardian;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("HYPE Passport"), keccak256("1"), address(this))
        );
    }

    // ------------------------------------------------------------------ writes
    /// Permissionless: user, relayer or keeper may submit any attestor-signed attestation.
    function submit(Attestation calldata a, bytes calldata sig) external {
        if (retired) revert IsRetired();
        if (a.chainId != block.chainid) revert WrongChain();
        if (block.timestamp > a.deadline) revert DeadlinePassed();
        if (a.account == address(0)) revert ZeroAccount();
        if (a.hlKey == bytes32(0)) revert ZeroHlKey();
        if (a.tier > MAX_TIER) revert InvalidTier();
        if (a.issuedAt > block.timestamp + MAX_CLOCK_SKEW) revert IssuedInFuture();
        if (a.expiry <= block.timestamp || a.expiry > a.issuedAt + MAX_VALIDITY) revert InvalidExpiry();
        if (a.issuedAt <= lastIssuedAt[a.account]) revert StaleAttestation();
        if (_recover(hashAttestation(a), sig) != ATTESTOR) revert BadSignature();

        // 1:1 binding: account side
        bytes32 cur = _passports[a.account].hlKey;
        uint64 linkedAt = cur == a.hlKey ? _passports[a.account].linkedAt : uint64(block.timestamp);
        if (cur != bytes32(0) && cur != a.hlKey) {
            if (_passports[a.account].expiry + REBIND_COOLDOWN > block.timestamp) revert AccountBoundToOtherHl();
            _release(a.account, cur, 0); // stale binding auto-frees
        }
        // 1:1 binding: Hyperliquid side
        address holder = accountOfHlKey[a.hlKey];
        if (holder != a.account) {
            if (holder != address(0)) {
                if (_passports[holder].expiry + REBIND_COOLDOWN > block.timestamp) revert HlBoundToOtherAccount();
                _release(holder, a.hlKey, 0);
            } else if (block.timestamp < rebindableAt[a.hlKey]) {
                revert RebindCooldown(rebindableAt[a.hlKey]);
            }
            accountOfHlKey[a.hlKey] = a.account;
        }

        lastIssuedAt[a.account] = a.issuedAt;
        _passports[a.account] = Passport(a.hlKey, a.tier, a.stamps, a.issuedAt, a.expiry, linkedAt);
        emit PassportIssued(a.account, a.hlKey, a.tier, a.stamps, a.issuedAt, a.expiry);
    }

    /// The Elysium account can always drop its passport. The HL key can rebind after REBIND_COOLDOWN.
    function unlink() external {
        bytes32 k = _passports[msg.sender].hlKey;
        if (k == bytes32(0)) revert NotLinked();
        _release(msg.sender, k, uint64(block.timestamp) + REBIND_COOLDOWN);
    }

    /// Fail-safe for a leaked attestor key: only ever moves everyone to 1.0x. Irreversible.
    function retire() external {
        if (msg.sender != ATTESTOR && msg.sender != GUARDIAN) revert NotAuthorized();
        retired = true;
        emit Retired(msg.sender);
    }

    // ------------------------------------------------------------------ views
    function passportOf(address account) external view returns (Passport memory) {
        return _passports[account];
    }

    function isValid(address account) public view returns (bool) {
        Passport storage p = _passports[account];
        return !retired && p.hlKey != bytes32(0) && block.timestamp < p.expiry;
    }

    function tierOf(address account) public view returns (uint8) {
        return isValid(account) ? _passports[account].tier : 0;
    }

    function stampsOf(address account) external view returns (uint32) {
        return isValid(account) ? _passports[account].stamps : 0;
    }

    function multiplierOf(address account) external view returns (uint256) {
        uint8 t = tierOf(account);
        if (t == 3) return 1.25e18;
        if (t == 2) return 1.2e18;
        if (t == 1) return 1.1e18;
        return 1e18;
    }

    function hashAttestation(Attestation calldata a) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH, a.account, a.hlKey, a.tier, a.stamps, a.issuedAt, a.expiry, a.deadline, a.chainId
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    // ------------------------------------------------------------------ internal
    function _release(address account, bytes32 k, uint64 rebindAt) internal {
        delete _passports[account];
        delete accountOfHlKey[k];
        if (rebindAt != 0) rebindableAt[k] = rebindAt;
        emit Unlinked(account, k, rebindAt);
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        if (v != 27 && v != 28) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }
}
