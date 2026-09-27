// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {WarchestGovernance} from "../../src/WarchestGovernance.sol";
import {GovernanceFixture} from "../utils/GovernanceFixture.sol";

/// @notice Drives governance through random rounds, votes, snapshots and finalizations.
contract GovernanceHandler is GovernanceFixture {
    uint256 public ghostDecisions;
    uint256 public lastSeenDecisionId;
    bool public decisionWentBackwards;
    uint64 public epochCursor;

    constructor(WarchestGovernance gov_, address guardian_, address updater_) {
        gov = gov_;
        guardian = guardian_;
        updater = updater_;
        _defaultVoters();
        epochCursor = EPOCH;
    }

    function publishSnapshot(uint256 seed) external {
        // random weights each day; voters stay the same
        for (uint256 i; i < weights.length; ++i) {
            weights[i] = bound(uint256(keccak256(abi.encode(seed, i))), 1, 1e24);
        }
        vm.warp(block.timestamp + 1 hours);
        _publish(++epochCursor);
    }

    function startRound() external {
        if (gov.activeRound(WarchestGovernance.RoundKind.Direction) != 0) return;
        if (!gov.isRootUsable(epochCursor)) return;
        try gov.startDirectionRound(epochCursor) {} catch {}
    }

    function vote(uint256 voterSeed, uint256 option) external {
        uint256 id = gov.activeRound(WarchestGovernance.RoundKind.Direction);
        if (id == 0) return;
        WarchestGovernance.Round memory r = gov.getRound(id);
        if (block.timestamp >= r.endsAt || r.epoch != epochCursor) return;
        uint256 i = voterSeed % voters.length;
        if (gov.hasVoted(id, voters[i])) return;
        _vote(id, i, option % gov.optionCount(id));
    }

    function finalize(uint256 warpBy) external {
        uint256 id = gov.activeRound(WarchestGovernance.RoundKind.Direction);
        if (id == 0) return;
        vm.warp(block.timestamp + bound(warpBy, 0, 2 days));
        if (block.timestamp < gov.getRound(id).endsAt) return;
        uint256 before = gov.currentDecision().id;
        gov.finalize(id);
        uint256 afterId = gov.currentDecision().id;
        if (afterId < before) decisionWentBackwards = true;
        if (afterId == before + 1) ghostDecisions++;
        lastSeenDecisionId = afterId;
    }
}

contract GovernanceInvariantTest is Test {
    WarchestGovernance gov;
    GovernanceHandler handler;
    address guardian = makeAddr("guardian");
    address updater = makeAddr("updater");

    function setUp() public {
        vm.warp(1_700_000_000);
        gov = new WarchestGovernance(
            guardian,
            updater,
            WarchestGovernance.Params({
                challengeWindow: 6 hours, votingPeriod: 1 days, maxRootAge: 2 days, quorumBps: 1000
            })
        );
        uint32[] memory assets = new uint32[](3);
        (assets[0], assets[1], assets[2]) = (0, 1, 5);
        vm.prank(guardian);
        gov.setEligibleAssets(assets);

        handler = new GovernanceHandler(gov, guardian, updater);
        handler.publishSnapshot(1);
        targetContract(address(handler));
    }

    /// Σ tallies == totalVoted ≤ snapshot total weight, for every round.
    function invariant_talliesConsistent() public view {
        for (uint256 id = 1; id <= gov.roundCount(); ++id) {
            WarchestGovernance.Round memory r = gov.getRound(id);
            uint256 sum;
            for (uint256 o; o < gov.optionCount(id); ++o) {
                sum += gov.tally(id, o);
            }
            assertEq(sum, r.totalVoted);
            assertLe(r.totalVoted, gov.weightRoot(r.epoch).totalWeight);
        }
    }

    function invariant_decisionIdsMonotonicAndCounted() public view {
        assertFalse(handler.decisionWentBackwards());
        assertEq(gov.currentDecision().id, handler.ghostDecisions());
    }

    function invariant_activeRoundIsOpen() public view {
        uint256 id = gov.activeRound(WarchestGovernance.RoundKind.Direction);
        if (id != 0) assertFalse(gov.getRound(id).finalized);
        for (uint256 i = 1; i <= gov.roundCount(); ++i) {
            if (i != id) assertTrue(gov.getRound(i).finalized);
        }
    }

    function invariant_holdsNoFunds() public view {
        assertEq(address(gov).balance, 0);
    }
}
