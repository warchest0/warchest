"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BaseError, ContractFunctionRevertedError, type Hex } from "viem";
import { useAccount, useSwitchChain, useWriteContract } from "wagmi";
import { distributorAbi, governanceAbi } from "@/abi";
import { env, isDemo } from "@/config/env";
import { demoProvider } from "@/data/mock";
import { publicClient } from "@/data/onchain";
import { provider } from "@/data/provider";
import type { RoundView } from "@/data/types";
import { useViewer } from "./useViewer";

/** Turns wallet / revert errors into one readable sentence. */
export function explainError(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      const map: Record<string, string> = {
        AlreadyVoted: "This wallet already voted in this round.",
        RoundNotOpen: "The round is closed.",
        InvalidProof: "The weight proof was rejected: the published tree may be outdated.",
        ZeroWeight: "This wallet has no voting weight in this snapshot.",
        IsPaused: "Governance is paused by the guardian.",
        InvalidOption: "Invalid option.",
      };
      if (name && map[name]) return map[name];
      if (name) return `Transaction reverted: ${name}`;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

function useEnsureChain() {
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  return async () => {
    if (chainId !== env.chainId) await switchChainAsync({ chainId: env.chainId });
  };
}

/** Casts the viewer's full snapshot weight for `option` (demo: simulated, no transaction). */
export function useCastVote() {
  const qc = useQueryClient();
  const { account, connected } = useViewer();
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureChain();

  return useMutation<Hex, Error, { round: RoundView; option: number }>({
    mutationFn: async ({ round, option }) => {
      if (!account) throw new Error("Connect a wallet to vote.");
      if (isDemo) return demoProvider.castVote(round.id, option, account);
      if (!connected) throw new Error("Connect a wallet to vote.");
      const proof = await provider.getVoteProof(round.epoch, account);
      if (!proof) throw new Error("This wallet has no weight in the snapshot used by this round.");
      await ensureChain();
      const hash = await writeContractAsync({
        address: env.governance!,
        abi: governanceAbi,
        functionName: "vote",
        args: [round.id, BigInt(option), proof.weight, proof.proof],
        chainId: env.chainId,
      });
      const receipt = await publicClient().waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The vote transaction reverted.");
      return hash;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [provider.mode, "rounds"] }),
  });
}

/** Claims everything the distributor owes the viewer. */
export function useClaimRewards() {
  const qc = useQueryClient();
  const { account } = useViewer();
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureChain();

  return useMutation<Hex, Error, { cumulative: bigint; proof: Hex[] }>({
    mutationFn: async ({ cumulative, proof }) => {
      if (!account) throw new Error("Connect a wallet to claim.");
      if (isDemo) return demoProvider.claim(account);
      await ensureChain();
      const hash = await writeContractAsync({
        address: env.distributor!,
        abi: distributorAbi,
        functionName: "claim",
        args: [account, cumulative, proof],
        chainId: env.chainId,
      });
      await publicClient().waitForTransactionReceipt({ hash });
      return hash;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [provider.mode, "claim"] }),
  });
}
