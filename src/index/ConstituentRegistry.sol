// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAscendLaunchpad} from "ascend/interfaces/IAscendLaunchpad.sol";
import {LaunchpadKey} from "ascend/libraries/LaunchpadKey.sol";
import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";

/// @title ConstituentRegistry
/// @notice The basket's list of coins: the result of the Trials (seven by score, three by vote).
/// The curator proposes a whole new list with the score data behind it; it waits 24 hours, during
/// which the guardian (offered to Ascend) can veto it; then anyone can make it active.
/// Every list must pass the same rules, checked on-chain when proposed and again when executed:
/// at most 10 coins, each Ascend-launched, at least 3 days old, trading against USDC, not PNTH,
/// no coin above 20% of the basket, weights summing to 100%.
/// The curator and the guardian can only change the list. Neither can touch any funds.
contract ConstituentRegistry {
    using PoolIdLibrary for PoolKey;

    struct Constituent {
        PoolId poolId;
        address token;
        uint16 weightBps;
        uint128 perRunCap; // most USDC the basket may spend on this coin in one run
    }

    struct Proposal {
        uint64 eta;
        bool vetoed;
        bool executed;
        bytes32 scoreRoot; // Merkle root of the score inputs and outputs, so anyone can recompute them
        string methodologyURI;
    }

    uint256 public constant MAX_N = 10;
    uint16 public constant MAX_WEIGHT_BPS = 2_000;
    uint64 public constant DELAY = 24 hours;
    uint64 public constant GRACE = 7 days; // a proposal not executed within a week of its eta lapses
    uint64 public constant MIN_AGE = 72 hours;

    IAscendLaunchpad public immutable launchpad;
    address public immutable baseQuote;
    address public immutable pnth;
    address public immutable curator;
    address public immutable guardian;
    uint128 public immutable maxRunCap;

    Proposal[] internal _proposals;
    mapping(uint256 => Constituent[]) internal _lists;
    Constituent[] internal _active;
    uint256 public activeId; // 0 = no list yet; otherwise proposal id + 1
    mapping(address => bool) public isConstituent; // ever been active (the stakers' reward tokens)

    event Proposed(uint256 indexed id, uint64 eta, bytes32 scoreRoot, string methodologyURI);
    event Vetoed(uint256 indexed id);
    event Executed(uint256 indexed id, uint256 count);

    error NotCurator();
    error NotGuardian();
    error UnknownProposal();
    error NotReady();
    error Lapsed();
    error AlreadySettled();
    error Superseded();
    error BadList(uint256 index);

    constructor(
        IAscendLaunchpad launchpad_,
        address baseQuote_,
        address pnth_,
        address curator_,
        address guardian_,
        uint128 maxRunCap_
    ) {
        launchpad = launchpad_;
        baseQuote = baseQuote_;
        pnth = pnth_;
        curator = curator_;
        guardian = guardian_;
        maxRunCap = maxRunCap_;
    }

    function propose(Constituent[] calldata list, bytes32 scoreRoot, string calldata methodologyURI)
        external
        returns (uint256 id)
    {
        if (msg.sender != curator) revert NotCurator();
        _check(list);
        id = _proposals.length;
        uint64 eta = uint64(block.timestamp) + DELAY;
        _proposals.push(Proposal(eta, false, false, scoreRoot, methodologyURI));
        Constituent[] storage stored = _lists[id];
        for (uint256 i; i < list.length; ++i) {
            stored.push(list[i]);
        }
        emit Proposed(id, eta, scoreRoot, methodologyURI);
    }

    function veto(uint256 id) external {
        if (msg.sender != guardian) revert NotGuardian();
        Proposal storage p = _proposal(id);
        if (p.executed || p.vetoed) revert AlreadySettled();
        p.vetoed = true;
        emit Vetoed(id);
    }

    /// @notice Make a proposal the active list once its 24 hours have passed. Permissionless.
    function execute(uint256 id) external {
        Proposal storage p = _proposal(id);
        if (p.executed || p.vetoed) revert AlreadySettled();
        if (block.timestamp < p.eta) revert NotReady();
        if (block.timestamp > p.eta + GRACE) revert Lapsed();
        if (id + 1 <= activeId) revert Superseded(); // never roll back to an older list
        Constituent[] storage list = _lists[id];
        _checkStorage(list); // the rules again: a coin can't be younger than 3 days on the day it enters
        p.executed = true;
        delete _active;
        for (uint256 i; i < list.length; ++i) {
            _active.push(list[i]);
            isConstituent[list[i].token] = true;
        }
        activeId = id + 1;
        emit Executed(id, list.length);
    }

    function active() external view returns (Constituent[] memory) {
        return _active;
    }

    function proposal(uint256 id) external view returns (Proposal memory, Constituent[] memory) {
        return (_proposal(id), _lists[id]);
    }

    function proposalCount() external view returns (uint256) {
        return _proposals.length;
    }

    // ------------------------------------------------------------------ rules

    function _proposal(uint256 id) internal view returns (Proposal storage) {
        if (id >= _proposals.length) revert UnknownProposal();
        return _proposals[id];
    }

    function _check(Constituent[] calldata list) internal view {
        uint256 n = list.length;
        if (n == 0 || n > MAX_N) revert BadList(type(uint256).max);
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            _checkOne(list[i], i);
            for (uint256 j; j < i; ++j) {
                if (list[j].token == list[i].token) revert BadList(i);
            }
            sum += list[i].weightBps;
        }
        if (sum != 10_000) revert BadList(type(uint256).max);
    }

    function _checkStorage(Constituent[] storage list) internal view {
        for (uint256 i; i < list.length; ++i) {
            _checkOne(list[i], i);
        }
    }

    function _checkOne(Constituent memory c, uint256 i) internal view {
        if (c.weightBps == 0 || c.weightBps > MAX_WEIGHT_BPS) revert BadList(i);
        if (c.perRunCap == 0 || c.perRunCap > maxRunCap) revert BadList(i);
        if (c.token == pnth || c.token == baseQuote) revert BadList(i);
        uint40 launchedAt = launchpad.poolLaunchedAt(c.poolId);
        if (launchedAt == 0 || block.timestamp < uint256(launchedAt) + MIN_AGE) revert BadList(i);
        PoolKey memory key =
            LaunchpadKey.keyOf(c.token, baseQuote, address(launchpad), address(launchpad.poolManager()));
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(c.poolId)) revert BadList(i);
    }
}
