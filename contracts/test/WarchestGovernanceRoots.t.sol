// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {WarchestGovernance} from "../src/WarchestGovernance.sol";
import {MerkleHelper} from "./utils/MerkleHelper.sol";

contract WarchestGovernanceRootsTest is Test {
    uint64 constant WINDOW = 6 hours;
    address guardian = makeAddr("guardian");
    address updater = makeAddr("updater");
    WarchestGovernance gov;

    function _params() internal pure returns (WarchestGovernance.Params memory) {
        return
            WarchestGovernance.Params({
                challengeWindow: WINDOW, votingPeriod: 1 days, maxRootAge: 2 days, quorumBps: 1000
            });
    }

    function setUp() public {
        gov = new WarchestGovernance(guardian, updater, _params());
    }

    function _submit(uint64 epoch, bytes32 root) internal {
        vm.prank(updater);
        gov.submitWeightRoot(epoch, root, 1000, keccak256("tree"));
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(WarchestGovernance.ZeroAddress.selector);
        new WarchestGovernance(address(0), updater, _params());
        vm.expectRevert(WarchestGovernance.ZeroAddress.selector);
        new WarchestGovernance(guardian, address(0), _params());
    }

    function test_submit_onlyUpdater() public {
        vm.expectRevert(WarchestGovernance.NotUpdater.selector);
        gov.submitWeightRoot(1, bytes32(uint256(1)), 1, 0);
    }

    function test_submit_storesAndEmits() public {
        vm.expectEmit(address(gov));
        emit WarchestGovernance.WeightRootSubmitted(1, bytes32(uint256(7)), 1000, keccak256("tree"));
        _submit(1, bytes32(uint256(7)));
        WarchestGovernance.WeightRoot memory r = gov.weightRoot(1);
        assertEq(r.root, bytes32(uint256(7)));
        assertEq(r.totalWeight, 1000);
        assertEq(r.submittedAt, block.timestamp);
        assertEq(gov.latestEpoch(), 1);
    }

    function test_submit_rejectsEmptyRoot() public {
        vm.prank(updater);
        vm.expectRevert(WarchestGovernance.EmptyRoot.selector);
        gov.submitWeightRoot(1, bytes32(0), 1, 0);
    }

    function test_submit_epochMustIncrease() public {
        _submit(5, bytes32(uint256(1)));
        vm.startPrank(updater);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.EpochNotIncreasing.selector, 5, 5));
        gov.submitWeightRoot(5, bytes32(uint256(2)), 1, 0);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.EpochNotIncreasing.selector, 4, 5));
        gov.submitWeightRoot(4, bytes32(uint256(2)), 1, 0);
        gov.submitWeightRoot(6, bytes32(uint256(2)), 1, 0);
        vm.stopPrank();
    }

    function test_usableOnlyAfterChallengeWindow() public {
        _submit(1, bytes32(uint256(1)));
        assertFalse(gov.isRootUsable(1));
        vm.warp(block.timestamp + WINDOW - 1);
        assertFalse(gov.isRootUsable(1));
        vm.warp(block.timestamp + 1);
        assertTrue(gov.isRootUsable(1));
        assertFalse(gov.isRootUsable(2));
    }

    function test_revoke_onlyGuardian_duringWindow() public {
        _submit(1, bytes32(uint256(1)));
        vm.expectRevert(WarchestGovernance.NotGuardian.selector);
        gov.revokeWeightRoot(1);

        vm.prank(guardian);
        gov.revokeWeightRoot(1);
        vm.warp(block.timestamp + WINDOW);
        assertFalse(gov.isRootUsable(1));

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.RootNotRevocable.selector, 1));
        gov.revokeWeightRoot(1); // already revoked
    }

    function test_revoke_impossibleAfterWindow() public {
        _submit(1, bytes32(uint256(1)));
        vm.warp(block.timestamp + WINDOW);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.RootNotRevocable.selector, 1));
        gov.revokeWeightRoot(1);
        assertTrue(gov.isRootUsable(1));
    }

    function test_revoke_unknownEpoch() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(WarchestGovernance.RootNotRevocable.selector, 9));
        gov.revokeWeightRoot(9);
    }

    function test_revokedLatestEpochCanBeResubmitted() public {
        _submit(3, bytes32(uint256(1)));
        vm.prank(guardian);
        gov.revokeWeightRoot(3);
        _submit(3, bytes32(uint256(2)));
        assertEq(gov.weightRoot(3).root, bytes32(uint256(2)));
        assertFalse(gov.weightRoot(3).revoked);
        vm.warp(block.timestamp + WINDOW);
        assertTrue(gov.isRootUsable(3));
    }

    function test_setUpdater() public {
        address next = makeAddr("next");
        vm.expectRevert(WarchestGovernance.NotGuardian.selector);
        gov.setUpdater(next);
        vm.prank(guardian);
        gov.setUpdater(next);
        assertEq(gov.updater(), next);
        vm.prank(updater);
        vm.expectRevert(WarchestGovernance.NotUpdater.selector);
        gov.submitWeightRoot(1, bytes32(uint256(1)), 1, 0);
    }

    function test_guardianTwoStepTransfer() public {
        address next = makeAddr("nextGuardian");
        vm.prank(guardian);
        gov.transferGuardian(next);
        assertEq(gov.guardian(), guardian);
        vm.expectRevert(WarchestGovernance.NotPendingGuardian.selector);
        gov.acceptGuardian();
        vm.prank(next);
        gov.acceptGuardian();
        assertEq(gov.guardian(), next);
        assertEq(gov.pendingGuardian(), address(0));
    }

    /// The on-chain leaf format matches the tree the indexer builds (OZ double hash, sorted pairs).
    function testFuzz_leafProofRoundTrip(uint64 epoch, uint8 n, uint256 seed) public view {
        n = uint8(bound(n, 1, 40));
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            leaves[i] = gov.leaf(epoch, address(uint160(uint256(keccak256(abi.encode(seed, i))))), i + 1);
        }
        bytes32 root = MerkleHelper.root(leaves);
        uint256 idx = seed % n;
        assertTrue(MerkleProof.verify(MerkleHelper.proof(leaves, idx), root, leaves[idx]));
    }
}
