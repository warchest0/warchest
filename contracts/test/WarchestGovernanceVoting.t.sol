// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IWarchestDecisionSource} from "../src/interfaces/IWarchestDecisionSource.sol";
import {WarchestGovernance} from "../src/WarchestGovernance.sol";
import {GovernanceFixture} from "./utils/GovernanceFixture.sol";

contract WarchestGovernanceVotingTest is GovernanceFixture {
    function setUp() public {
        vm.warp(1_700_000_000);
        _deployGovernance();
        _defaultVoters();
        _publish(EPOCH);
    }

    // ------------------------------------------------------------------ params & admin

    function test_constructor_rejectsBadParams() public {
        WarchestGovernance.Params memory p = _params();
        p.votingPeriod = 0;
        vm.expectRevert(WarchestGovernance.InvalidParams.selector);
        new WarchestGovernance(guardian, updater, p);
        p = _params();
        p.quorumBps = 0;
        vm.expectRevert(WarchestGovernance.InvalidParams.selector);
        new WarchestGovernance(guardian, updater, p);
        p.quorumBps = 10_001;
        vm.expectRevert(WarchestGovernance.InvalidParams.selector);
        new WarchestGovernance(guardian, updater, p);
    }

    function test_setEligibleAssets_validation() public {
        vm.startPrank(guardian);
        vm.expectRevert(WarchestGovernance.InvalidAssets.selector);
        gov.setEligibleAssets(new uint32[](0));
        uint32[] memory dup = new uint32[](2);
        (dup[0], dup[1]) = (7, 7);
        vm.expectRevert(WarchestGovernance.InvalidAssets.selector);
        gov.setEligibleAssets(dup);
        vm.expectRevert(WarchestGovernance.InvalidAssets.selector);
        gov.setEligibleAssets(new uint32[](17));
        vm.stopPrank();

        vm.expectRevert(WarchestGovernance.NotGuardian.selector);
        gov.setEligibleAssets(dup);
    }

    // ------------------------------------------------------------------ starting rounds

    function test_start_createsRoundWithAssetCopy() public {
        uint256 id = gov.startDirectionRound(EPOCH);
        assertEq(id, 1);
        WarchestGovernance.Round memory r = gov.getRound(id);
        assertEq(uint8(r.kind), uint8(WarchestGovernance.RoundKind.Direction));
        assertEq(r.epoch, EPOCH);
        assertEq(r.endsAt, block.timestamp + VOTING);
        assertEq(gov.activeRound(WarchestGovernance.RoundKind.Direction), id);
        assertEq(gov.optionCount(id), 6);

        // changing the eligible list does not affect the running round
        uint32[] memory next = new uint32[](1);
        next[0] = 42;
        vm.prank(guardian);
        gov.setEligibleAssets(next);
        assertEq(gov.roundAssets(id).length, 3);
        (uint32 asset, IWarchestDecisionSource.Side d) = gov.decodeOption(id, 5);
        assertEq(asset, SOL);
        assertEq(uint8(d), uint8(IWarchestDecisionSource.Side.Short));
    }

    function test_start_onlyOneActiveDirectionRound() public {
        gov.startDirectionRound(EPOCH);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.RoundAlreadyActive.selector, 1));
        gov.startDirectionRound(EPOCH);
    }

    function test_start_rejectsUnusableRoot() public {
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.RootNotUsable.selector, 999));
        gov.startDirectionRound(999);

        vm.prank(updater);
        gov.submitWeightRoot(EPOCH + 1, bytes32(uint256(1)), 1, 0);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.RootNotUsable.selector, EPOCH + 1));
        gov.startDirectionRound(EPOCH + 1); // still in challenge window
    }

    function test_start_rejectsStaleRoot() public {
        vm.warp(block.timestamp + MAX_AGE + 1);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.RootTooOld.selector, EPOCH));
        gov.startDirectionRound(EPOCH);
    }

    function test_start_rejectsNoEligibleAssets() public {
        WarchestGovernance fresh = new WarchestGovernance(guardian, updater, _params());
        vm.expectRevert(WarchestGovernance.NoEligibleAssets.selector);
        fresh.startDirectionRound(EPOCH);
    }

    function test_start_blockedWhenPaused() public {
        vm.prank(guardian);
        gov.setPaused(true);
        vm.expectRevert(WarchestGovernance.IsPaused.selector);
        gov.startDirectionRound(EPOCH);
    }

    // ------------------------------------------------------------------ voting

    function test_vote_tallies() public {
        uint256 id = gov.startDirectionRound(EPOCH);
        _vote(id, 0, _opt(0, IWarchestDecisionSource.Side.Long));
        _vote(id, 1, _opt(1, IWarchestDecisionSource.Side.Short));
        _vote(id, 2, _opt(0, IWarchestDecisionSource.Side.Long));
        assertEq(gov.tally(id, 0), 550);
        assertEq(gov.tally(id, 3), 300);
        assertEq(gov.getRound(id).totalVoted, 850);
        assertTrue(gov.hasVoted(id, voters[0]));
    }

    function test_vote_cannotVoteTwice() public {
        uint256 id = gov.startDirectionRound(EPOCH);
        _vote(id, 0, 0);
        bytes32[] memory p = _proof(EPOCH, 0);
        vm.prank(voters[0]);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.AlreadyVoted.selector, id, voters[0]));
        gov.vote(id, 1, weights[0], p);
    }

    /// Vote-then-transfer: the weight is frozen in the snapshot, so a recipient of the tokens gains nothing and the
    /// original voter cannot reuse someone else's leaf.
    function test_vote_cannotUseSomeoneElsesLeaf() public {
        uint256 id = gov.startDirectionRound(EPOCH);
        address attacker = makeAddr("attacker");
        bytes32[] memory p = _proof(EPOCH, 0);
        vm.prank(attacker);
        vm.expectRevert(WarchestGovernance.InvalidProof.selector);
        gov.vote(id, 0, weights[0], p);
    }

    function test_vote_cannotInflateWeight() public {
        uint256 id = gov.startDirectionRound(EPOCH);
        bytes32[] memory p = _proof(EPOCH, 3);
        vm.prank(voters[3]);
        vm.expectRevert(WarchestGovernance.InvalidProof.selector);
        gov.vote(id, 0, weights[3] * 10, p);
    }

    function test_vote_rejectsZeroWeightAndBadOption() public {
        uint256 id = gov.startDirectionRound(EPOCH);
        bytes32[] memory p = _proof(EPOCH, 0);
        vm.startPrank(voters[0]);
        vm.expectRevert(WarchestGovernance.ZeroWeight.selector);
        gov.vote(id, 0, 0, p);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.InvalidOption.selector, 6));
        gov.vote(id, 6, weights[0], p);
        vm.stopPrank();
    }

    function test_vote_closedAfterEnd() public {
        uint256 id = gov.startDirectionRound(EPOCH);
        vm.warp(block.timestamp + VOTING);
        bytes32[] memory p = _proof(EPOCH, 0);
        vm.prank(voters[0]);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.RoundNotOpen.selector, id));
        gov.vote(id, 0, weights[0], p);
    }

    function test_vote_unknownRound() public {
        bytes32[] memory p = _proof(EPOCH, 0);
        vm.prank(voters[0]);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.RoundNotOpen.selector, 7));
        gov.vote(7, 0, weights[0], p);
    }

    function test_vote_blockedWhenPaused() public {
        uint256 id = gov.startDirectionRound(EPOCH);
        vm.prank(guardian);
        gov.setPaused(true);
        bytes32[] memory p = _proof(EPOCH, 0);
        vm.prank(voters[0]);
        vm.expectRevert(WarchestGovernance.IsPaused.selector);
        gov.vote(id, 0, weights[0], p);
    }

    /// A proof from another epoch's tree is useless, even for the same account and weight.
    function test_vote_proofBoundToRoundEpoch() public {
        vm.warp(block.timestamp + 1 days);
        _publish(EPOCH + 1);
        uint256 id = gov.startDirectionRound(EPOCH + 1);
        bytes32[] memory oldProof = _proof(EPOCH, 0);
        vm.prank(voters[0]);
        vm.expectRevert(WarchestGovernance.InvalidProof.selector);
        gov.vote(id, 0, weights[0], oldProof); // valid proof for EPOCH, but the leaf encodes EPOCH + 1
    }

    function testFuzz_vote_anyVoterAnyOption(uint256 i, uint256 option) public {
        i = bound(i, 0, voters.length - 1);
        option = bound(option, 0, 5);
        uint256 id = gov.startDirectionRound(EPOCH);
        _vote(id, i, option);
        assertEq(gov.tally(id, option), weights[i]);
        assertEq(gov.getRound(id).totalVoted, weights[i]);
    }
}
