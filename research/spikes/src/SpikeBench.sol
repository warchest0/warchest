// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// SPIKE ONLY — contracts used to measure on-chain cost of design alternatives.

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// D2 design: one merkle root per epoch, voters prove their weight.
contract MerkleVoting {
    mapping(uint256 => bytes32) public roots;
    mapping(uint256 => mapping(address => bool)) public voted;
    mapping(uint256 => mapping(uint8 => uint256)) public tally;

    function submitRoot(uint256 epoch, bytes32 root) external {
        roots[epoch] = root;
    }

    function vote(uint256 epoch, uint8 choice, uint256 weight, bytes32[] calldata proof) external {
        require(!voted[epoch][msg.sender], "voted");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(epoch, msg.sender, weight))));
        require(MerkleProof.verifyCalldata(proof, roots[epoch], leaf), "proof");
        voted[epoch][msg.sender] = true;
        tally[epoch][choice] += weight;
    }
}

/// Rejected alternative: indexer writes one level per wallet on-chain.
contract PerWalletLevels {
    mapping(address => uint8) public level;

    function setLevels(address[] calldata wallets, uint8[] calldata levels) external {
        for (uint256 i; i < wallets.length; ++i) {
            level[wallets[i]] = levels[i];
        }
    }
}

/// Rejected alternative: on-chain lot tracking per wallet (LIFO and FIFO consumption).
contract OnchainLots {
    struct Lot {
        uint128 amount;
        uint64 day;
    }

    mapping(address => Lot[]) public lots;
    mapping(address => uint256) public fifoHead;

    function buy(address w, uint128 amount) external {
        lots[w].push(Lot(amount, uint64(block.timestamp / 1 days)));
    }

    /// LIFO: most recent lots sold first (whitepaper semantics).
    function sellLifo(address w, uint128 amount) external {
        Lot[] storage l = lots[w];
        while (amount > 0) {
            Lot storage last = l[l.length - 1];
            if (last.amount <= amount) {
                amount -= last.amount;
                l.pop();
            } else {
                last.amount -= amount;
                amount = 0;
            }
        }
    }

    /// FIFO: oldest lots sold first (technical-plan wording).
    function sellFifo(address w, uint128 amount) external {
        Lot[] storage l = lots[w];
        uint256 h = fifoHead[w];
        while (amount > 0) {
            Lot storage first = l[h];
            if (first.amount <= amount) {
                amount -= first.amount;
                delete l[h];
                ++h;
            } else {
                first.amount -= amount;
                amount = 0;
            }
        }
        fifoHead[w] = h;
    }

    /// Weight = Σ amount × min(daysHeld, 10) — what a vote would need to compute on-chain.
    function weight(address w) external view returns (uint256 total) {
        Lot[] storage l = lots[w];
        uint64 today = uint64(block.timestamp / 1 days);
        for (uint256 i = fifoHead[w]; i < l.length; ++i) {
            uint256 d = today - l[i].day;
            total += uint256(l[i].amount) * (d > 10 ? 10 : d);
        }
    }
}
