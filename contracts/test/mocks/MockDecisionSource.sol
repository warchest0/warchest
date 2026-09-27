// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWarchestDecisionSource} from "../../src/interfaces/IWarchestDecisionSource.sol";
import {WarchestGovernance} from "../../src/WarchestGovernance.sol";

/// @notice Governance stand-in for vault unit tests: decisions, close requests and round end times are set directly.
contract MockDecisionSource is IWarchestDecisionSource {
    Decision internal _decision;
    mapping(uint256 decisionId => bool) internal _closeRequested;
    mapping(uint256 roundId => uint64 endsAt) internal _roundEndsAt;

    /// Mints decision `id` for (`asset`, `side`) from a round that ended at `endsAt`.
    function setDecision(uint256 id, uint32 asset, Side side, uint256 roundId, uint64 endsAt) external {
        _decision = Decision({id: id, asset: asset, side: side, roundId: roundId, decidedAt: endsAt});
        _roundEndsAt[roundId] = endsAt;
    }

    /// Mints the next decision id for (`asset`, `side`) with a round ending now.
    function nextDecision(uint32 asset, Side side) external returns (uint256 id) {
        id = _decision.id + 1;
        uint256 roundId = _decision.roundId + 1;
        _decision = Decision({id: id, asset: asset, side: side, roundId: roundId, decidedAt: uint64(block.timestamp)});
        _roundEndsAt[roundId] = uint64(block.timestamp);
    }

    function setCloseRequested(uint256 decisionId, bool v) external {
        _closeRequested[decisionId] = v;
    }

    function currentDecision() external view returns (Decision memory) {
        return _decision;
    }

    function isCloseRequested(uint256 decisionId) external view returns (bool) {
        return _closeRequested[decisionId];
    }

    /// Same shape as `WarchestGovernance.getRound`; only `endsAt` is meaningful here.
    function getRound(uint256 roundId) external view returns (WarchestGovernance.Round memory r) {
        r.endsAt = _roundEndsAt[roundId];
        r.finalized = true;
    }
}
