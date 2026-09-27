# WarchestGovernance

A contract **separate from the vault**, holding **no funds**. It does three things:
1. Stores the merkle weight roots, one per daily snapshot.
2. Counts votes.
3. Exposes decisions via `IWarchestDecisionSource`.

## Voting weight (D1, D2)
- `weight(wallet) = Σ lot.amount × level(lot)`, with a level from 0 to 10 and LIFO lots, computed off-chain by the indexer.
- Tree leaf: `keccak256(bytes.concat(keccak256(abi.encode(chainid, governance, epoch, account, weight))))`, sorted-pair tree, OpenZeppelin standard. The leaf is domain-separated by chain and by contract.
- Root lifecycle:
  - `submitWeightRoot(epoch, root, totalWeight, treeHash)` is restricted to the `updater`.
  - `epoch` is a UTC day index, strictly increasing and at most equal to tomorrow's index.
  - `0 < totalWeight ≤ MAX_TOTAL_WEIGHT`, so that the quorum computation can never overflow.
  - Revoking the latest epoch rolls `latestEpoch` back to the previous one (`prevEpoch` linked list), which allows it to be resubmitted.
  - The root becomes usable after `challengeWindow`. During this window, the `guardian` can revoke it (`revokeWeightRoot`).

## Rounds
| Type | Opening | Options |
|---|---|---|
| Direction | `startDirectionRound(epoch)`, permissionless | `assetIndex*2 + side` (Long = 0, Short = 1) over the closed asset list, **copied at start** |
| Close | `startCloseRound(epoch)`, permissionless if `vault.closeVoteAllowed(decisionId)` | 0 = keep, 1 = close |

- A round's snapshot must be **the most recent usable one** (`latestUsableEpoch()`): not pending, not revoked, not stale. Nobody can therefore pick an older snapshot that favors them.
- There is at most one active round per type. A Direction round and a Close round can run in parallel.
- `vote(round, option, weight, proof)`: one vote per wallet per round, with the full snapshot weight. A token transfer after the snapshot changes nothing, which makes double voting impossible.

## Finalization (`finalize`, permissionless after `endsAt`)
- A round is **valid** only if it has not been cancelled (see below) **and** it is finalized no later than `votingPeriod` after `endsAt`. An invalid round always falls back to the previous decision.
- Quorum: `totalVoted × 10,000 ≥ quorumBps × totalWeight(snapshot)`.
- **Direction**: a **new** decision (id + 1) is created only if the quorum is reached **and** the winning option is unique (no tie).
  - Otherwise, **the previous decision stays in place with the same id** (D8). There is no automatic reopening: the vault executes each id at most once, so a stopped-out position is only reopened after a new decision that reached quorum.
- **Close**: `isCloseRequested(decisionId)` becomes true if the quorum is reached and "close" strictly wins.

## Roles (D9)
- **`guardian`** (multisig):
  - can: `setPaused`, `cancelRound`, `revokeWeightRoot` (during the challenge window), `proposeUpdater`, `setEligibleAssets` (for future rounds only), `setVault` (only once), two-step role transfer;
  - a **pause cancels all ongoing rounds**, and `cancelRound` does the same for a specific round: a cancelled round can only fall back to the previous decision. The guardian can therefore block a decision, but never choose one;
  - updater rotation is **delayed** by `challengeWindow + votingPeriod + maxRootAge` (72 h with the proposed values). It is public for the entire delay, after which anyone can apply it (`applyUpdaterChange`). The guardian therefore cannot take the updater's place and forge the weights within a single round;
  - can never: modify a vote or a tally, or impose a decision.
- **`updater`** (indexer): can only submit roots.

## Immutable parameters (`Params`)
`challengeWindow`, `votingPeriod`, `maxRootAge`, `quorumBps`.

Proposed values: 6 h, 24 h, 48 h, 10%.

## Tests
- `WarchestGovernanceRoots`, `WarchestGovernanceVoting`, `WarchestGovernanceDecisions` (including the D8 scenarios with `MockDecisionVault`).
- Invariants in `invariant/GovernanceInvariant`:
  - Σ tallies = totalVoted ≤ total weight;
  - monotonic decision ids;
  - a single active round;
  - no funds held.

## Security review (Fable, 2026-09-27)
Fixed findings, each covered by a regression test in `WarchestGovernanceHardening`:
- **High**: the guardian could force a decision by choosing the timing of the pause.
- **High**: the guardian could take the updater's place and forge the weights.
- **High**: a far-future epoch permanently blocked submissions.
- **Medium**: a zero `totalWeight`, or one large enough to overflow the quorum computation, was accepted.
- **Medium**: an older, more favorable snapshot could be chosen.
- **Low**: a round finalized very late still produced a decision.
- **Info**: the leaf was not domain-separated by chain and by contract.

Design guidelines passed on to the vault:
- a requested close is executed **unconditionally**;
- a decision superseded by a more recent one requires **closing then reopening** the position;
- a decision's age is judged by `getRound(roundId).endsAt`.
