// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";

/// @notice Minimal sorted-pair merkle tree builder (OpenZeppelin-compatible) for tests.
/// @dev Odd nodes are promoted unchanged to the next level, matching `MerkleProof.verify` semantics.
library MerkleHelper {
    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            level = _next(level);
        }
        return level[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory p) {
        bytes32[] memory tmp = new bytes32[](64);
        uint256 n;
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            uint256 sibling = index ^ 1;
            if (sibling < level.length) tmp[n++] = level[sibling];
            level = _next(level);
            index /= 2;
        }
        p = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            p[i] = tmp[i];
        }
    }

    function _next(bytes32[] memory level) private pure returns (bytes32[] memory nextLevel) {
        nextLevel = new bytes32[]((level.length + 1) / 2);
        for (uint256 i; i < nextLevel.length; ++i) {
            uint256 l = 2 * i;
            nextLevel[i] = l + 1 < level.length ? Hashes.commutativeKeccak256(level[l], level[l + 1]) : level[l];
        }
    }
}
