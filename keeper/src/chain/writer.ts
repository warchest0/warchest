/**
 * The keeper's transactions on Robinhood Chain. Only the five keeper functions plus the permissionless
 * `finalizeClose`. Every call is simulated first (`eth_call` with the keeper as sender) so a transaction that the
 * vault would revert is never broadcast, then sent and awaited; a reverted receipt throws.
 */
import { createPublicClient, createWalletClient, decodeEventLog, http, type Address, type Chain, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { Logger } from "../log.js";
import { VAULT_ABI } from "./abi.js";

export interface TxResult {
  txHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
}

export interface ChainWriter {
  readonly address: Address;
  convertEthToUsdg(amountIn: bigint, minOut: bigint): Promise<TxResult & { amountOut?: bigint }>;
  executeDecision(amount: bigint, outputAmount: bigint, quoteTimestamp: number, fillDeadline: number): Promise<TxResult & { depositId?: bigint }>;
  reportPosition(decisionId: bigint, equityUsd: bigint): Promise<TxResult>;
  reportClosed(decisionId: bigint): Promise<TxResult>;
  finalizeClose(decisionId: bigint): Promise<TxResult>;
  reconcile(): Promise<TxResult>;
}

type VaultFn = "convertEthToUsdg" | "executeDecision" | "reportPosition" | "reportClosed" | "finalizeClose" | "reconcile";

export class RpcChainWriter implements ChainWriter {
  readonly address: Address;
  private readonly account: PrivateKeyAccount;
  private readonly pub: PublicClient;
  private readonly wallet: WalletClient;
  private readonly log: Logger;

  constructor(rpcUrl: string, chainId: bigint, private readonly vault: Address, keeperKey: Hex, log?: Logger) {
    this.account = privateKeyToAccount(keeperKey);
    this.address = this.account.address;
    const chain: Chain = { id: Number(chainId), name: `chain-${chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
    this.pub = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 3 }) });
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(rpcUrl) });
    this.log = log ?? new Logger("chain:writer");
  }

  private async send(functionName: VaultFn, args: readonly unknown[]): Promise<TxResult & { logs: readonly { data: Hex; topics: readonly Hex[] }[]; result: unknown }> {
    const chainId = await this.pub.getChainId();
    if (chainId !== this.wallet.chain!.id) throw new Error(`RPC chain id ${chainId} != configured ${this.wallet.chain!.id}`);
    // fail-closed: never broadcast something the vault would revert
    const { request, result } = await this.pub.simulateContract({ address: this.vault, abi: VAULT_ABI, functionName, args, account: this.account } as never);
    const txHash = await this.wallet.writeContract(request as never);
    this.log.info(`${functionName} sent`, { txHash, args: args.map(String) });
    const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted on-chain: ${txHash}`);
    return { txHash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, logs: receipt.logs, result };
  }

  async convertEthToUsdg(amountIn: bigint, minOut: bigint) {
    const r = await this.send("convertEthToUsdg", [amountIn, minOut]);
    return { txHash: r.txHash, blockNumber: r.blockNumber, gasUsed: r.gasUsed, amountOut: r.result as bigint | undefined };
  }

  async executeDecision(amount: bigint, outputAmount: bigint, quoteTimestamp: number, fillDeadline: number) {
    const r = await this.send("executeDecision", [amount, outputAmount, quoteTimestamp, fillDeadline]);
    let depositId: bigint | undefined;
    for (const l of r.logs) {
      try {
        const ev = decodeEventLog({ abi: VAULT_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        if (ev.eventName === "OrderExecuted") depositId = (ev.args as { depositId: bigint }).depositId;
      } catch {
        /* not a vault event */
      }
    }
    return { txHash: r.txHash, blockNumber: r.blockNumber, gasUsed: r.gasUsed, depositId };
  }

  async reportPosition(decisionId: bigint, equityUsd: bigint) {
    return strip(await this.send("reportPosition", [decisionId, equityUsd]));
  }
  async reportClosed(decisionId: bigint) {
    return strip(await this.send("reportClosed", [decisionId]));
  }
  async finalizeClose(decisionId: bigint) {
    return strip(await this.send("finalizeClose", [decisionId]));
  }
  async reconcile() {
    return strip(await this.send("reconcile", []));
  }
}

const strip = (r: TxResult): TxResult => ({ txHash: r.txHash, blockNumber: r.blockNumber, gasUsed: r.gasUsed });
