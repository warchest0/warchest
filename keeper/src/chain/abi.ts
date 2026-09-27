import { parseAbi } from "viem";

/** Subset of `WarchestVault` used by the keeper (reads + the five keeper-callable functions). */
export const VAULT_ABI = parseAbi([
  // roles & state
  "function paused() view returns (bool)",
  "function keeper() view returns (address)",
  "function guardian() view returns (address)",
  "function usdg() view returns (address)",
  "function spokePool() view returns (address)",
  "function bridgeRecipient() view returns (address)",
  "function bridgeOutputToken() view returns (address)",
  "function destinationChainId() view returns (uint256)",
  "function usdgLedger() view returns (uint256)",
  "function nav() view returns (uint256)",
  "function maxOrderAmount() view returns (uint256)",
  "function lastConvertAt() view returns (uint64)",
  "function convertCooldown() view returns (uint64)",
  "function maxConvertPerCall() view returns (uint256)",
  "function maxSlippageBps() view returns (uint16)",
  "function maxBridgeFeeBps() view returns (uint16)",
  "function maxDecisionAge() view returns (uint64)",
  "function reportChallengeWindow() view returns (uint64)",
  "function lastExecutedDecisionId() view returns (uint256)",
  "function lastClosedDecisionId() view returns (uint256)",
  "function cumulativePnl() view returns (int256)",
  "function position() view returns ((uint256 decisionId, uint32 asset, uint8 side, uint256 capital, uint64 openedAt, uint256 depositId, uint64 closeReportedAt))",
  "function mustClose() view returns (bool)",
  "function riskParams() view returns (uint16 stopLoss, uint8 lev, uint16 takeProfit)",
  "function twapFloor(uint256 ethAmount) view returns (uint256)",
  "function quoteEthInUsdg(uint256 ethAmount) view returns (uint256)",
  "function lastReport(uint256 decisionId) view returns ((uint256 equity, uint64 reportedAt, bool revoked))",
  "function finalizedEquity(uint256 decisionId) view returns (uint256 equity, bool exists)",
  "function closeVoteAllowed(uint256 decisionId) view returns (bool)",
  // keeper-callable
  "function convertEthToUsdg(uint256 amountIn, uint256 minOut) returns (uint256 amountOut)",
  "function executeDecision(uint256 amount, uint256 outputAmount, uint32 quoteTimestamp, uint32 fillDeadline)",
  "function reportPosition(uint256 decisionId, uint256 equityUsd)",
  "function reportClosed(uint256 decisionId)",
  "function reconcile()",
  // permissionless
  "function finalizeClose(uint256 decisionId)",
  // events
  "event OrderExecuted(uint256 indexed decisionId, uint32 indexed asset, uint8 side, uint256 capital, uint256 outputAmount, uint256 depositId, uint16 stopLossBps, uint8 leverage, uint16 takeProfitBps)",
  "event PositionClosed(uint256 indexed decisionId, uint256 capital, uint256 returned, int256 pnl, int256 cumulativePnl)",
]);

export const GOVERNANCE_ABI = parseAbi([
  "function currentDecision() view returns ((uint256 id, uint32 asset, uint8 side, uint256 roundId, uint64 decidedAt))",
  "function isCloseRequested(uint256 decisionId) view returns (bool)",
  "function getRound(uint256 roundId) view returns ((uint8 kind, uint64 epoch, uint64 startsAt, uint64 endsAt, bool finalized, uint256 totalVoted, uint256 targetDecisionId))",
  "function paused() view returns (bool)",
  "function eligibleAssets() view returns (uint32[])",
]);

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const SPOKE_POOL_ABI = parseAbi([
  "function numberOfDeposits() view returns (uint32)",
  "function getCurrentTime() view returns (uint256)",
  "function depositQuoteTimeBuffer() view returns (uint32)",
  "function fillDeadlineBuffer() view returns (uint32)",
]);

/** Uniswap v3 QuoterV2 (`quoteExactInputSingle` is non-view but callable with eth_call). */
export const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export const WETH_ROBINHOOD = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
