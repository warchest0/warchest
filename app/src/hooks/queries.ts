"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { provider } from "@/data/provider";

/** Read hooks. All data goes through `provider` (demo or on-chain), so pages never care which one is active. */
const mode = provider.mode;

export function useTreasury() {
  return useQuery({ queryKey: [mode, "treasury"], queryFn: () => provider.getTreasury(), refetchInterval: 30_000 });
}

export function useVaultEvents() {
  return useQuery({ queryKey: [mode, "vault-events"], queryFn: () => provider.getVaultEvents(), refetchInterval: 60_000 });
}

export function usePnlHistory() {
  return useQuery({ queryKey: [mode, "pnl-history"], queryFn: () => provider.getPnlHistory(), staleTime: 5 * 60_000 });
}

export function useActiveRounds(account?: Address) {
  return useQuery({
    queryKey: [mode, "rounds", account ?? null],
    queryFn: () => provider.getActiveRounds(account),
    refetchInterval: 5_000,
  });
}

export function usePastRounds() {
  return useQuery({ queryKey: [mode, "past-rounds"], queryFn: () => provider.getPastRounds(), staleTime: 60_000 });
}

export function useHolder(account?: Address) {
  return useQuery({
    queryKey: [mode, "holder", account ?? null],
    queryFn: () => provider.getHolder(account!),
    enabled: !!account,
    staleTime: 60_000,
  });
}

export function useLeaderboard() {
  return useQuery({ queryKey: [mode, "leaderboard"], queryFn: () => provider.getLeaderboard(), staleTime: 5 * 60_000 });
}

export function useVoteProof(epoch?: number, account?: Address) {
  return useQuery({
    queryKey: [mode, "vote-proof", epoch ?? null, account ?? null],
    queryFn: () => provider.getVoteProof(epoch!, account!),
    enabled: epoch !== undefined && !!account,
    staleTime: Infinity,
    retry: 1,
  });
}

export function useClaim(account?: Address) {
  return useQuery({
    queryKey: [mode, "claim", account ?? null],
    queryFn: () => provider.getClaim(account!),
    enabled: !!account,
  });
}
