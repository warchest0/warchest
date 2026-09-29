"use client";

import Link from "next/link";
import type { Address } from "viem";
import { tickerLabel } from "@/config/brand";
import { isDemo } from "@/config/env";
import type { HolderState } from "@/data/types";
import { explainError, useClaimRewards } from "@/hooks/actions";
import { useClaim, useHolder } from "@/hooks/queries";
import { useNow } from "@/hooks/useNow";
import { useViewer } from "@/hooks/useViewer";
import { fmtClock, fmtDate, fmtToken, fmtUsd, fmtWeight, shortAddr } from "@/lib/format";
import {
  DAY,
  MAX_LEVEL,
  averageLevel,
  dayOf,
  dayProgress,
  levelAt,
  maxLevelDay,
  secondsToNextLevel,
  streakDays,
  weightOf,
} from "@/lib/levels";
import { ConnectButton } from "../ConnectButton";
import { IconArrowRight, IconCheck, IconClock, IconCoins, IconFlame, IconTrophy } from "../icons";
import { Avatar } from "../ui/Avatar";
import { LevelRing } from "../ui/LevelRing";
import { Badge, Button, ButtonLink, Card, CardHeader, DemoBadge, ErrorNote, Meter, PageHeader, Skeleton, Stat } from "../ui/primitives";
import { SellSimulator } from "./SellSimulator";

export function DashboardView() {
  const { account } = useViewer();
  return <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">{account ? <Holder account={account} /> : <ConnectGate />}</div>;
}

function ConnectGate() {
  const { setPreview } = useViewer();
  return (
    <div className="relative overflow-hidden rounded-3xl border border-border bg-surface p-8 text-center sm:p-14">
      <div className="glow-bg pointer-events-none absolute inset-0" />
      <div className="relative mx-auto flex max-w-md flex-col items-center">
        <LevelRing level={7} dayProgress={0.62} size={148} />
        <h1 className="mt-8 text-2xl font-semibold tracking-tight sm:text-3xl">See your levels</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Connect the wallet that holds {tickerLabel} to see each lot&apos;s level, your voting multiplier, the next
          level countdown and your rewards.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <ConnectButton />
          {isDemo && (
            <Button variant="secondary" onClick={() => setPreview(true)}>
              Preview with a demo wallet
            </Button>
          )}
        </div>
        <div className="mt-6">
          <DemoBadge />
        </div>
      </div>
    </div>
  );
}

function Holder({ account }: { account: Address }) {
  const { preview } = useViewer();
  const holder = useHolder(account);
  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <DemoBadge />
            {preview && <Badge tone="warm">Preview wallet</Badge>}
            <span>Dashboard</span>
          </>
        }
        title={
          <span className="inline-flex items-center gap-3">
            <Avatar address={account} size={34} />
            <span className="num text-2xl sm:text-3xl">{shortAddr(account)}</span>
          </span>
        }
        right={
          holder.data?.rank ? (
            <ButtonLink variant="secondary" href="/leaderboard/">
              <IconTrophy className="text-warm" />
              Rank #{holder.data.rank}
              <span className="text-muted">of {holder.data.holders}</span>
            </ButtonLink>
          ) : null
        }
      />
      {holder.error ? <ErrorNote error={holder.error} /> : holder.data ? <HolderBody h={holder.data} /> : <HolderSkeleton />}
    </>
  );
}

function HolderSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Skeleton className="h-72 lg:col-span-2" />
      <Skeleton className="h-72" />
      <Skeleton className="h-48 lg:col-span-3" />
    </div>
  );
}

function HolderBody({ h }: { h: HolderState }) {
  const now = useNow();
  // `now` is 0 until hydrated: render against the snapshot day meanwhile
  const t = now || (h.snapshotEpoch !== undefined ? (h.snapshotEpoch + 1) * DAY : 0);
  const today = dayOf(t);
  const avg = averageLevel(h.lots, today);
  const weight = weightOf(h.lots, today);
  const allMaxed = h.lots.every((l) => levelAt(l.day, today) >= MAX_LEVEL);
  const streak = streakDays(h.lots, today);

  if (h.lots.length === 0) {
    return (
      <Card className="text-center">
        <p className="text-lg font-medium">This wallet holds no {tickerLabel} yet.</p>
        <p className="mt-2 text-sm text-muted">Every lot starts at level 0 and gains one level per UTC day, up to {MAX_LEVEL}.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="relative overflow-hidden lg:col-span-2">
          <div className="glow-bg pointer-events-none absolute inset-0 opacity-70" />
          <div className="relative flex flex-col items-center gap-8 sm:flex-row sm:items-center">
            <LevelRing level={avg} decimals={1} dayProgress={dayProgress(t)} size={188} label="Avg level" />
            <div className="w-full min-w-0 flex-1 text-center sm:text-left">
              <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted">Your vote counts</div>
              <div className="num mt-1 text-5xl font-semibold tracking-tight">
                <span className="text-gradient">×{avg.toFixed(2)}</span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted">
                Each {tickerLabel} you hold weighs {avg.toFixed(2)} in governance. A token bought today weighs 0, one
                held {MAX_LEVEL} days weighs {MAX_LEVEL}.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2 sm:justify-start">
                <span className="inline-flex items-center gap-2 rounded-xl bg-warm/10 px-3 py-2 text-sm text-warm ring-1 ring-inset ring-warm/25">
                  <IconFlame />
                  <span>
                    <span className="num font-semibold">{streak}</span>-day streak
                  </span>
                  {h.approximate && <span className="text-warm/70">+</span>}
                </span>
                {allMaxed ? (
                  <span className="inline-flex items-center gap-2 rounded-xl bg-accent/10 px-3 py-2 text-sm text-accent ring-1 ring-inset ring-accent/25">
                    <IconCheck /> Every lot is at max level
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm ring-1 ring-inset ring-border">
                    <IconClock className="text-muted" />
                    Next level in <span className="num font-semibold">{now ? fmtClock(secondsToNextLevel(now)) : "--:--:--"}</span>
                  </span>
                )}
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="grid gap-6">
            <Stat label="Balance" value={`${fmtToken(h.balance)}`} sub={tickerLabel} />
            <Stat label="Voting weight (live)" value={fmtWeight(weight)} sub="Σ lot × level, counted at the next daily snapshot" />
            <Stat
              label={`Snapshot weight${h.snapshotEpoch !== undefined ? ` · epoch ${h.snapshotEpoch}` : ""}`}
              value={h.snapshotWeight !== undefined ? fmtWeight(h.snapshotWeight) : "—"}
              sub={h.snapshotWeight !== undefined ? "What you can vote with in the current round" : "No published snapshot yet"}
            />
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Your lots"
          hint="Each purchase is a lot with its own level: 0 on the day you buy, +1 at every UTC midnight, capped at 10."
          right={<Badge tone="muted">{h.lots.length} lots</Badge>}
        />
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[...h.lots].reverse().map((lot, i) => {
            const lvl = levelAt(lot.day, today);
            const toMax = maxLevelDay(lot.day) - today;
            const preWindow = h.approximate && i === h.lots.length - 1;
            return (
              <li key={`${lot.day}-${i}`} className="flex items-center gap-4 rounded-xl border border-border bg-surface-2/50 p-4">
                <LevelRing level={lvl} size={64} dayProgress={lvl < MAX_LEVEL ? dayProgress(t) : undefined} />
                <div className="min-w-0">
                  <div className="num truncate font-semibold">{fmtToken(lot.amount)}</div>
                  <div className="text-xs text-muted">{preWindow ? "Held 10+ days" : `Since ${fmtDate(lot.day * DAY)}`}</div>
                  <div className={lvl >= MAX_LEVEL ? "mt-1 text-xs text-accent" : "mt-1 text-xs text-muted"}>
                    {lvl >= MAX_LEVEL ? "Max level" : `Level ${MAX_LEVEL} in ${toMax} day${toMax > 1 ? "s" : ""}`}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SellSimulator lots={h.lots} day={today} />
        </div>
        <Rewards account={h.account} />
      </div>

      <Card className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <div className="font-medium">Put your weight to work</div>
          <p className="mt-1 text-sm text-muted">Holders pick the next trade: asset and direction, weighted by level.</p>
        </div>
        <ButtonLink href="/vote/">
          Go to the vote <IconArrowRight />
        </ButtonLink>
      </Card>
    </div>
  );
}

function Rewards({ account }: { account: Address }) {
  const claim = useClaim(account);
  const action = useClaimRewards();
  const { connected } = useViewer();
  const c = claim.data;
  return (
    <Card>
      <CardHeader icon={<IconCoins />} title="Rewards" hint="Realized trading profit above the high-water mark, if distribution is enabled." />
      {claim.isLoading ? (
        <Skeleton className="h-24" />
      ) : claim.error ? (
        <ErrorNote error={claim.error} />
      ) : !c ? (
        <p className="text-sm leading-relaxed text-muted">
          Distribution is not enabled on this deployment. Whether profits are distributed or used for buyback is still
          an open decision (pending legal advice).
        </p>
      ) : (
        <div>
          <div className="text-xs text-muted">Claimable</div>
          <div className="num mt-1 text-3xl font-semibold text-accent">{fmtUsd(c.claimable, { cents: true })}</div>
          <div className="mt-1 text-xs text-muted">USDG · {fmtUsd(c.claimed, { cents: true })} already claimed</div>
          <Meter className="mt-4" value={c.cumulative === 0n ? 0 : Number((c.claimed * 1000n) / c.cumulative) / 1000} />
          <Button
            className="mt-5 w-full"
            disabled={c.claimable === 0n || action.isPending || (!isDemo && !connected)}
            onClick={() => action.mutate({ cumulative: c.cumulative, proof: c.proof })}
          >
            {action.isPending ? "Claiming…" : c.claimable === 0n ? "Nothing to claim" : "Claim"}
          </Button>
          {action.error && <p className="mt-3 text-xs text-short">{explainError(action.error)}</p>}
          {action.isSuccess && <p className="mt-3 text-xs text-accent">{isDemo ? "Demo: claim simulated, no transaction sent." : "Claimed."}</p>}
        </div>
      )}
      <Link href="/treasury/" className="mt-5 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        How profit is measured <IconArrowRight />
      </Link>
    </Card>
  );
}
