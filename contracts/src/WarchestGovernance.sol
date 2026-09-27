// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title WarchestGovernance
/// @notice Level-weighted governance for the WARCHEST treasury. Holds NO funds and never talks to the vault's money:
///         it only (1) stores the per-epoch voting-weight merkle roots pushed by the off-chain indexer and (2) tallies
///         votes into decisions that the separate WarchestVault may read.
/// @dev Voting weight of a wallet for an epoch = Σ over its lots of `amount × level(lot)` (level 0..10, LIFO lots),
///      computed off-chain by the indexer from on-chain transfer history (DECISIONS.md D1, D2). Only the merkle root
///      is stored on-chain; voters prove their own weight. A root becomes usable only after a challenge window during
///      which the guardian can revoke it.
contract WarchestGovernance {
    // ---------------------------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------------------------

    struct WeightRoot {
        bytes32 root;
        /// @dev Σ of all leaf weights of the tree; denominator of the quorum.
        uint256 totalWeight;
        uint64 submittedAt;
        bool revoked;
        /// @dev Content hash (e.g. IPFS CID digest) of the full published tree, so anyone can rebuild and check it.
        bytes32 treeHash;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Immutable configuration
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Delay after submission before a weight root can be used, giving the guardian time to revoke it.
    uint64 public immutable challengeWindow;

    // ---------------------------------------------------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Multisig that can pause, revoke roots and rotate the updater. It can never move funds (holds none).
    address public guardian;
    /// @notice Off-chain indexer allowed to submit weight roots.
    address public updater;
    /// @notice Guardian handover target (two-step transfer).
    address public pendingGuardian;

    // ---------------------------------------------------------------------------------------------------------------
    // Weight roots
    // ---------------------------------------------------------------------------------------------------------------

    mapping(uint64 epoch => WeightRoot) internal _roots;
    /// @notice Highest epoch ever submitted; new submissions must be strictly greater (except resubmitting a revoked
    ///         latest epoch).
    uint64 public latestEpoch;

    // ---------------------------------------------------------------------------------------------------------------
    // Events & errors
    // ---------------------------------------------------------------------------------------------------------------

    event WeightRootSubmitted(uint64 indexed epoch, bytes32 root, uint256 totalWeight, bytes32 treeHash);
    event WeightRootRevoked(uint64 indexed epoch, bytes32 root);
    event UpdaterChanged(address indexed previous, address indexed current);
    event GuardianTransferStarted(address indexed current, address indexed pending);
    event GuardianChanged(address indexed previous, address indexed current);

    error ZeroAddress();
    error NotGuardian();
    error NotUpdater();
    error NotPendingGuardian();
    error EpochNotIncreasing(uint64 epoch, uint64 latest);
    error EmptyRoot();
    error RootNotRevocable(uint64 epoch);

    // ---------------------------------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------------------------------

    constructor(address guardian_, address updater_, uint64 challengeWindow_) {
        if (guardian_ == address(0) || updater_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        updater = updater_;
        challengeWindow = challengeWindow_;
        emit GuardianChanged(address(0), guardian_);
        emit UpdaterChanged(address(0), updater_);
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    modifier onlyUpdater() {
        if (msg.sender != updater) revert NotUpdater();
        _;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Role management
    // ---------------------------------------------------------------------------------------------------------------

    function setUpdater(address updater_) external onlyGuardian {
        if (updater_ == address(0)) revert ZeroAddress();
        emit UpdaterChanged(updater, updater_);
        updater = updater_;
    }

    function transferGuardian(address pending) external onlyGuardian {
        pendingGuardian = pending;
        emit GuardianTransferStarted(guardian, pending);
    }

    function acceptGuardian() external {
        if (msg.sender != pendingGuardian) revert NotPendingGuardian();
        emit GuardianChanged(guardian, msg.sender);
        guardian = msg.sender;
        pendingGuardian = address(0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Weight roots
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Publishes the voting-weight merkle root of a daily snapshot `epoch`.
    /// @dev Leaves are `keccak256(bytes.concat(keccak256(abi.encode(epoch, account, weight))))` (OpenZeppelin
    ///      double-hash standard, sorted-pair tree). `epoch` must be strictly greater than every previous submission,
    ///      except that a revoked latest epoch may be resubmitted (e.g. after an indexer fix).
    function submitWeightRoot(uint64 epoch, bytes32 root, uint256 totalWeight, bytes32 treeHash) external onlyUpdater {
        if (root == bytes32(0)) revert EmptyRoot();
        bool resubmission = epoch == latestEpoch && _roots[epoch].revoked;
        if (epoch <= latestEpoch && !resubmission) revert EpochNotIncreasing(epoch, latestEpoch);

        _roots[epoch] = WeightRoot({
            root: root,
            totalWeight: totalWeight,
            submittedAt: uint64(block.timestamp),
            revoked: false,
            treeHash: treeHash
        });
        latestEpoch = epoch;
        emit WeightRootSubmitted(epoch, root, totalWeight, treeHash);
    }

    /// @notice Guardian veto on a root still inside its challenge window.
    function revokeWeightRoot(uint64 epoch) external onlyGuardian {
        WeightRoot storage r = _roots[epoch];
        if (r.root == bytes32(0) || r.revoked || block.timestamp >= uint256(r.submittedAt) + challengeWindow) {
            revert RootNotRevocable(epoch);
        }
        r.revoked = true;
        emit WeightRootRevoked(epoch, r.root);
    }

    function weightRoot(uint64 epoch) external view returns (WeightRoot memory) {
        return _roots[epoch];
    }

    /// @notice True when the root exists, was not revoked and its challenge window has elapsed.
    function isRootUsable(uint64 epoch) public view returns (bool) {
        WeightRoot storage r = _roots[epoch];
        return r.root != bytes32(0) && !r.revoked && block.timestamp >= uint256(r.submittedAt) + challengeWindow;
    }

    /// @notice Merkle leaf for (`epoch`, `account`, `weight`), exposed for off-chain tooling and tests.
    function leaf(uint64 epoch, address account, uint256 weight) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(epoch, account, weight))));
    }
}
