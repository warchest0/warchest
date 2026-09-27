// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @notice The only vault function the distributor uses.
interface IWarchestVaultDistribution {
    function distributable() external view returns (uint256);
    function pullDistributable(uint256 amount) external;
}

/// @title WarchestDistributor
/// @notice Distributes realized treasury profit (USDG, above the vault's high-water mark) to holders with cumulative
///         merkle claims (pattern: Morpho Universal Rewards Distributor). DECISIONS.md D7 — whether this module is
///         wired at all is a legal decision: the vault's `distributor` is immutable, `address(0)` disables it.
/// @dev Flow:
///      1. `fund()` (permissionless) pulls `vault.distributable()` into this contract → `totalFunded` grows.
///      2. The updater (indexer) splits each funding by the level-weighted snapshot weights and publishes a root of
///         CUMULATIVE entitlements `(account, cumulativeAmount)` plus their sum `totalCumulative`.
///      3. The root is pending for `timelock`; the guardian may revoke it. Unlike Morpho URD, a pending root can NOT
///         be replaced by the updater (which would let a compromised updater reset the timelock forever): it is
///         either accepted or revoked by the guardian.
///      4. `claim` pays `cumulativeAmount − claimed[account]` to the account (anyone may trigger it).
///      Safety bounds: `totalCumulative ≤ totalFunded` and never decreases; total claims never exceed the active
///      root's `totalCumulative`, so an under-declared tree can at worst stall late claimers, never overdraw.
///      The guardian can never move funds.
contract WarchestDistributor is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct PendingRoot {
        bytes32 root;
        uint256 totalCumulative;
        bytes32 treeHash;
        uint64 readyAt;
    }

    IERC20 public immutable usdg;
    uint64 public immutable timelock;

    address public guardian;
    address public pendingGuardian;
    address public updater;
    /// @notice Set once (the vault takes this contract's address in its constructor).
    IWarchestVaultDistribution public vault;

    /// @notice Active root of cumulative entitlements.
    bytes32 public root;
    /// @notice Σ of cumulative entitlements in the active root.
    uint256 public totalCumulative;
    /// @notice Content hash of the published tree for the active root.
    bytes32 public treeHash;
    PendingRoot public pending;

    uint256 public totalFunded;
    uint256 public totalClaimed;
    mapping(address account => uint256) public claimed;

    event VaultSet(address vault);
    event Funded(uint256 amount, uint256 totalFunded);
    event RootProposed(bytes32 root, uint256 totalCumulative, bytes32 treeHash, uint64 readyAt);
    event RootRevoked(bytes32 root);
    event RootAccepted(bytes32 root, uint256 totalCumulative, bytes32 treeHash);
    event Claimed(address indexed account, uint256 amount, uint256 cumulativeAmount);
    event UpdaterChanged(address indexed previous, address indexed current);
    event GuardianTransferStarted(address indexed current, address indexed pending);
    event GuardianChanged(address indexed previous, address indexed current);

    error ZeroAddress();
    error NotGuardian();
    error NotUpdater();
    error NotPendingGuardian();
    error VaultAlreadySet();
    error VaultNotSet();
    error NothingToFund();
    error PendingRootExists();
    error NoPendingRoot();
    error TimelockNotElapsed(uint64 readyAt);
    error EmptyRoot();
    error CumulativeDecreased(uint256 proposed, uint256 current);
    error ExceedsFunded(uint256 proposed, uint256 funded);
    error InvalidProof();
    error NothingToClaim();
    error ExceedsRootTotal();

    constructor(IERC20 usdg_, address guardian_, address updater_, uint64 timelock_) {
        if (address(usdg_) == address(0) || guardian_ == address(0) || updater_ == address(0)) revert ZeroAddress();
        usdg = usdg_;
        guardian = guardian_;
        updater = updater_;
        timelock = timelock_;
        emit GuardianChanged(address(0), guardian_);
        emit UpdaterChanged(address(0), updater_);
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Wiring & roles
    // ---------------------------------------------------------------------------------------------------------------

    function setVault(IWarchestVaultDistribution vault_) external onlyGuardian {
        if (address(vault_) == address(0)) revert ZeroAddress();
        if (address(vault) != address(0)) revert VaultAlreadySet();
        vault = vault_;
        emit VaultSet(address(vault_));
    }

    /// @notice Rotating the updater cannot shortcut the timelock: any root it proposes still waits and is revocable.
    function setUpdater(address updater_) external onlyGuardian {
        if (updater_ == address(0)) revert ZeroAddress();
        emit UpdaterChanged(updater, updater_);
        updater = updater_;
    }

    function transferGuardian(address pending_) external onlyGuardian {
        pendingGuardian = pending_;
        emit GuardianTransferStarted(guardian, pending_);
    }

    function acceptGuardian() external {
        if (msg.sender != pendingGuardian) revert NotPendingGuardian();
        emit GuardianChanged(guardian, msg.sender);
        guardian = msg.sender;
        pendingGuardian = address(0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Funding
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Pulls all profit the vault currently allows (above its high-water mark). Permissionless.
    function fund() external nonReentrant returns (uint256 amount) {
        if (address(vault) == address(0)) revert VaultNotSet();
        amount = vault.distributable();
        if (amount == 0) revert NothingToFund();
        uint256 before = usdg.balanceOf(address(this));
        vault.pullDistributable(amount);
        amount = usdg.balanceOf(address(this)) - before; // measured, not trusted
        totalFunded += amount;
        emit Funded(amount, totalFunded);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Roots
    // ---------------------------------------------------------------------------------------------------------------

    function proposeRoot(bytes32 root_, uint256 totalCumulative_, bytes32 treeHash_) external {
        if (msg.sender != updater) revert NotUpdater();
        if (root_ == bytes32(0)) revert EmptyRoot();
        if (pending.root != bytes32(0)) revert PendingRootExists();
        if (totalCumulative_ < totalCumulative) revert CumulativeDecreased(totalCumulative_, totalCumulative);
        if (totalCumulative_ > totalFunded) revert ExceedsFunded(totalCumulative_, totalFunded);
        uint64 readyAt = uint64(block.timestamp) + timelock;
        pending = PendingRoot(root_, totalCumulative_, treeHash_, readyAt);
        emit RootProposed(root_, totalCumulative_, treeHash_, readyAt);
    }

    function revokePendingRoot() external onlyGuardian {
        if (pending.root == bytes32(0)) revert NoPendingRoot();
        emit RootRevoked(pending.root);
        delete pending;
    }

    /// @notice Activates the pending root once its timelock has elapsed. Permissionless.
    function acceptRoot() external {
        PendingRoot memory p = pending;
        if (p.root == bytes32(0)) revert NoPendingRoot();
        if (block.timestamp < p.readyAt) revert TimelockNotElapsed(p.readyAt);
        root = p.root;
        totalCumulative = p.totalCumulative;
        treeHash = p.treeHash;
        delete pending;
        emit RootAccepted(p.root, p.totalCumulative, p.treeHash);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Claims
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Pays `account` everything it is owed under the active root. Anyone may call; funds go to `account`.
    function claim(address account, uint256 cumulativeAmount, bytes32[] calldata proof)
        external
        nonReentrant
        returns (uint256 amount)
    {
        if (!MerkleProof.verifyCalldata(proof, root, leaf(account, cumulativeAmount))) {
            revert InvalidProof();
        }
        uint256 already = claimed[account];
        if (cumulativeAmount <= already) revert NothingToClaim();
        amount = cumulativeAmount - already;
        if (totalClaimed + amount > totalCumulative) revert ExceedsRootTotal();

        claimed[account] = cumulativeAmount;
        totalClaimed += amount;
        usdg.safeTransfer(account, amount);
        emit Claimed(account, amount, cumulativeAmount);
    }

    /// @notice Leaf of the cumulative-entitlement tree, domain-separated by chain and contract.
    function leaf(address account, uint256 cumulativeAmount) public view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), account, cumulativeAmount))));
    }
}
