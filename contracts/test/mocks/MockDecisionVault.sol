// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWarchestDecisionSource, IWarchestVaultView} from "../../src/interfaces/IWarchestDecisionSource.sol";

/// @notice Stand-in for WarchestVault while governance is built in isolation (PLAN S2): it only models the
///         "execute each decision id at most once" rule and the profit-threshold gate for close votes.
contract MockDecisionVault is IWarchestVaultView {
    IWarchestDecisionSource public immutable governance;
    uint256 public lastExecutedDecision;
    uint256 public openDecision; // 0 = flat
    bool public profitThresholdReached;

    constructor(IWarchestDecisionSource governance_) {
        governance = governance_;
    }

    function setProfitThresholdReached(bool v) external {
        profitThresholdReached = v;
    }

    /// Opens a position for the current decision if it was never executed. Returns true if it opened.
    function execute() external returns (bool) {
        IWarchestDecisionSource.Decision memory d = governance.currentDecision();
        if (d.id == 0 || d.id <= lastExecutedDecision) return false;
        lastExecutedDecision = d.id;
        openDecision = d.id;
        return true;
    }

    function stopLoss() external {
        openDecision = 0;
    }

    /// Closes if governance requested it.
    function applyClose() external returns (bool) {
        if (openDecision == 0 || !governance.isCloseRequested(openDecision)) return false;
        openDecision = 0;
        return true;
    }

    function closeVoteAllowed(uint256 decisionId) external view returns (bool) {
        return openDecision == decisionId && decisionId != 0 && profitThresholdReached;
    }
}
