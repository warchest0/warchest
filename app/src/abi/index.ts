import { parseAbi } from "viem";

/**
 * Minimal ABIs, hand-copied from `contracts/src/*.sol` (only what the dapp reads or calls). Foundry artifacts are
 * never imported at runtime. Keep in sync with the contracts when their public surface changes.
 */

/** `WarchestGovernance`: roots, rounds, tallies, decisions and `vote`. */
export const governanceAbi = parseAbi([
  "function quorumBps() view returns (uint16)",
  "function votingPeriod() view returns (uint64)",
  "function challengeWindow() view returns (uint64)",
  "function paused() view returns (bool)",
  "function roundCount() view returns (uint256)",
  "function latestEpoch() view returns (uint64)",
  "function latestUsableEpoch() view returns (uint64)",
  "function eligibleAssets() view returns (uint32[])",
  "function activeRound(uint8 kind) view returns (uint256)",
  "function getRound(uint256 roundId) view returns ((uint8 kind, uint64 epoch, uint64 startsAt, uint64 endsAt, bool finalized, uint256 totalVoted, uint256 targetDecisionId))",
  "function roundAssets(uint256 roundId) view returns (uint32[])",
  "function optionCount(uint256 roundId) view returns (uint256)",
  "function tally(uint256 roundId, uint256 option) view returns (uint256)",
  "function hasVoted(uint256 roundId, address account) view returns (bool)",
  "function voided(uint256 roundId) view returns (bool)",
  "function weightRoot(uint64 epoch) view returns ((bytes32 root, uint256 totalWeight, uint64 submittedAt, bool revoked, bytes32 treeHash))",
  "function currentDecision() view returns ((uint256 id, uint32 asset, uint8 side, uint256 roundId, uint64 decidedAt))",
  "function isCloseRequested(uint256 decisionId) view returns (bool)",
  "function leaf(uint64 epoch, address account, uint256 weight) view returns (bytes32)",
  "function vote(uint256 roundId, uint256 option, uint256 weight, bytes32[] proof)",
  "event RoundStarted(uint256 indexed roundId, uint8 kind, uint64 epoch, uint64 endsAt, uint256 targetDecisionId)",
  "event VoteCast(uint256 indexed roundId, address indexed voter, uint256 option, uint256 weight)",
  "event RoundFinalized(uint256 indexed roundId, bool quorate, bool valid, uint256 winningOption, uint256 winningWeight, uint256 totalVoted, uint256 totalWeight)",
  "event DecisionMade(uint256 indexed decisionId, uint32 asset, uint8 side, uint256 indexed roundId)",
  "event FallbackToPreviousDecision(uint256 indexed roundId, uint256 indexed standingDecisionId)",
  "event CloseRequested(uint256 indexed decisionId, uint256 indexed roundId)",
  "error RoundNotOpen(uint256 roundId)",
  "error AlreadyVoted(uint256 roundId, address voter)",
  "error InvalidOption(uint256 option)",
  "error ZeroWeight()",
  "error InvalidProof()",
  "error IsPaused()",
]);

/** `WarchestVault`: NAV, position, risk parameters, PnL accounting and events. */
export const vaultAbi = parseAbi([
  "function nav() view returns (uint256)",
  "function usdgLedger() view returns (uint256)",
  "function maxOrderAmount() view returns (uint256)",
  "function capBps() view returns (uint16)",
  "function paused() view returns (bool)",
  "function position() view returns ((uint256 decisionId, uint32 asset, uint8 side, uint256 capital, uint64 openedAt, uint256 depositId, uint64 closeReportedAt))",
  "function mustClose() view returns (bool)",
  "function riskParams() view returns (uint16 stopLoss, uint8 lev, uint16 takeProfit)",
  "function cumulativePnl() view returns (int256)",
  "function highWaterMark() view returns (uint256)",
  "function distributable() view returns (uint256)",
  "function distributor() view returns (address)",
  "function lastExecutedDecisionId() view returns (uint256)",
  "function finalizedEquity(uint256 decisionId) view returns (uint256 equity, bool exists)",
  "function closeVoteAllowed(uint256 decisionId) view returns (bool)",
  "function oracleStable() view returns (bool)",
  "event EthReceived(address indexed from, uint256 amount)",
  "event EthConverted(uint256 ethIn, uint256 usdgOut, uint256 twapFloor)",
  "event OrderExecuted(uint256 indexed decisionId, uint32 indexed asset, uint8 side, uint256 capital, uint256 outputAmount, uint256 depositId, uint16 stopLossBps, uint8 leverage, uint16 takeProfitBps)",
  "event PositionReported(uint256 indexed decisionId, uint256 equity, uint64 reportedAt, uint64 finalAt)",
  "event CloseReported(uint256 indexed decisionId, uint64 reportedAt, uint64 finalAt)",
  "event PositionClosed(uint256 indexed decisionId, uint256 capital, uint256 returned, int256 pnl, int256 cumulativePnl)",
  "event LateReturn(uint256 indexed decisionId, uint256 amount, int256 cumulativePnl)",
  "event Distributed(address indexed to, uint256 amount, uint256 highWaterMark)",
  "event Paused(bool paused)",
]);

/** `WarchestDistributor`: cumulative merkle claims (D7, disabled unless deployed). */
export const distributorAbi = parseAbi([
  "function root() view returns (bytes32)",
  "function claimed(address account) view returns (uint256)",
  "function totalFunded() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function claim(address account, uint256 cumulativeAmount, bytes32[] proof) returns (uint256 amount)",
]);

/** `WarchestToken` (plain ERC20). */
export const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
