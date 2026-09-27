// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWarchestDecisionSource} from "../src/interfaces/IWarchestDecisionSource.sol";
import {WarchestGovernance} from "../src/WarchestGovernance.sol";
import {GovernanceFixture} from "./utils/GovernanceFixture.sol";
import {MerkleHelper} from "./utils/MerkleHelper.sol";

/// @notice Regression tests for the adversarial review of WarchestGovernance (each was a working PoC before the fix).
contract WarchestGovernanceHardeningTest is GovernanceFixture {
    uint64 epoch = EPOCH;

    function setUp() public {
        vm.warp(1_700_000_000);
        _deployGovernance();
        _defaultVoters(); // 400, 300, 150, 100, 50
        _publish(epoch);
    }

    // HIGH-1 — pausing mid-round used to freeze a minority tally and let it finalize later.
    function test_pauseVoidsRunningRound_noForcedOutcome() public {
        uint256 id = gov.startDirectionRound(epoch);
        _vote(id, 3, 5); // 100 weight on SOL_SHORT, quorum reached
        vm.prank(guardian);
        gov.setPaused(true);
        assertTrue(gov.voided(id));

        vm.warp(gov.getRound(id).endsAt);
        vm.prank(guardian);
        gov.setPaused(false);
        gov.finalize(id);
        assertEq(gov.currentDecision().id, 0, "guardian forced an outcome");
    }

    function test_pauseAfterEnd_doesNotVoid() public {
        uint256 id = gov.startDirectionRound(epoch);
        _vote(id, 0, 0);
        vm.warp(gov.getRound(id).endsAt);
        vm.prank(guardian);
        gov.setPaused(true);
        assertFalse(gov.voided(id));
        vm.prank(guardian);
        gov.setPaused(false);
        gov.finalize(id);
        assertEq(gov.currentDecision().id, 1);
    }

    function test_cancelRound_onlyFallsBack() public {
        uint256 id = gov.startDirectionRound(epoch);
        _vote(id, 0, 0);
        vm.expectRevert(WarchestGovernance.NotGuardian.selector);
        gov.cancelRound(id);
        vm.prank(guardian);
        gov.cancelRound(id);
        vm.warp(gov.getRound(id).endsAt);
        gov.finalize(id);
        assertEq(gov.currentDecision().id, 0);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.AlreadyFinalized.selector, id));
        gov.cancelRound(id);
    }

    // HIGH-2 — guardian used to rotate the updater to itself and forge weights within one round.
    function test_updaterRotationIsDelayed() public {
        uint64 delay = gov.updaterDelay();
        assertEq(delay, WINDOW + VOTING + MAX_AGE);
        vm.prank(guardian);
        gov.proposeUpdater(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(WarchestGovernance.UpdaterDelayNotElapsed.selector, block.timestamp + delay)
        );
        gov.applyUpdaterChange();
        vm.prank(guardian);
        vm.expectRevert(WarchestGovernance.NotUpdater.selector);
        gov.submitWeightRoot(epoch + 1, bytes32(uint256(1)), 1, 0);

        vm.warp(block.timestamp + delay);
        gov.applyUpdaterChange(); // permissionless once public for the full delay
        assertEq(gov.updater(), guardian);
    }

    function test_updaterRotationCanBeCancelled() public {
        vm.startPrank(guardian);
        vm.expectRevert(WarchestGovernance.NoPendingUpdater.selector);
        gov.cancelUpdaterChange();
        gov.proposeUpdater(makeAddr("x"));
        gov.cancelUpdaterChange();
        vm.stopPrank();
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(WarchestGovernance.NoPendingUpdater.selector);
        gov.applyUpdaterChange();
    }

    // HIGH-3 — a far-future epoch used to brick submissions forever.
    function test_futureEpochRejected() public {
        uint64 tomorrow = uint64(block.timestamp / 1 days + 1);
        vm.startPrank(updater);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.EpochInFuture.selector, type(uint64).max));
        gov.submitWeightRoot(type(uint64).max, bytes32(uint256(1)), 1, 0);
        gov.submitWeightRoot(tomorrow, bytes32(uint256(1)), 1, 0); // allowed
        vm.stopPrank();
    }

    function test_revokingLatestRollsBack() public {
        vm.warp(block.timestamp + 1 days);
        vm.prank(updater);
        gov.submitWeightRoot(epoch + 1, bytes32(uint256(1)), 1, 0);
        vm.prank(guardian);
        gov.revokeWeightRoot(epoch + 1);
        assertEq(gov.latestEpoch(), epoch);
        vm.prank(updater);
        gov.submitWeightRoot(epoch + 1, bytes32(uint256(2)), 1, 0); // fixed tree
        assertEq(gov.prevEpoch(epoch + 1), epoch);
    }

    // MEDIUM-1 / MEDIUM-2 — zero or overflowing total weight.
    function test_totalWeightBounds() public {
        vm.warp(block.timestamp + 1 days);
        vm.startPrank(updater);
        vm.expectRevert(WarchestGovernance.InvalidTotalWeight.selector);
        gov.submitWeightRoot(epoch + 1, bytes32(uint256(1)), 0, 0);
        vm.expectRevert(WarchestGovernance.InvalidTotalWeight.selector);
        gov.submitWeightRoot(epoch + 1, bytes32(uint256(1)), type(uint256).max, 0);
        gov.submitWeightRoot(epoch + 1, bytes32(uint256(1)), gov.MAX_TOTAL_WEIGHT(), 0);
        vm.stopPrank();
    }

    function test_maxTotalWeightFinalizesWithoutOverflow() public {
        vm.warp(block.timestamp + 1 days);
        weights[0] = gov.MAX_TOTAL_WEIGHT() - 600;
        bytes32 root = MerkleHelper.root(_leaves(epoch + 1));
        uint256 maxW = gov.MAX_TOTAL_WEIGHT();
        vm.prank(updater);
        gov.submitWeightRoot(epoch + 1, root, maxW, 0);
        vm.warp(block.timestamp + WINDOW);
        uint256 id = gov.startDirectionRound(epoch + 1);
        _vote(id, 0, 0);
        vm.warp(gov.getRound(id).endsAt);
        gov.finalize(id);
        assertEq(gov.currentDecision().id, 1);
    }

    // MEDIUM-3 — the round starter used to pick an older, favourable snapshot.
    function test_mustUseNewestUsableSnapshot() public {
        vm.warp(block.timestamp + 1 days);
        weights[0] = 1; // the whale dumped
        _publish(epoch + 1);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.NotLatestSnapshot.selector, epoch, epoch + 1));
        gov.startDirectionRound(epoch);
        assertEq(gov.latestUsableEpoch(), epoch + 1);
        gov.startDirectionRound(epoch + 1);
    }

    function test_latestUsableSkipsPendingAndRevoked() public {
        vm.warp(block.timestamp + 1 days);
        vm.prank(updater);
        gov.submitWeightRoot(epoch + 1, bytes32(uint256(1)), 1, 0);
        assertEq(gov.latestUsableEpoch(), epoch); // epoch+1 still pending
        vm.prank(guardian);
        gov.revokeWeightRoot(epoch + 1);
        vm.warp(block.timestamp + WINDOW);
        assertEq(gov.latestUsableEpoch(), epoch);
    }

    function test_latestUsableIsZeroWhenStale() public {
        vm.warp(block.timestamp + MAX_AGE + 1);
        assertEq(gov.latestUsableEpoch(), 0);
    }

    // LOW-1 — a round finalized long after its end can no longer mint a decision.
    function test_lateFinalizeFallsBack() public {
        uint256 id = gov.startDirectionRound(epoch);
        _vote(id, 0, 0);
        vm.warp(gov.getRound(id).endsAt + VOTING + 1);
        gov.finalize(id);
        assertEq(gov.currentDecision().id, 0);
    }

    function test_finalizeAtGraceBoundaryStillValid() public {
        uint256 id = gov.startDirectionRound(epoch);
        _vote(id, 0, 0);
        vm.warp(gov.getRound(id).endsAt + VOTING);
        gov.finalize(id);
        assertEq(gov.currentDecision().id, 1);
    }

    // INFO — leaves are domain-separated (chain id + contract address).
    function test_leafDomainSeparated() public {
        WarchestGovernance other = new WarchestGovernance(guardian, updater, _params());
        assertTrue(other.leaf(epoch, voters[0], 1) != gov.leaf(epoch, voters[0], 1));
    }
}
