// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {WarchestGovernance} from "../../src/WarchestGovernance.sol";
import {MerkleHelper} from "./MerkleHelper.sol";

/// @notice Governance deployed with a published snapshot: `voters[i]` holds weight `weights[i]` in epoch `EPOCH`.
abstract contract GovernanceFixture is Test {
    uint64 constant WINDOW = 6 hours;
    uint64 constant VOTING = 1 days;
    uint64 constant MAX_AGE = 2 days;
    uint16 constant QUORUM_BPS = 1000; // 10%
    uint64 constant EPOCH = 100;

    uint32 constant BTC = 0;
    uint32 constant ETH = 1;
    uint32 constant SOL = 5;

    address guardian = makeAddr("guardian");
    address updater = makeAddr("updater");
    WarchestGovernance gov;

    address[] voters;
    uint256[] weights;
    uint256 totalWeight;

    function _params() internal pure returns (WarchestGovernance.Params memory) {
        return WarchestGovernance.Params({
            challengeWindow: WINDOW, votingPeriod: VOTING, maxRootAge: MAX_AGE, quorumBps: QUORUM_BPS
        });
    }

    function _deployGovernance() internal {
        gov = new WarchestGovernance(guardian, updater, _params());
        uint32[] memory assets = new uint32[](3);
        (assets[0], assets[1], assets[2]) = (BTC, ETH, SOL);
        vm.prank(guardian);
        gov.setEligibleAssets(assets);
    }

    /// Default snapshot: 5 voters, total weight 1000 (quorum = 100).
    function _defaultVoters() internal {
        uint256[5] memory w = [uint256(400), 300, 150, 100, 50];
        for (uint256 i; i < w.length; ++i) {
            voters.push(makeAddr(string.concat("voter", vm.toString(i))));
            weights.push(w[i]);
        }
    }

    function _leaves(uint64 epoch) internal view returns (bytes32[] memory leaves) {
        leaves = new bytes32[](voters.length);
        for (uint256 i; i < voters.length; ++i) {
            leaves[i] = gov.leaf(epoch, voters[i], weights[i]);
        }
    }

    /// Submits the snapshot of `voters/weights` for `epoch` and waits out the challenge window.
    function _publish(uint64 epoch) internal {
        totalWeight = 0;
        for (uint256 i; i < weights.length; ++i) {
            totalWeight += weights[i];
        }
        bytes32 root = MerkleHelper.root(_leaves(epoch)); // computed before the prank: `_leaves` calls `gov.leaf`
        vm.prank(updater);
        gov.submitWeightRoot(epoch, root, totalWeight, keccak256("tree"));
        vm.warp(block.timestamp + WINDOW);
    }

    function _proof(uint64 epoch, uint256 i) internal view returns (bytes32[] memory) {
        return MerkleHelper.proof(_leaves(epoch), i);
    }

    function _vote(uint256 roundId, uint256 i, uint256 option) internal {
        uint64 epoch = gov.getRound(roundId).epoch;
        bytes32[] memory p = _proof(epoch, i);
        vm.prank(voters[i]);
        gov.vote(roundId, option, weights[i], p);
    }

    function _opt(uint256 assetIndex, WarchestGovernance.Direction d) internal pure returns (uint256) {
        return assetIndex * 2 + uint256(d);
    }
}
