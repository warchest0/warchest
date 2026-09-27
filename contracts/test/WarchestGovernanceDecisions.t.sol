// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWarchestDecisionSource} from "../src/interfaces/IWarchestDecisionSource.sol";
import {WarchestGovernance} from "../src/WarchestGovernance.sol";
import {GovernanceFixture} from "./utils/GovernanceFixture.sol";
import {MockDecisionVault} from "./mocks/MockDecisionVault.sol";

contract WarchestGovernanceDecisionsTest is GovernanceFixture {
    MockDecisionVault vault;
    uint64 epoch = EPOCH;

    function setUp() public {
        vm.warp(1_700_000_000);
        _deployGovernance();
        _defaultVoters(); // weights 400, 300, 150, 100, 50 (total 1000, quorum 100)
        _publish(epoch);
        vault = new MockDecisionVault(gov);
        vm.prank(guardian);
        gov.setVault(address(vault));
    }

    function _nextSnapshot() internal {
        vm.warp(block.timestamp + 1 days);
        _publish(++epoch);
    }

    function _endAndFinalize(uint256 id) internal {
        vm.warp(gov.getRound(id).endsAt);
        gov.finalize(id);
    }

    function _decision() internal view returns (IWarchestDecisionSource.Decision memory) {
        return gov.currentDecision();
    }

    uint256 constant BTC_LONG = 0;
    uint256 constant BTC_SHORT = 1;
    uint256 constant ETH_LONG = 2;
    uint256 constant SOL_SHORT = 5;

    // ------------------------------------------------------------------ finalize basics

    function test_finalize_quorateMintsDecision() public {
        uint256 id = gov.startDirectionRound(epoch);
        _vote(id, 0, SOL_SHORT); // 400
        _vote(id, 1, BTC_LONG); // 300
        _endAndFinalize(id);

        IWarchestDecisionSource.Decision memory d = _decision();
        assertEq(d.id, 1);
        assertEq(d.asset, SOL);
        assertEq(uint8(d.side), uint8(IWarchestDecisionSource.Side.Short));
        assertEq(d.roundId, id);
        assertEq(d.decidedAt, block.timestamp);
        assertEq(gov.activeRound(WarchestGovernance.RoundKind.Direction), 0);
        assertTrue(gov.getRound(id).finalized);
    }

    function test_finalize_exactlyAtQuorum() public {
        uint256 id = gov.startDirectionRound(epoch);
        _vote(id, 3, ETH_LONG); // 100 = exactly 10% of 1000
        _endAndFinalize(id);
        assertEq(_decision().id, 1);
        assertEq(_decision().asset, ETH);
    }

    function test_finalize_revertsBeforeEnd_andTwice() public {
        uint256 id = gov.startDirectionRound(epoch);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.RoundNotEnded.selector, id));
        gov.finalize(id);
        _endAndFinalize(id);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.AlreadyFinalized.selector, id));
        gov.finalize(id);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.RoundNotOpen.selector, 99));
        gov.finalize(99);
    }

    function test_finalize_blockedWhenPaused() public {
        uint256 id = gov.startDirectionRound(epoch);
        vm.warp(gov.getRound(id).endsAt);
        vm.prank(guardian);
        gov.setPaused(true);
        vm.expectRevert(WarchestGovernance.IsPaused.selector);
        gov.finalize(id);
    }

    function test_finalize_allowsNextRound() public {
        uint256 id = gov.startDirectionRound(epoch);
        _endAndFinalize(id);
        _nextSnapshot();
        assertEq(gov.startDirectionRound(epoch), id + 1);
    }

    // ------------------------------------------------------------------ D8 fallback

    function test_fallback_noQuorum_noPreviousDecision() public {
        uint256 id = gov.startDirectionRound(epoch);
        _vote(id, 4, BTC_LONG); // 50 < 100
        vm.warp(gov.getRound(id).endsAt);
        vm.expectEmit(address(gov));
        emit WarchestGovernance.FallbackToPreviousDecision(id, 0);
        gov.finalize(id);
        assertEq(_decision().id, 0); // nothing to do
    }

    function test_fallback_noQuorum_previousDecisionStands() public {
        uint256 id = gov.startDirectionRound(epoch);
        _vote(id, 0, BTC_LONG);
        _endAndFinalize(id);
        IWarchestDecisionSource.Decision memory before = _decision();

        _nextSnapshot();
        id = gov.startDirectionRound(epoch);
        _vote(id, 4, SOL_SHORT); // 50: no quorum
        _endAndFinalize(id);
        IWarchestDecisionSource.Decision memory afterFallback = _decision();
        assertEq(afterFallback.id, before.id);
        assertEq(afterFallback.asset, before.asset);
        assertEq(uint8(afterFallback.side), uint8(before.side));
        assertEq(afterFallback.roundId, before.roundId);
    }

    function test_fallback_tieKeepsPreviousDecision() public {
        voters.push(makeAddr("twin"));
        weights.push(400); // ties voter0
        _nextSnapshot();
        uint256 id = gov.startDirectionRound(epoch);
        _vote(id, 0, BTC_LONG);
        _vote(id, 5, ETH_LONG);
        _endAndFinalize(id);
        assertEq(_decision().id, 0);
    }

    /// D8 core rule: a stopped-out position is NEVER re-opened by a quorum-less round.
    function test_fallback_neverReopensStoppedPosition() public {
        uint256 id = gov.startDirectionRound(epoch);
        _vote(id, 0, BTC_LONG);
        _endAndFinalize(id);
        assertTrue(vault.execute());
        vault.stopLoss();

        _nextSnapshot();
        id = gov.startDirectionRound(epoch);
        _vote(id, 4, BTC_LONG); // no quorum → previous decision stands, same id
        _endAndFinalize(id);
        assertFalse(vault.execute(), "stopped position re-opened");
        assertEq(vault.openDecision(), 0);

        _nextSnapshot();
        id = gov.startDirectionRound(epoch);
        _vote(id, 0, BTC_LONG); // quorate, same choice → NEW decision id → may open again
        _endAndFinalize(id);
        assertEq(_decision().id, 2);
        assertTrue(vault.execute());
    }

    // ------------------------------------------------------------------ close rounds

    function _openPosition() internal returns (uint256 decisionId) {
        uint256 id = gov.startDirectionRound(epoch);
        _vote(id, 0, ETH_LONG);
        _endAndFinalize(id);
        vault.execute();
        _nextSnapshot();
        return _decision().id;
    }

    function test_close_requiresDecision() public {
        vm.expectRevert(WarchestGovernance.NoDecision.selector);
        gov.startCloseRound(epoch);
    }

    function test_close_requiresProfitThreshold() public {
        uint256 d = _openPosition();
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.CloseVoteNotAllowed.selector, d));
        gov.startCloseRound(epoch);
    }

    function test_close_requiresVault() public {
        WarchestGovernance g2 = new WarchestGovernance(guardian, updater, _params());
        vm.expectRevert(WarchestGovernance.NoDecision.selector);
        g2.startCloseRound(epoch);
    }

    function test_close_quorateYesRequestsClose() public {
        uint256 d = _openPosition();
        vault.setProfitThresholdReached(true);
        uint256 id = gov.startCloseRound(epoch);
        assertEq(gov.getRound(id).targetDecisionId, d);
        assertEq(gov.optionCount(id), 2);
        _vote(id, 0, 1); // close: 400
        _vote(id, 1, 0); // keep: 300
        _endAndFinalize(id);
        assertTrue(gov.isCloseRequested(d));
        assertTrue(vault.applyClose());

        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.CloseAlreadyRequested.selector, d));
        gov.startCloseRound(epoch);
    }

    function test_close_keepWinsOrNoQuorum_noClose() public {
        uint256 d = _openPosition();
        vault.setProfitThresholdReached(true);
        uint256 id = gov.startCloseRound(epoch);
        _vote(id, 0, 0); // keep 400
        _vote(id, 1, 1); // close 300
        _endAndFinalize(id);
        assertFalse(gov.isCloseRequested(d));

        _nextSnapshot();
        id = gov.startCloseRound(epoch);
        _vote(id, 4, 1); // 50 < quorum
        _endAndFinalize(id);
        assertFalse(gov.isCloseRequested(d));
    }

    function test_close_tieDoesNotClose() public {
        uint256 d = _openPosition();
        voters.push(makeAddr("twin"));
        weights.push(400); // ties voter0 in the next snapshot
        _nextSnapshot();
        vault.setProfitThresholdReached(true);
        uint256 id = gov.startCloseRound(epoch);
        _vote(id, 0, 1);
        _vote(id, 5, 0);
        _endAndFinalize(id);
        assertFalse(gov.isCloseRequested(d));
    }

    function test_closeAndDirectionRoundsCanRunInParallel() public {
        _openPosition();
        vault.setProfitThresholdReached(true);
        uint256 c = gov.startCloseRound(epoch);
        uint256 dRound = gov.startDirectionRound(epoch);
        assertEq(gov.activeRound(WarchestGovernance.RoundKind.Close), c);
        assertEq(gov.activeRound(WarchestGovernance.RoundKind.Direction), dRound);
    }

    function test_closeVotesDoNotAffectDirectionTally() public {
        _openPosition();
        vault.setProfitThresholdReached(true);
        uint256 c = gov.startCloseRound(epoch);
        uint256 dRound = gov.startDirectionRound(epoch);
        _vote(c, 0, 1);
        _vote(dRound, 0, BTC_SHORT); // same voter, different round: allowed
        assertEq(gov.tally(c, 1), 400);
        assertEq(gov.tally(dRound, BTC_SHORT), 400);
    }

    function test_setVault_onceOnlyByGuardian() public {
        vm.expectRevert(WarchestGovernance.NotGuardian.selector);
        gov.setVault(address(1));
        vm.prank(guardian);
        vm.expectRevert(WarchestGovernance.VaultAlreadySet.selector);
        gov.setVault(address(1));
    }

    function testFuzz_decisionMatchesPlurality(uint256[5] memory options) public {
        uint256 id = gov.startDirectionRound(epoch);
        uint256[6] memory expected;
        for (uint256 i; i < 5; ++i) {
            options[i] = bound(options[i], 0, 5);
            _vote(id, i, options[i]);
            expected[options[i]] += weights[i];
        }
        uint256 best;
        uint256 bestOpt;
        bool unique;
        for (uint256 o; o < 6; ++o) {
            if (expected[o] > best) (best, bestOpt, unique) = (expected[o], o, true);
            else if (expected[o] == best) unique = false;
        }
        _endAndFinalize(id);
        if (unique) {
            (uint32 asset, IWarchestDecisionSource.Side side) = gov.decodeOption(id, bestOpt);
            assertEq(_decision().id, 1);
            assertEq(_decision().asset, asset);
            assertEq(uint8(_decision().side), uint8(side));
        } else {
            assertEq(_decision().id, 0);
        }
    }
}
