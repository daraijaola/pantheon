// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TwoStepOwned} from "../base/TwoStepOwned.sol";

/// @notice Weekly staker rewards paid from published allocations.
/// Anyone funds the current week in a supported token
/// or native HYPE; after the week ends the owner posts one Merkle root of who
/// is owed what, with the total it allocates of each token; after a public
/// review window each beneficiary's amount can be claimed to that beneficiary,
/// by anyone, or by the beneficiary to an address it names, with no deadline.
/// What a final root does not allocate rolls into
/// the then-current week, and so does a week left without a root for a year.
/// Nothing else moves funds.
///
/// Trust: the owner chooses the root of every ended week whose root is not
/// yet claimable, so the owner seat decides who receives each such week's
/// budget (including itself or a burn address) and can withhold a week. The
/// guardian can cancel a posted root during its review window and can do
/// nothing else: it never posts, pays or holds. A malicious root can finalize
/// if the guardian fails to veto it; either seat can delay rewards. A root can
/// spend at most the totals it declared,
/// which cannot exceed its own week's budget of each token, never another
/// week's, and a claimable root is final.
///
/// The allocation rule (yield given up) is computed off
/// chain from public data and is not this contract's concern; solvency is.
contract StakerDistributor is TwoStepOwned, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The vault's release cadence: `block.timestamp / 7 days`, so a
    /// week runs Thursday 00:00 UTC to Thursday 00:00 UTC.
    uint256 public constant EPOCH_SECONDS = 7 days;
    /// @notice Between posting a root and its first claim: the window in which
    /// anyone can recompute the allocation, the owner can replace a wrong one
    /// and the guardian can cancel it.
    uint256 public constant CLAIM_DELAY = 2 days;
    /// @notice How long after a week ends it can still be given a root. A week
    /// with no root by then rolls; a week with a final root never expires.
    uint256 public constant ROOT_DEADLINE = 52 weeks;
    /// @notice Native HYPE, by the convention `Treasury.sweep` already uses.
    address public constant NATIVE = address(0);

    /// @notice May cancel a root before it is claimable. Fixed for the life of
    /// the contract: use an account that can rotate its own signers.
    address public immutable guardian;

    /// @param version counts the posts for this week; totals are kept per post
    struct Root {
        bytes32 root;
        uint64 claimableAt;
        uint32 version;
    }

    /// @param amount what the root allocates of `token`, the sum of its leaves
    struct Total {
        address token;
        uint256 amount;
    }

    /// @param amount the beneficiary's whole entitlement of `token` for `epoch`
    struct Claim {
        uint256 epoch;
        address token;
        uint256 amount;
        bytes32[] proof;
    }

    /// @notice The allocation of an ended week; zero until posted.
    mapping(uint256 epoch => Root) public roots;
    /// @notice What a week holds of a token: funded during the week, plus
    /// anything rolled into it, minus anything rolled out.
    mapping(uint256 epoch => mapping(address token => uint256)) public budget;
    /// @notice What a week has paid of a token. Never exceeds its allocation.
    mapping(uint256 epoch => mapping(address token => uint256)) public paid;
    /// @notice What a beneficiary has received of a token for a week.
    mapping(uint256 epoch => mapping(address token => mapping(address account => uint256))) public claimed;
    /// @notice What every week together still holds of a token: the sum of
    /// `budget - paid`. Custody above it is unaccounted until `absorb`.
    mapping(address token => uint256) public held;
    /// @dev Declared totals by post, so a replaced or cancelled root leaves none behind.
    mapping(uint256 epoch => mapping(uint256 version => mapping(address token => uint256))) private _allocated;

    error InvalidGuardian();
    error InvalidAmount();
    error InvalidRoot();
    error UnsortedTotals();
    error EpochOpen();
    error RootLocked();
    error RootDeadlinePassed();
    error NotClaimable();
    error InvalidProof();
    error OverBudget();
    error NotRollable();
    error NativeTransferFailed();
    error InvalidRecipient();

    event Funded(uint256 indexed epoch, address indexed token, address indexed from, uint256 amount);
    /// @dev `version` counts the week's posts: a post is its root and the
    /// totals posted with it, and two posts of one root differ only in this.
    event RootPosted(uint256 indexed epoch, bytes32 root, uint256 claimableAt, uint32 version);
    event Allocated(uint256 indexed epoch, address indexed token, uint256 amount);
    event RootVetoed(uint256 indexed epoch, bytes32 root);
    /// @dev `to` is where it was paid: the account, or the address it named in `claimTo`.
    event Claimed(uint256 indexed epoch, address indexed token, address indexed account, uint256 amount, address to);
    event Rolled(uint256 indexed fromEpoch, uint256 indexed toEpoch, address indexed token, uint256 amount);

    /// @param owner_ the seat that posts roots
    /// @param guardian_ the seat that cancels a pending post: never the owner, fixed for this contract's life
    constructor(address owner_, address guardian_) TwoStepOwned(owner_) {
        if (guardian_ == address(0) || guardian_ == owner_) revert InvalidGuardian();
        guardian = guardian_;
    }

    /// @dev The two seats stay two accounts: the guardian can never accept the owner seat.
    function _afterOwnershipTransfer() internal view override {
        if (owner == guardian) revert InvalidGuardian();
    }

    /// @notice The week now, `block.timestamp / 7 days`: what `fund` credits and what `roll` lands in.
    function currentEpoch() public view returns (uint256) {
        return block.timestamp / EPOCH_SECONDS;
    }

    /// @notice The moment from which a week can no longer be given a root: a
    /// post is refused at this second, and a week still without one rolls from it.
    function rootDeadline(uint256 epoch) public pure returns (uint256) {
        return (epoch + 1) * EPOCH_SECONDS + ROOT_DEADLINE;
    }

    /// @notice What the week's current root allocates of `token`: the most its
    /// leaves can be paid. Zero without a root.
    function allocated(uint256 epoch, address token) public view returns (uint256) {
        Root memory r = roots[epoch];
        return r.root == bytes32(0) ? 0 : _allocated[epoch][r.version][token];
    }

    /// @notice Add to the current week's budget of `token`. Attribution is by
    /// receipt time, never by a caller-chosen week, so a root for an ended week
    /// cannot be diluted or front-run by later funding. Credits what arrived,
    /// together with anything sitting here unaccounted.
    function fund(address token, uint256 amount) external payable nonReentrant returns (uint256 received) {
        if (token == NATIVE) {
            if (msg.value != amount) revert InvalidAmount();
        } else {
            if (msg.value != 0) revert InvalidAmount();
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }
        received = _credit(token);
        emit Funded(currentEpoch(), token, msg.sender, received);
    }

    /// @notice Credit custody that arrived without `fund` to the current week:
    /// a plain token transfer (`Treasury.sweep`) or native HYPE forced in.
    /// Anyone. Without it such funds would sit outside every budget forever.
    function absorb(address token) external nonReentrant returns (uint256 received) {
        received = _credit(token);
        emit Funded(currentEpoch(), token, address(this), received);
    }

    /// @dev Custody above `held` joins the current week. A token whose balance
    /// can fall on its own (rebasing, clawback) is unsupported: it reverts here.
    /// An address without code is not a token: a precompile can answer
    /// `balanceOf` with anything.
    function _credit(address token) private returns (uint256 received) {
        if (token != NATIVE && token.code.length == 0) revert InvalidAmount();
        uint256 custody = token == NATIVE ? address(this).balance : IERC20(token).balanceOf(address(this));
        received = custody - held[token];
        if (received == 0) revert InvalidAmount();
        held[token] = custody;
        budget[currentEpoch()][token] += received;
    }

    /// @notice Post or, until its first claim can happen, replace the
    /// allocation of an ended week, with what it allocates of each token, in
    /// ascending token order (so a token is named once). A total above the
    /// week's budget is refused; a token left out allocates nothing. Each post
    /// restarts the review window and discards the totals of the post before
    /// it. The contract cannot see the leaves: a total above what they pay is
    /// kept back from `roll` and paid to nobody, so the builder declares each
    /// token's leaves summed and the guardian's watcher checks `allocated`. A leaf is `keccak256(bytes.concat(keccak256(
    /// abi.encode(chainId, distributor, epoch, token, account, amount))))`,
    /// pairs hashed sorted.
    function postRoot(uint256 epoch, bytes32 root, Total[] calldata totals) external onlyOwner {
        if (root == bytes32(0)) revert InvalidRoot();
        if (epoch >= currentEpoch()) revert EpochOpen();
        Root storage r = roots[epoch];
        if (r.root != bytes32(0) && block.timestamp >= r.claimableAt) revert RootLocked();
        if (block.timestamp >= rootDeadline(epoch)) revert RootDeadlinePassed();
        uint32 version = r.version + 1;
        uint256 claimableAt = block.timestamp + CLAIM_DELAY;
        r.root = root;
        r.claimableAt = uint64(claimableAt);
        r.version = version;
        emit RootPosted(epoch, root, claimableAt, version);
        for (uint256 i; i < totals.length; ++i) {
            Total calldata total = totals[i];
            if (i != 0 && total.token <= totals[i - 1].token) revert UnsortedTotals();
            if (total.amount > budget[epoch][total.token]) revert OverBudget();
            _allocated[epoch][version][total.token] = total.amount;
            emit Allocated(epoch, total.token, total.amount);
        }
    }

    /// @notice Cancel one post before it is claimable. Guardian only. A post
    /// is a root and the totals posted with it, so the cancel names both the
    /// root and the post's version (`roots(epoch)`): it can only remove the
    /// post the guardian examined, never one that replaced it meanwhile, with
    /// another root or with the same root and other totals. The week is then
    /// without a root: the owner posts again, or it rolls after the root
    /// deadline.
    function veto(uint256 epoch, bytes32 root, uint32 version) external {
        if (msg.sender != guardian) revert Unauthorized();
        Root storage r = roots[epoch];
        if (root == bytes32(0) || r.root != root || r.version != version) revert InvalidRoot();
        if (block.timestamp >= r.claimableAt) revert RootLocked();
        r.root = bytes32(0);
        r.claimableAt = 0;
        emit RootVetoed(epoch, root);
    }

    /// @notice Pay `account` what its leaves prove and it has not yet received.
    /// Anyone may call; funds go to `account`; there is no deadline.
    /// An item already paid is skipped, so a batch another caller partly
    /// settled still completes. A root whose leaves sum to more than the total
    /// it declared stops at that total: it can never reach another week's or
    /// another token's backing. Such a root pays first come first served and
    /// reverts the item that does not fit, with the rest of its batch. Two
    /// leaves for one (week, token, account) pay the larger, not the sum.
    function claim(address account, Claim[] calldata claims) external nonReentrant {
        _claim(account, account, claims);
    }

    /// @notice The caller's own entitlements, paid to `to`. For an account
    /// that cannot receive what it is owed where it stands (a contract with no
    /// payable `receive` cannot be paid native HYPE). It does not reserve an
    /// entitlement: `claim` is anyone's and pays the account in place, so an
    /// item the account can receive may already have been settled there.
    function claimTo(address to, Claim[] calldata claims) external nonReentrant {
        if (to == address(0)) revert InvalidRecipient(); // native HYPE and a plain token would be burned (round 7)
        _claim(msg.sender, to, claims);
    }

    function _claim(address account, address to, Claim[] calldata claims) private {
        for (uint256 i; i < claims.length; ++i) {
            Claim calldata c = claims[i];
            Root memory r = roots[c.epoch];
            if (r.root == bytes32(0) || block.timestamp < r.claimableAt) revert NotClaimable();
            bytes32 leaf =
                keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), c.epoch, c.token, account, c.amount))));
            if (!MerkleProof.verifyCalldata(c.proof, r.root, leaf)) revert InvalidProof();
            uint256 already = claimed[c.epoch][c.token][account];
            if (c.amount <= already) continue;
            uint256 due = c.amount - already;
            uint256 spent = paid[c.epoch][c.token] + due;
            if (spent > _allocated[c.epoch][r.version][c.token]) revert OverBudget();
            claimed[c.epoch][c.token][account] = c.amount;
            paid[c.epoch][c.token] = spent;
            held[c.token] -= due;
            emit Claimed(c.epoch, c.token, account, due, to);
            _pay(c.token, to, due);
        }
    }

    /// @notice Move what a week will never pay into the current week's budget,
    /// where the next allocation distributes it. Anyone. Once a week's root is
    /// final that is whatever the root did not allocate (rounding dust, a
    /// token it left out); entitlements stay. A week still without a root at
    /// the root deadline rolls whole.
    function roll(uint256 epoch, address token) external nonReentrant returns (uint256 amount) {
        Root memory r = roots[epoch];
        bool rooted = r.root != bytes32(0);
        if (block.timestamp < (rooted ? r.claimableAt : rootDeadline(epoch))) revert NotRollable();
        uint256 keep = rooted ? _allocated[epoch][r.version][token] : 0;
        amount = budget[epoch][token] - keep;
        if (amount == 0) revert InvalidAmount();
        budget[epoch][token] = keep;
        uint256 into = currentEpoch();
        budget[into][token] += amount;
        emit Rolled(epoch, into, token, amount);
    }

    function _pay(address token, address to, uint256 amount) private {
        if (token == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
