import { parseAbi, type Address, type Hex, type PublicClient, type WalletClient, type Chain, type Account } from "viem";
import type { WeightTree } from "./tree.js";

export const GOVERNANCE_ABI = parseAbi([
  "function submitWeightRoot(uint64 epoch, bytes32 root, uint256 totalWeight, bytes32 treeHash)",
  "function latestEpoch() view returns (uint64)",
  "function weightRoot(uint64 epoch) view returns ((bytes32 root, uint256 totalWeight, uint64 submittedAt, bool revoked, bytes32 treeHash))",
  "function leaf(uint64 epoch, address account, uint256 weight) view returns (bytes32)",
]);

export type PublishResult = { status: "published"; txHash: Hex } | { status: "skipped"; reason: string };

/**
 * Pushes the root of `tree` if it is newer than the latest on-chain epoch. Idempotent: re-running after a success
 * (or for an older day) is a no-op. Only the updater key can succeed.
 */
export async function publishRoot(
  publicClient: PublicClient,
  wallet: WalletClient<ReturnType<typeof import("viem").http>, Chain | undefined, Account>,
  governance: Address,
  tree: WeightTree,
): Promise<PublishResult> {
  const latest = await publicClient.readContract({ address: governance, abi: GOVERNANCE_ABI, functionName: "latestEpoch" });
  if (BigInt(tree.epoch) <= latest) return { status: "skipped", reason: `epoch ${tree.epoch} <= latest ${latest}` };
  const txHash = await wallet.writeContract({
    address: governance,
    abi: GOVERNANCE_ABI,
    functionName: "submitWeightRoot",
    args: [BigInt(tree.epoch), tree.root, tree.totalWeight, tree.treeHash],
    chain: wallet.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`submitWeightRoot reverted: ${txHash}`);
  return { status: "published", txHash };
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
}

/**
 * Independent verification (run by a SECOND indexer instance, not the updater): rebuilds the tree from chain data
 * and compares with what was published. A mismatch inside the challenge window must be escalated to the guardian,
 * who can revoke the root.
 */
export async function verifyRoot(publicClient: PublicClient, governance: Address, expected: WeightTree): Promise<VerifyResult> {
  const onchain = await publicClient.readContract({
    address: governance,
    abi: GOVERNANCE_ABI,
    functionName: "weightRoot",
    args: [BigInt(expected.epoch)],
  });
  const problems: string[] = [];
  if (onchain.root === `0x${"0".repeat(64)}`) problems.push(`no root on-chain for epoch ${expected.epoch}`);
  else {
    if (onchain.root.toLowerCase() !== expected.root.toLowerCase()) problems.push(`root ${onchain.root} != expected ${expected.root}`);
    if (onchain.totalWeight !== expected.totalWeight) problems.push(`totalWeight ${onchain.totalWeight} != expected ${expected.totalWeight}`);
    if (onchain.treeHash.toLowerCase() !== expected.treeHash.toLowerCase()) problems.push(`treeHash mismatch`);
  }
  return { ok: problems.length === 0, problems };
}
