import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { ERC20_ABI, GOVERNANCE_ABI, QUOTER_V2_ABI, SPOKE_POOL_ABI, VAULT_ABI, WETH_ROBINHOOD } from "./abi.js";
import { sideFromEnum, type GovernanceSnapshot, type VaultSnapshot } from "../types.js";

/** Read-only view of the on-chain system. Mockable in tests. */
export interface ChainReader {
  vault(): Promise<VaultSnapshot>;
  governance(): Promise<GovernanceSnapshot>;
  /** Spot ETH→USDG quote from the QuoterV2 (USDG, 6 decimals). */
  quoteEthToUsdg(amountIn: bigint): Promise<bigint>;
  /** `vault.twapFloor(amountIn)`: the minimum output a conversion must accept. */
  twapFloor(amountIn: bigint): Promise<bigint>;
  /** The `OrderExecuted` event of a decision, if any (used to adopt a position after a lost database). */
  orderExecuted(decisionId: bigint): Promise<{ outputAmount: bigint; depositId: bigint; blockNumber: bigint } | undefined>;
}

export class RpcChainReader implements ChainReader {
  readonly client: PublicClient;

  constructor(
    rpcUrl: string,
    private readonly vaultAddr: Address,
    private readonly governanceAddr: Address,
    private readonly quoter: Address,
    private readonly weth: Address = WETH_ROBINHOOD,
  ) {
    this.client = createPublicClient({ transport: http(rpcUrl, { batch: { batchSize: 50 }, retryCount: 3 }) });
  }

  async vault(): Promise<VaultSnapshot> {
    const v = { address: this.vaultAddr, abi: VAULT_ABI } as const;
    const block = await this.client.getBlock();
    const [
      paused, keeper, usdg, spokePool, bridgeRecipient, bridgeOutputToken, destinationChainId, usdgLedger, nav, maxOrderAmount,
      lastConvertAt, convertCooldown, maxConvertPerCall, maxBridgeFeeBps, maxDecisionAge, reportChallengeWindow,
      lastExecutedDecisionId, position, mustClose, risk, ethBalance,
    ] = await Promise.all([
      this.client.readContract({ ...v, functionName: "paused" }),
      this.client.readContract({ ...v, functionName: "keeper" }),
      this.client.readContract({ ...v, functionName: "usdg" }),
      this.client.readContract({ ...v, functionName: "spokePool" }),
      this.client.readContract({ ...v, functionName: "bridgeRecipient" }),
      this.client.readContract({ ...v, functionName: "bridgeOutputToken" }),
      this.client.readContract({ ...v, functionName: "destinationChainId" }),
      this.client.readContract({ ...v, functionName: "usdgLedger" }),
      this.client.readContract({ ...v, functionName: "nav" }),
      this.client.readContract({ ...v, functionName: "maxOrderAmount" }),
      this.client.readContract({ ...v, functionName: "lastConvertAt" }),
      this.client.readContract({ ...v, functionName: "convertCooldown" }),
      this.client.readContract({ ...v, functionName: "maxConvertPerCall" }),
      this.client.readContract({ ...v, functionName: "maxBridgeFeeBps" }),
      this.client.readContract({ ...v, functionName: "maxDecisionAge" }),
      this.client.readContract({ ...v, functionName: "reportChallengeWindow" }),
      this.client.readContract({ ...v, functionName: "lastExecutedDecisionId" }),
      this.client.readContract({ ...v, functionName: "position" }),
      this.client.readContract({ ...v, functionName: "mustClose" }),
      this.client.readContract({ ...v, functionName: "riskParams" }),
      this.client.getBalance({ address: this.vaultAddr }),
    ]);
    const [usdgBalance, numberOfDeposits] = await Promise.all([
      this.client.readContract({ address: usdg, abi: ERC20_ABI, functionName: "balanceOf", args: [this.vaultAddr] }),
      this.client.readContract({ address: spokePool, abi: SPOKE_POOL_ABI, functionName: "numberOfDeposits" }),
    ]);
    return {
      paused,
      keeper,
      ethBalance,
      usdgBalance,
      usdgLedger,
      nav,
      maxOrderAmount,
      lastConvertAt: Number(lastConvertAt),
      convertCooldown: Number(convertCooldown),
      maxConvertPerCall,
      maxBridgeFeeBps,
      maxDecisionAge: Number(maxDecisionAge),
      reportChallengeWindow: Number(reportChallengeWindow),
      lastExecutedDecisionId,
      position: {
        decisionId: position.decisionId,
        asset: position.asset,
        side: sideFromEnum(position.side),
        capital: position.capital,
        openedAt: Number(position.openedAt),
        depositId: position.depositId,
        closeReportedAt: Number(position.closeReportedAt),
      },
      mustClose,
      risk: { stopLossBps: risk[0], leverage: risk[1], takeProfitBps: risk[2] },
      bridgeRecipient,
      bridgeOutputToken,
      destinationChainId,
      usdg,
      spokePool,
      spokePoolNumberOfDeposits: BigInt(numberOfDeposits),
      blockTimestamp: Number(block.timestamp),
      blockNumber: block.number,
    };
  }

  async governance(): Promise<GovernanceSnapshot> {
    const g = { address: this.governanceAddr, abi: GOVERNANCE_ABI } as const;
    const [d, paused] = await Promise.all([
      this.client.readContract({ ...g, functionName: "currentDecision" }),
      this.client.readContract({ ...g, functionName: "paused" }),
    ]);
    const decision = { id: d.id, asset: d.asset, side: sideFromEnum(d.side), roundId: d.roundId, decidedAt: Number(d.decidedAt) };
    if (decision.id === 0n) return { decision, closeRequested: false, paused };
    const [round, closeRequested] = await Promise.all([
      this.client.readContract({ ...g, functionName: "getRound", args: [d.roundId] }),
      this.client.readContract({ ...g, functionName: "isCloseRequested", args: [d.id] }),
    ]);
    return { decision, round: { endsAt: Number(round.endsAt), finalized: round.finalized }, closeRequested, paused };
  }

  twapFloor(amountIn: bigint): Promise<bigint> {
    return this.client.readContract({ address: this.vaultAddr, abi: VAULT_ABI, functionName: "twapFloor", args: [amountIn] });
  }

  async orderExecuted(decisionId: bigint) {
    const logs = await this.client.getContractEvents({
      address: this.vaultAddr,
      abi: VAULT_ABI,
      eventName: "OrderExecuted",
      args: { decisionId },
      fromBlock: "earliest",
      strict: true,
    });
    const l = logs.at(-1);
    if (!l) return undefined;
    return { outputAmount: l.args.outputAmount, depositId: l.args.depositId, blockNumber: l.blockNumber };
  }

  async quoteEthToUsdg(amountIn: bigint): Promise<bigint> {
    const usdg = await this.client.readContract({ address: this.vaultAddr, abi: VAULT_ABI, functionName: "usdg" });
    const { result } = await this.client.simulateContract({
      address: this.quoter,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: this.weth, tokenOut: usdg, amountIn, fee: 100, sqrtPriceLimitX96: 0n }],
    });
    return result[0];
  }
}
