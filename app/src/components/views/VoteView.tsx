"use client";

import { useState, type ReactNode } from "react";
import { assetMeta } from "@/config/assets";
import { explorerTx } from "@/config/chains";
import { env, isDemo } from "@/config/env";
import type { PastRound, RoundView } from "@/data/types";
import { explainError, useCastVote } from "@/hooks/actions";
import { useActiveRounds, usePastRounds, useVoteProof } from "@/hooks/queries";
import { useNow } from "@/hooks/useNow";
import { useViewer } from "@/hooks/useViewer";
import { fmtBps, fmtClock, fmtDate, fmtUsd, fmtWeight } from "@/lib/format";
import { CLOSE_OPTIONS, Side, decodeOption, directionOptions, quorumProgressBps, sideLabel, uniqueLeader } from "@/lib/options";
import { ConnectButton } from "../ConnectButton";
import { IconCheck, IconClock, IconExternal, IconShield, IconVote } from "../icons";
import { AssetDot, AssetTag } from "../ui/AssetTag";
import { Badge, Button, Card, CardHeader, DemoBadge, ErrorNote, Meter, PageHeader, Skeleton, cx } from "../ui/primitives";
import { VoteBar } from "../ui/VoteBar";

export function VoteView() {
  const { account } = useViewer();
  const rounds = useActiveRounds(account);
  const [selected, setSelected] = useState<number | null>(null);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <PageHeader
        eyebrow={
          <>
            <DemoBadge />
            <span>Governance</span>
          </>
        }
        title="Choose the next trade"
      >
        Every round, holders vote on one asset and one direction. Your vote carries your full snapshot weight: tokens ×
        level. The treasury then opens that position on Hyperliquid, capped at 20% of its liquid value.
      </PageHeader>

      {rounds.error && <ErrorNote error={rounds.error} />}
      {rounds.data?.paused && (
        <div className="mb-4">
          <ErrorNote error="Governance is paused by the guardian: voting is suspended and running rounds can only fall back." />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {rounds.isLoading ? (
            <Skeleton className="h-[480px]" />
          ) : rounds.data?.direction ? (
            <DirectionRound round={rounds.data.direction} selected={selected} onSelect={setSelected} />
          ) : (
            <Card>
              <CardHeader title="No direction round is open" hint="Anyone can open one once a fresh weight snapshot has cleared its 6 h challenge window." />
            </Card>
          )}
          {rounds.data?.close && <CloseRound round={rounds.data.close} selected={selected} onSelect={setSelected} />}
        </div>
        <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <VotePanel round={selected !== null && selected >= 100 ? rounds.data?.close ?? null : rounds.data?.direction ?? null} option={selected === null ? null : selected % 100} />
          <RulesCard />
        </div>
      </div>

      <PastDecisions />
    </div>
  );
}

function RoundMeta({ round }: { round: RoundView }) {
  const now = useNow();
  const left = round.endsAt - now;
  const progress = quorumProgressBps(round.totalVoted, round.totalWeight, round.quorumBps) / 10_000;
  const turnout = round.totalWeight === 0n ? 0 : Number((round.totalVoted * 10_000n) / round.totalWeight) / 100;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div>
        <div className="text-xs text-muted">Time left</div>
        <div className="num mt-1 flex items-center gap-2 text-xl font-semibold">
          <IconClock className="text-muted" />
          {now === 0 ? "--:--:--" : left > 0 ? fmtClock(left) : "Ended"}
        </div>
      </div>
      <div className="sm:col-span-2">
        <div className="flex items-baseline justify-between text-xs text-muted">
          {progress >= 1 ? (
            <span className="text-long">Quorum reached</span>
          ) : (
            <span>
              Quorum <span className="num text-fg">{(progress * 100).toFixed(0)}%</span> reached
            </span>
          )}
          <span className="num">
            {turnout.toFixed(1)}% voted · needs {fmtBps(round.quorumBps)}
          </span>
        </div>
        <Meter className="mt-2 h-2.5" value={progress} tone={progress >= 1 ? "long" : "warm"} />
        <div className="mt-1.5 text-[11px] text-muted">
          {round.voters !== undefined && <span className="num">{round.voters} voters · </span>}
          snapshot epoch <span className="num">{round.epoch}</span>
        </div>
      </div>
    </div>
  );
}

function DirectionRound({ round, selected, onSelect }: { round: RoundView; selected: number | null; onSelect: (o: number) => void }) {
  const opts = directionOptions(round.assets);
  const total = round.tallies.reduce((a, b) => a + b, 0n);
  const leader = uniqueLeader(round.tallies);
  const locked = round.hasVoted;
  return (
    <Card>
      <CardHeader
        icon={<IconVote />}
        title={
          <span className="flex items-center gap-2">
            Round #{round.id.toString()} · Direction <span className="size-2 animate-pulse-soft rounded-full bg-long" aria-hidden="true" />
            <span className="sr-only">live</span>
          </span>
        }
        hint="Pick one asset and one side. Results update live."
        right={round.hasVoted ? <Badge tone="accent"><IconCheck /> You voted</Badge> : undefined}
      />
      <RoundMeta round={round} />
      <div role="radiogroup" aria-label="Options" className="mt-6 grid gap-3">
        {round.assets.map((asset, ai) => {
          const m = assetMeta(asset);
          return (
            <div key={asset} className="rounded-2xl border border-border/60 bg-bg/40 p-3">
              <div className="mb-2 flex items-center gap-2 px-1 text-sm">
                <AssetDot asset={asset} />
                <span className="font-medium">{m.symbol}</span>
                <span className="text-muted">{m.name}</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {opts
                  .filter((o) => o.assetIndex === ai)
                  .map((o) => {
                    const w = round.tallies[o.option] ?? 0n;
                    const share = total === 0n ? 0 : Number((w * 10_000n) / total) / 10_000;
                    return (
                      <VoteBar
                        key={o.option}
                        label={
                          <span className={o.side === Side.Long ? "text-long" : "text-short"}>
                            {sideLabel(o.side)} {m.symbol}
                          </span>
                        }
                        share={share}
                        weightLabel={`${fmtWeight(w)} weight`}
                        tone={o.side === Side.Long ? "long" : "short"}
                        leader={leader === o.option}
                        selected={selected === o.option}
                        disabled={locked}
                        onSelect={() => onSelect(o.option)}
                      />
                    );
                  })}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function CloseRound({ round, selected, onSelect }: { round: RoundView; selected: number | null; onSelect: (o: number) => void }) {
  const total = round.tallies.reduce((a, b) => a + b, 0n);
  const leader = uniqueLeader(round.tallies);
  return (
    <Card>
      <CardHeader
        title={`Round #${round.id} · Close decision #${round.targetDecisionId}?`}
        hint="The open position reached its profit threshold. Close it and lock the gain, or keep it running."
        right={round.hasVoted ? <Badge tone="accent"><IconCheck /> You voted</Badge> : undefined}
      />
      <RoundMeta round={round} />
      <div role="radiogroup" aria-label="Close options" className="mt-6 grid gap-2 sm:grid-cols-2">
        {CLOSE_OPTIONS.map((o) => {
          const w = round.tallies[o.option] ?? 0n;
          return (
            <VoteBar
              key={o.option}
              label={o.label}
              share={total === 0n ? 0 : Number((w * 10_000n) / total) / 10_000}
              weightLabel={`${fmtWeight(w)} weight`}
              tone={o.option === 1 ? "accent" : "muted"}
              leader={leader === o.option}
              selected={selected === 100 + o.option}
              disabled={round.hasVoted}
              onSelect={() => onSelect(100 + o.option)}
            />
          );
        })}
      </div>
    </Card>
  );
}

function VotePanel({ round, option }: { round: RoundView | null; option: number | null }) {
  const { account, connected, preview } = useViewer();
  const proof = useVoteProof(round?.epoch, account);
  const cast = useCastVote();
  const canUseDemo = isDemo && !!account;

  let choice: ReactNode = <span className="text-muted">Select an option</span>;
  if (round && option !== null) {
    if (round.kind === "direction") {
      const d = decodeOption(option, round.assets);
      choice = <AssetTag asset={d.asset} side={d.side} />;
    } else choice = <span className="font-medium">{CLOSE_OPTIONS[option]?.label}</span>;
  }

  return (
    <Card>
      <CardHeader title="Your vote" hint="One vote per wallet per round, with your full snapshot weight." />
      {!account ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">Connect the wallet that held tokens at the snapshot.</p>
          <ConnectButton />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">Your weight</span>
            <span className="num font-semibold">
              {proof.isLoading ? "…" : proof.data ? fmtWeight(proof.data.weight) : "0"}
            </span>
          </div>
          {proof.error && <ErrorNote error={proof.error} />}
          {!proof.isLoading && !proof.error && !proof.data && round && (
            <p className="text-xs leading-relaxed text-muted">
              This wallet has no weight in snapshot epoch {round.epoch}. Tokens must be held through at least one UTC
              midnight before the snapshot to count.
            </p>
          )}
          <div className="flex min-h-12 items-center justify-between rounded-xl border border-border bg-bg/50 px-4 py-3 text-sm">
            <span className="text-muted">Choice</span>
            {choice}
          </div>
          {round?.hasVoted ? (
            <div className="flex items-center gap-2 rounded-xl bg-accent/10 px-4 py-3 text-sm text-accent">
              <IconCheck /> Vote recorded for round #{round.id.toString()}
            </div>
          ) : (
            <Button
              className="w-full"
              disabled={!round || option === null || !proof.data || cast.isPending || (!connected && !canUseDemo)}
              onClick={() => round && option !== null && cast.mutate({ round, option })}
            >
              {cast.isPending ? "Confirm in wallet…" : "Cast vote"}
            </Button>
          )}
          {cast.error && <p className="text-xs text-short">{explainError(cast.error)}</p>}
          {cast.isSuccess &&
            (isDemo ? (
              <p className="text-xs text-warm">Demo: the vote was simulated, no transaction was sent{preview ? " (preview wallet)" : ""}.</p>
            ) : (
              <a className="inline-flex items-center gap-1 text-xs text-accent" href={explorerTx(env.chainId, cast.data)} target="_blank" rel="noreferrer">
                View transaction <IconExternal />
              </a>
            ))}
        </div>
      )}
    </Card>
  );
}

function RulesCard() {
  return (
    <Card>
      <CardHeader icon={<IconShield />} title="How votes are counted" />
      <ul className="space-y-3 text-sm leading-relaxed text-muted">
        <li>
          <span className="text-fg">Frozen snapshot.</span> Weights come from the daily snapshot the round opened on;
          transfers after it change nothing, so double voting is impossible.
        </li>
        <li>
          <span className="text-fg">Quorum 10%.</span> A new decision needs 10% of the snapshot weight to vote and a
          unique winner.
        </li>
        <li>
          <span className="text-fg">No quorum, no change.</span> Otherwise the previous decision stands. A position
          stopped out is never reopened without a new quorate vote.
        </li>
        <li>
          <span className="text-fg">Verifiable.</span> The weight tree is published; your proof is checked against the
          on-chain root before you sign.
        </li>
      </ul>
    </Card>
  );
}

const OUTCOME: Record<PastRound["outcome"], { label: string; tone: "accent" | "long" | "short" | "warm" | "muted" | "violet" }> = {
  decision: { label: "New decision", tone: "accent" },
  fallback: { label: "No quorum · previous stands", tone: "warm" },
  close: { label: "Close voted", tone: "violet" },
  keep: { label: "Kept open", tone: "muted" },
  void: { label: "Voided", tone: "short" },
  pending: { label: "Awaiting finalize", tone: "muted" },
};

function PastDecisions() {
  const past = usePastRounds();
  return (
    <section className="mt-12">
      <h2 className="mb-4 text-lg font-semibold tracking-tight">Past rounds</h2>
      {past.error && <ErrorNote error={past.error} />}
      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[640px] whitespace-nowrap text-sm">
          <thead className="bg-surface text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Round</th>
              <th className="px-4 py-3 font-medium">Ended</th>
              <th className="px-4 py-3 font-medium">Result</th>
              <th className="px-4 py-3 font-medium">Winner</th>
              <th className="px-4 py-3 text-right font-medium">Turnout</th>
              <th className="px-4 py-3 text-right font-medium">Realized PnL</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {past.isLoading &&
              Array.from({ length: 4 }, (_, i) => (
                <tr key={i}>
                  <td colSpan={6} className="px-4 py-3">
                    <Skeleton className="h-5" />
                  </td>
                </tr>
              ))}
            {past.data?.map((r) => {
              const o = OUTCOME[r.outcome];
              const turnout = r.totalWeight === 0n ? 0 : Number((r.totalVoted * 10_000n) / r.totalWeight) / 100;
              return (
                <tr key={r.id.toString()} className="bg-surface/40 transition-colors hover:bg-surface">
                  <td className="num px-4 py-3">
                    #{r.id.toString()} <span className="text-muted">· {r.kind}</span>
                  </td>
                  <td className="px-4 py-3 text-muted">{fmtDate(r.endsAt)}</td>
                  <td className="px-4 py-3">
                    <Badge tone={o.tone}>{o.label}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    {r.winner?.asset !== undefined && r.winner.side !== undefined ? (
                      <AssetTag asset={r.winner.asset} side={r.winner.side} />
                    ) : r.winner ? (
                      CLOSE_OPTIONS[r.winner.option]?.label
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className={cx("num px-4 py-3 text-right", r.quorate ? "text-fg" : "text-warm")}>{turnout.toFixed(1)}%</td>
                  <td className={cx("num px-4 py-3 text-right", r.pnl === undefined ? "text-muted" : r.pnl >= 0n ? "text-long" : "text-short")}>
                    {r.pnl === undefined ? "—" : fmtUsd(r.pnl, { sign: true })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
