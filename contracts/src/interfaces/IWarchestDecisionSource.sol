// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IWarchestDecisionSource
/// @notice Read-only view of governance outcomes consumed by WarchestVault. Governance and vault stay two separate
///         contracts: the vault only READS decisions, governance never touches funds.
interface IWarchestDecisionSource {
    enum Side {
        Long,
        Short
    }

    struct Decision {
        /// Monotonic id; 0 = no decision yet. A new id is minted ONLY by a quorate, unambiguous direction round.
        /// When quorum is missed the previous decision stands with the SAME id, so a vault that executes each id
        /// at most once never re-opens a position that was stopped out (DECISIONS.md D8).
        uint256 id;
        /// Hyperliquid perp asset index.
        uint32 asset;
        Side side;
        uint256 roundId;
        uint64 decidedAt;
    }

    function currentDecision() external view returns (Decision memory);

    /// @notice True once a quorate close round voted to close the position opened for `decisionId`.
    function isCloseRequested(uint256 decisionId) external view returns (bool);
}

/// @title IWarchestVaultView
/// @notice The only thing governance reads from the vault: whether a voluntary close vote may be opened
///         (a position is open for `decisionId` and its profit threshold has been reached).
interface IWarchestVaultView {
    function closeVoteAllowed(uint256 decisionId) external view returns (bool);
}
