// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IWarchestDecisionSource, IWarchestVaultView} from "./interfaces/IWarchestDecisionSource.sol";

/// @title WarchestGovernance
/// @notice Level-weighted governance for the WARCHEST treasury. Holds NO funds and never talks to the vault's money:
///         it only (1) stores the per-epoch voting-weight merkle roots pushed by the off-chain indexer and (2) tallies
///         votes into decisions that the separate WarchestVault may read.
/// @dev Voting weight of a wallet for an epoch = Σ over its lots of `amount × level(lot)` (level 0..10, LIFO lots),
///      computed off-chain by the indexer from on-chain transfer history (DECISIONS.md D1, D2). Only the merkle root
///      is stored on-chain; voters prove their own weight. A root becomes usable only after a challenge window during
///      which the guardian can revoke it.
contract WarchestGovernance is IWarchestDecisionSource {
    // ---------------------------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------------------------

    enum RoundKind {
        /// Choose (asset, direction) among the eligible assets.
        Direction,
        /// Yes/no on voluntarily closing the current position once the profit threshold is reached (S2.3).
        Close
    }

    /// @notice Immutable parameters, grouped to keep the constructor readable.
    struct Params {
        /// Delay after submission before a weight root can be used (guardian challenge window).
        uint64 challengeWindow;
        /// Duration of a voting round.
        uint64 votingPeriod;
        /// Max age of a snapshot root (after its challenge window) for it to open a round.
        uint64 maxRootAge;
        /// Quorum in bps of the snapshot's total weight (e.g. 1000 = 10%).
        uint16 quorumBps;
    }

    struct Round {
        RoundKind kind;
        /// Snapshot epoch whose weight root is used for this round.
        uint64 epoch;
        uint64 startsAt;
        uint64 endsAt;
        bool finalized;
        /// Σ weight of all votes cast.
        uint256 totalVoted;
        /// Close rounds: id of the decision whose position is proposed for closing. Unused for direction rounds.
        uint256 targetDecisionId;
    }

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
    uint64 public immutable votingPeriod;
    uint64 public immutable maxRootAge;
    uint16 public immutable quorumBps;

    uint256 public constant MAX_ASSETS = 16;
    uint16 internal constant BPS = 10_000;

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
    // Rounds
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Hyperliquid perp asset indices eligible for the next direction rounds (closed list, guardian-managed).
    uint32[] internal _eligibleAssets;
    /// @notice Emergency stop for round creation, voting and finalization (D9). Holds no funds, so nothing else to stop.
    bool public paused;

    /// @notice Number of rounds ever created; round ids start at 1.
    uint256 public roundCount;
    /// @notice Snapshot epoch of the most recent round; later rounds must use the same or a newer snapshot.
    uint64 public lastRoundEpoch;
    mapping(RoundKind kind => uint256 roundId) public activeRound;
    mapping(uint256 roundId => Round) internal _rounds;
    mapping(uint256 roundId => uint32[]) internal _roundAssets;
    mapping(uint256 roundId => mapping(uint256 option => uint256 weight)) public tally;
    mapping(uint256 roundId => mapping(address account => bool)) public hasVoted;

    // ---------------------------------------------------------------------------------------------------------------
    // Decisions
    // ---------------------------------------------------------------------------------------------------------------

    Decision internal _currentDecision;
    mapping(uint256 decisionId => bool) internal _closeRequested;
    /// @notice WarchestVault, read only to gate close rounds. Set once by the guardian.
    address public vault;

    // ---------------------------------------------------------------------------------------------------------------
    // Events & errors
    // ---------------------------------------------------------------------------------------------------------------

    event WeightRootSubmitted(uint64 indexed epoch, bytes32 root, uint256 totalWeight, bytes32 treeHash);
    event WeightRootRevoked(uint64 indexed epoch, bytes32 root);
    event UpdaterChanged(address indexed previous, address indexed current);
    event GuardianTransferStarted(address indexed current, address indexed pending);
    event GuardianChanged(address indexed previous, address indexed current);
    event EligibleAssetsSet(uint32[] assets);
    event Paused(bool paused);
    event RoundStarted(uint256 indexed roundId, RoundKind kind, uint64 epoch, uint64 endsAt, uint256 targetDecisionId);
    event VoteCast(uint256 indexed roundId, address indexed voter, uint256 option, uint256 weight);
    event RoundFinalized(uint256 indexed roundId, bool quorate, uint256 winningOption, uint256 winningWeight);
    event DecisionMade(uint256 indexed decisionId, uint32 asset, Side side, uint256 indexed roundId);
    /// @notice Quorum missed or tie: the previous decision (possibly none) stands unchanged (D8).
    event FallbackToPreviousDecision(uint256 indexed roundId, uint256 indexed standingDecisionId);
    event CloseRequested(uint256 indexed decisionId, uint256 indexed roundId);
    event VaultSet(address vault);

    error ZeroAddress();
    error NotGuardian();
    error NotUpdater();
    error NotPendingGuardian();
    error EpochNotIncreasing(uint64 epoch, uint64 latest);
    error EmptyRoot();
    error RootNotRevocable(uint64 epoch);
    error InvalidParams();
    error InvalidAssets();
    error IsPaused();
    error RoundAlreadyActive(uint256 roundId);
    error RootNotUsable(uint64 epoch);
    error RootTooOld(uint64 epoch);
    error SnapshotGoesBackwards(uint64 epoch, uint64 lastRoundEpoch);
    error NoEligibleAssets();
    error RoundNotOpen(uint256 roundId);
    error AlreadyVoted(uint256 roundId, address voter);
    error InvalidOption(uint256 option);
    error ZeroWeight();
    error InvalidProof();
    error VaultAlreadySet();
    error RoundNotEnded(uint256 roundId);
    error AlreadyFinalized(uint256 roundId);
    error NoDecision();
    error CloseAlreadyRequested(uint256 decisionId);
    error CloseVoteNotAllowed(uint256 decisionId);

    // ---------------------------------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------------------------------

    constructor(address guardian_, address updater_, Params memory params) {
        if (guardian_ == address(0) || updater_ == address(0)) revert ZeroAddress();
        if (params.votingPeriod == 0 || params.quorumBps == 0 || params.quorumBps > BPS) revert InvalidParams();
        guardian = guardian_;
        updater = updater_;
        challengeWindow = params.challengeWindow;
        votingPeriod = params.votingPeriod;
        maxRootAge = params.maxRootAge;
        quorumBps = params.quorumBps;
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

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
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

    function setPaused(bool paused_) external onlyGuardian {
        paused = paused_;
        emit Paused(paused_);
    }

    /// @notice Sets the closed list of eligible Hyperliquid asset indices for FUTURE rounds (running rounds keep
    ///         their own copy). No duplicates, 1..MAX_ASSETS entries.
    function setEligibleAssets(uint32[] calldata assets) external onlyGuardian {
        if (assets.length == 0 || assets.length > MAX_ASSETS) revert InvalidAssets();
        for (uint256 i; i < assets.length; ++i) {
            for (uint256 j; j < i; ++j) {
                if (assets[i] == assets[j]) revert InvalidAssets();
            }
        }
        _eligibleAssets = assets;
        emit EligibleAssetsSet(assets);
    }

    /// @notice One-time wiring to the vault (only used to gate close rounds; governance never moves funds).
    function setVault(address vault_) external onlyGuardian {
        if (vault_ == address(0)) revert ZeroAddress();
        if (vault != address(0)) revert VaultAlreadySet();
        vault = vault_;
        emit VaultSet(vault_);
    }

    function eligibleAssets() external view returns (uint32[] memory) {
        return _eligibleAssets;
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

    // ---------------------------------------------------------------------------------------------------------------
    // Rounds & voting
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Opens a direction round (asset × Long/Short) on snapshot `epoch`. Permissionless.
    /// @dev The snapshot must be usable, not older than `maxRootAge` past its challenge window, and not older than
    ///      the snapshot of the previous round (nobody can cherry-pick an old, favourable snapshot).
    function startDirectionRound(uint64 epoch) external whenNotPaused returns (uint256 roundId) {
        if (_eligibleAssets.length == 0) revert NoEligibleAssets();
        roundId = _startRound(RoundKind.Direction, epoch, 0);
        _roundAssets[roundId] = _eligibleAssets;
    }

    /// @notice Casts the caller's full snapshot weight for `option`.
    /// @param option Direction round: `assetIndex * 2 + uint(Side)` where `assetIndex` indexes `roundAssets`.
    ///               Close round: 0 = keep the position, 1 = close it.
    /// @param weight The caller's weight in the round's snapshot tree.
    /// @param proof Merkle proof of `leaf(epoch, msg.sender, weight)`.
    function vote(uint256 roundId, uint256 option, uint256 weight, bytes32[] calldata proof) external whenNotPaused {
        Round storage r = _rounds[roundId];
        if (r.startsAt == 0 || r.finalized || block.timestamp >= r.endsAt) revert RoundNotOpen(roundId);
        if (hasVoted[roundId][msg.sender]) revert AlreadyVoted(roundId, msg.sender);
        if (option >= optionCount(roundId)) revert InvalidOption(option);
        if (weight == 0) revert ZeroWeight();
        if (!MerkleProof.verifyCalldata(proof, _roots[r.epoch].root, leaf(r.epoch, msg.sender, weight))) {
            revert InvalidProof();
        }

        hasVoted[roundId][msg.sender] = true;
        tally[roundId][option] += weight;
        r.totalVoted += weight;
        emit VoteCast(roundId, msg.sender, option, weight);
    }

    /// @notice Opens a yes/no round on voluntarily closing the position of the current decision. Permissionless, but
    ///         only when the vault reports that a position is open for it and its profit threshold is reached.
    function startCloseRound(uint64 epoch) external whenNotPaused returns (uint256 roundId) {
        uint256 decisionId = _currentDecision.id;
        if (decisionId == 0) revert NoDecision();
        if (_closeRequested[decisionId]) revert CloseAlreadyRequested(decisionId);
        if (vault == address(0) || !IWarchestVaultView(vault).closeVoteAllowed(decisionId)) {
            revert CloseVoteNotAllowed(decisionId);
        }
        roundId = _startRound(RoundKind.Close, epoch, decisionId);
    }

    /// @notice Closes the tally of an ended round. Permissionless.
    /// @dev Direction round: a NEW decision is minted only if quorum is reached and the top option is unique;
    ///      otherwise the previous decision stands unchanged (same id) — DECISIONS.md D8.
    ///      Close round: the close is requested only if quorum is reached and "close" strictly beats "keep".
    function finalize(uint256 roundId) external whenNotPaused {
        Round storage r = _rounds[roundId];
        if (r.startsAt == 0) revert RoundNotOpen(roundId);
        if (r.finalized) revert AlreadyFinalized(roundId);
        if (block.timestamp < r.endsAt) revert RoundNotEnded(roundId);

        r.finalized = true;
        activeRound[r.kind] = 0;

        bool quorate = r.totalVoted * BPS >= uint256(quorumBps) * _roots[r.epoch].totalWeight;
        (uint256 winner, uint256 winnerWeight, bool unique) = _leader(roundId);
        emit RoundFinalized(roundId, quorate, winner, winnerWeight);

        if (r.kind == RoundKind.Direction) {
            if (quorate && unique && winnerWeight > 0) {
                (uint32 asset, Side side) = decodeOption(roundId, winner);
                uint256 id = _currentDecision.id + 1;
                _currentDecision =
                    Decision({id: id, asset: asset, side: side, roundId: roundId, decidedAt: uint64(block.timestamp)});
                emit DecisionMade(id, asset, side, roundId);
            } else {
                emit FallbackToPreviousDecision(roundId, _currentDecision.id);
            }
        } else if (quorate && unique && winner == 1) {
            _closeRequested[r.targetDecisionId] = true;
            emit CloseRequested(r.targetDecisionId, roundId);
        }
    }

    function currentDecision() external view returns (Decision memory) {
        return _currentDecision;
    }

    function isCloseRequested(uint256 decisionId) external view returns (bool) {
        return _closeRequested[decisionId];
    }

    function getRound(uint256 roundId) external view returns (Round memory) {
        return _rounds[roundId];
    }

    function roundAssets(uint256 roundId) external view returns (uint32[] memory) {
        return _roundAssets[roundId];
    }

    function optionCount(uint256 roundId) public view returns (uint256) {
        return _rounds[roundId].kind == RoundKind.Direction ? _roundAssets[roundId].length * 2 : 2;
    }

    /// @notice Decodes a direction-round option into its Hyperliquid asset index and side.
    function decodeOption(uint256 roundId, uint256 option) public view returns (uint32 asset, Side side) {
        if (_rounds[roundId].kind != RoundKind.Direction || option >= optionCount(roundId)) {
            revert InvalidOption(option);
        }
        return (_roundAssets[roundId][option / 2], Side(option % 2));
    }

    /// @dev Highest-weight option, its weight, and whether no other option has the same weight.
    function _leader(uint256 roundId) internal view returns (uint256 winner, uint256 best, bool unique) {
        uint256 n = optionCount(roundId);
        unique = true;
        for (uint256 o; o < n; ++o) {
            uint256 w = tally[roundId][o];
            if (w > best) {
                (winner, best, unique) = (o, w, true);
            } else if (w == best) {
                unique = false;
            }
        }
    }

    function _startRound(RoundKind kind, uint64 epoch, uint256 targetDecisionId) internal returns (uint256 roundId) {
        uint256 active = activeRound[kind];
        if (active != 0) revert RoundAlreadyActive(active);
        if (!isRootUsable(epoch)) revert RootNotUsable(epoch);
        if (block.timestamp > uint256(_roots[epoch].submittedAt) + challengeWindow + maxRootAge) {
            revert RootTooOld(epoch);
        }
        if (epoch < lastRoundEpoch) revert SnapshotGoesBackwards(epoch, lastRoundEpoch);

        roundId = ++roundCount;
        uint64 endsAt = uint64(block.timestamp) + votingPeriod;
        _rounds[roundId] = Round({
            kind: kind,
            epoch: epoch,
            startsAt: uint64(block.timestamp),
            endsAt: endsAt,
            finalized: false,
            totalVoted: 0,
            targetDecisionId: targetDecisionId
        });
        activeRound[kind] = roundId;
        lastRoundEpoch = epoch;
        emit RoundStarted(roundId, kind, epoch, endsAt, targetDecisionId);
    }

    /// @notice Merkle leaf for (`epoch`, `account`, `weight`), exposed for off-chain tooling and tests.
    function leaf(uint64 epoch, address account, uint256 weight) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(epoch, account, weight))));
    }
}
