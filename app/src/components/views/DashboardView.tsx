"use client";

import Link from "next/link";
import { useState } from "react";
import type { Address } from "viem";
import { tickerLabel } from "@/config/brand";
import { isDemo } from "@/config/env";
import type { HolderState } from "@/data/types";
import { explainError, useClaimRewards } from "@/hooks/actions";
import { useActiveRounds, useClaim, useHolder } from "@/hooks/queries";
import { useNow } from "@/hooks/useNow";
import { useViewer } from "@/hooks/useViewer";
import {
  fmtClock,
  fmtDate,
  fmtToken,
  fmtUsd,
  fmtWeight,
  shortAddr,
} from "@/lib/format";
import {
  DAY,
  MAX_LEVEL,
  averageLevel,
  dayOf,
  levelAt,
  maxLevelDay,
  secondsToNextLevel,
  streakDays,
  weightOf,
} from "@/lib/levels";
import { ConnectButton } from "../ConnectButton";
import { IconArrowRight, IconClock, IconCoins, IconTrophy } from "../icons";
import { LevelRing } from "../ui/LevelRing";
import {
  Button,
  ButtonLink,
  Card,
  CardHeader,
  DemoBadge,
  ErrorNote,
  Meter,
  PageHeader,
  Skeleton,
  Stat,
} from "../ui/primitives";
import { SellSimulator } from "./SellSimulator";

export function DashboardView() {
  const { account } = useViewer();
  return (
    <div className="dashboard-shell mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      {account ? <Holder account={account} /> : <ConnectGate />}
    </div>
  );
}

function ConnectGate() {
  const { setPreview } = useViewer();
  return (
    <div className="relative overflow-hidden rounded-3xl border border-border bg-surface p-8 text-center sm:p-14">
      <div className="glow-bg pointer-events-none absolute inset-0" />
      <div className="relative mx-auto flex max-w-md flex-col items-center">
        <LevelRing level={7} dayProgress={0.62} size={148} />
        <h1 className="mt-8 text-2xl font-semibold tracking-tight sm:text-3xl">
          See your levels
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Connect the wallet that holds {tickerLabel} to see each lot&apos;s
          level, your voting multiplier, the next level countdown and your
          rewards.
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
        eyebrow="Your portfolio"
        title="Overview"
        right={
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
            <span className="wallet-label num">
              {preview ? "Preview · " : ""}
              {shortAddr(account)}
            </span>
            {holder.data?.rank && (
              <Link
                className="inline-flex items-center gap-2 text-fg hover:text-accent"
                href="/leaderboard/"
              >
                <IconTrophy /> #{holder.data.rank}{" "}
                <span className="text-muted">/ {holder.data.holders}</span>
                <IconArrowRight />
              </Link>
            )}
          </div>
        }
      />
      {holder.error ? (
        <ErrorNote error={holder.error} />
      ) : holder.data ? (
        <HolderBody h={holder.data} />
      ) : (
        <HolderSkeleton />
      )}
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
  const [filter, setFilter] = useState<"all" | "growing" | "max">("all");
  // `now` is 0 until hydrated: render against the snapshot day meanwhile
  const t =
    now || (h.snapshotEpoch !== undefined ? (h.snapshotEpoch + 1) * DAY : 0);
  const today = dayOf(t);
  const avg = averageLevel(h.lots, today);
  const weight = weightOf(h.lots, today);
  const allMaxed = h.lots.every((l) => levelAt(l.day, today) >= MAX_LEVEL);
  const streak = streakDays(h.lots, today);

  if (h.lots.length === 0) {
    return (
      <Card className="text-center">
        <p className="text-lg font-medium">
          This wallet holds no {tickerLabel} yet.
        </p>
        <p className="mt-2 text-sm text-muted">
          Every lot starts at level 0 and gains one level per UTC day, up to{" "}
          {MAX_LEVEL}.
        </p>
      </Card>
    );
  }

  const visibleLots = [...h.lots]
    .reverse()
    .filter(
      (lot) =>
        filter === "all" ||
        (filter === "max"
          ? levelAt(lot.day, today) >= MAX_LEVEL
          : levelAt(lot.day, today) < MAX_LEVEL),
    );
  return (
    <div className="space-y-6">
      <section className="portfolio-metrics" aria-label="Portfolio summary">
        <Stat
          label="Token balance"
          value={fmtToken(h.balance)}
          sub={tickerLabel}
        />
        <Stat
          label="Latest snapshot weight"
          value={
            h.snapshotWeight !== undefined ? fmtWeight(h.snapshotWeight) : "—"
          }
          sub={
            h.snapshotEpoch !== undefined
              ? `Published snapshot · epoch ${h.snapshotEpoch}`
              : "Awaiting a published snapshot"
          }
        />
        <Stat
          label="Current voting weight"
          value={fmtWeight(weight)}
          sub="Based on your lots’ current levels"
        />
      </section>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <section className="conviction-panel">
          <div className="flex items-center justify-between gap-4">
            <span className="section-label">01 / Holding conviction</span>
            <span className="text-xs text-muted">
              {streak}
              {h.approximate ? "+" : ""} days held
            </span>
          </div>
          <div className="conviction-content">
            <div className="conviction-gauge">
              <LevelRing
                level={avg}
                decimals={2}
                size={152}
                stroke={5}
                label="Average level"
              />
            </div>
            <div className="min-w-0">
              <h2 className="text-2xl font-medium tracking-tight">
                Time gives you a voice.
              </h2>
              <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted">
                Your holdings gain voting power every day. Each lot reaches its
                maximum after 10 UTC days.
              </p>
              <div className="mt-6 flex items-center gap-2 text-xs text-accent">
                <IconClock />
                <span>
                  {allMaxed
                    ? "All lots at maximum level"
                    : "Next level at 00:00 UTC"}
                </span>
              </div>
              {!allMaxed && (
                <div className="num mt-2 text-xl tracking-tight">
                  {now ? fmtClock(secondsToNextLevel(now)) : "--:--:--"}
                  <span className="ml-2 font-sans text-xs text-muted">
                    remaining
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className="conviction-foot">
            <span>
              Acquired today <span className="text-fg">0×</span>
            </span>
            <span className="progress-line" />
            <span>
              Day 10 <span className="text-accent">10×</span>
            </span>
          </div>
        </section>
        <GovernancePreview account={h.account} now={now} />
      </div>
      <section className="lots-panel" aria-labelledby="lots-heading">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-6">
          <div>
            <h2 id="lots-heading" className="text-base font-medium">
              Your positions{" "}
              <span className="ml-2 text-xs text-muted">
                {h.lots.length} lots
              </span>
            </h2>
            <p className="mt-1 text-xs text-muted">
              One purchase. One timeline. Increasing voting power.
            </p>
          </div>
          <div className="lot-filters" role="group" aria-label="Filter lots">
            {(
              [
                ["all", "All lots"],
                ["growing", "Growing"],
                ["max", "Max level"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="lots-table">
            <thead>
              <tr>
                <th scope="col">Acquired</th>
                <th scope="col">Amount</th>
                <th scope="col">Level progression</th>
                <th scope="col">Voting weight</th>
                <th scope="col">Maturity</th>
              </tr>
            </thead>
            <tbody>
              {visibleLots.map((lot, i) => {
                const lvl = levelAt(lot.day, today);
                const toMax = maxLevelDay(lot.day) - today;
                const preWindow = h.approximate && lot === h.lots[0];
                return (
                  <tr key={`${lot.day}-${i}`}>
                    <td>
                      <span className="text-fg">
                        {preWindow ? "Held 10+ days" : fmtDate(lot.day * DAY)}
                      </span>
                      <span className="mt-1 block text-[11px] text-muted">
                        {preWindow
                          ? "Estimated acquisition"
                          : "UTC acquisition date"}
                      </span>
                    </td>
                    <td className="num text-fg">
                      {fmtToken(lot.amount)}
                      <span className="ml-1 text-[11px] text-muted">
                        {tickerLabel}
                      </span>
                    </td>
                    <td>
                      <div className="flex items-center gap-3">
                        <div className="lot-segments" aria-hidden="true">
                          {Array.from({ length: MAX_LEVEL }, (_, n) => (
                            <span key={n} data-filled={n < lvl} />
                          ))}
                        </div>
                        <span className="num text-xs">
                          {lvl}
                          <span className="text-muted"> / 10</span>
                        </span>
                      </div>
                    </td>
                    <td className="num">
                      {fmtWeight(lot.amount * BigInt(lvl))}
                    </td>
                    <td>
                      {lvl >= MAX_LEVEL ? (
                        <span className="text-xs text-long">Fully matured</span>
                      ) : (
                        <span className="text-xs text-muted">
                          {toMax} day{toMax !== 1 ? "s" : ""} to max
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visibleLots.length === 0 && (
            <p className="px-6 py-10 text-center text-sm text-muted">
              No lots in this category.
            </p>
          )}
        </div>
        <div className="border-t border-border px-6 py-3 text-[11px] text-muted">
          Levels increase at UTC midnight. Selling removes your newest lots
          first.
        </div>
      </section>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <SellSimulator lots={h.lots} day={today} />
        </div>
        <Rewards account={h.account} />
      </div>
    </div>
  );
}

function GovernancePreview({
  account,
  now,
}: {
  account: Address;
  now: number;
}) {
  const rounds = useActiveRounds(account);
  const round = rounds.data?.direction ?? rounds.data?.close;
  const open =
    !!round &&
    !round.finalized &&
    !round.voided &&
    now >= round.startsAt &&
    now < round.endsAt &&
    !rounds.data?.paused;
  const participation =
    round && round.totalWeight > 0n
      ? Number((round.totalVoted * 10000n) / round.totalWeight) / 100
      : 0;
  return (
    <section className="governance-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="section-label">02 / Governance</span>
        {open && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-long">
            <span className="size-1 rounded-full bg-long" />
            Voting open
          </span>
        )}
      </div>
      {rounds.isLoading ? (
        <Skeleton className="my-6 h-32" />
      ) : rounds.error ? (
        <div className="my-5">
          <ErrorNote error={rounds.error} />
        </div>
      ) : (
        <div className="my-6">
          <h2 className="text-2xl font-medium tracking-tight">
            {open ? "The next move is yours." : "Decisions, made together."}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            {open
              ? round.hasVoted
                ? "Your vote is recorded. Follow the round as the community decides."
                : round.kind === "close"
                  ? "Decide whether to close the treasury’s position. Your snapshot determines your voting power."
                  : "Choose the treasury’s next direction. Your snapshot determines your voting power."
              : "Explore community decisions and the status of the next voting round."}
          </p>
          {open && (
            <div className="mt-5">
              <div className="mb-2 flex justify-between text-xs">
                <span className="text-muted">Participation</span>
                <span className="num">{participation.toFixed(1)}%</span>
              </div>
              <Meter value={participation / 100} />
              <p className="mt-2 text-[11px] text-muted">
                Quorum {round.quorumBps / 100}% · Ends in{" "}
                {fmtClock(round.endsAt - now)}
              </p>
            </div>
          )}
        </div>
      )}
      <ButtonLink href="/vote/" className="mt-auto w-full">
        {open && !round.hasVoted ? "Explore the vote" : "View governance"}
        <IconArrowRight />
      </ButtonLink>
    </section>
  );
}

function Rewards({ account }: { account: Address }) {
  const claim = useClaim(account);
  const action = useClaimRewards();
  const { connected } = useViewer();
  const c = claim.data;
  return (
    <Card>
      <CardHeader
        icon={<IconCoins />}
        title="Rewards"
        hint="Realized trading profit above the high-water mark, if distribution is enabled."
      />
      {claim.isLoading ? (
        <Skeleton className="h-24" />
      ) : claim.error ? (
        <ErrorNote error={claim.error} />
      ) : !c ? (
        <p className="text-sm leading-relaxed text-muted">
          Distribution is not enabled on this deployment. Whether profits are
          distributed or used for buyback is still an open decision (pending
          legal advice).
        </p>
      ) : (
        <div>
          <div className="text-xs text-muted">Claimable</div>
          <div className="num mt-1 text-3xl font-semibold text-accent">
            {fmtUsd(c.claimable, { cents: true })}
          </div>
          <div className="mt-1 text-xs text-muted">
            USDG · {fmtUsd(c.claimed, { cents: true })} already claimed
          </div>
          <Meter
            className="mt-4"
            value={
              c.cumulative === 0n
                ? 0
                : Number((c.claimed * 1000n) / c.cumulative) / 1000
            }
          />
          <Button
            className="mt-5 w-full"
            disabled={
              c.claimable === 0n || action.isPending || (!isDemo && !connected)
            }
            onClick={() =>
              action.mutate({ cumulative: c.cumulative, proof: c.proof })
            }
          >
            {action.isPending
              ? "Claiming…"
              : c.claimable === 0n
                ? "Nothing to claim"
                : "Claim"}
          </Button>
          {action.error && (
            <p className="mt-3 text-xs text-short">
              {explainError(action.error)}
            </p>
          )}
          {action.isSuccess && (
            <p className="mt-3 text-xs text-accent">
              {isDemo
                ? "Demo: claim simulated, no transaction sent."
                : "Claimed."}
            </p>
          )}
        </div>
      )}
      <Link
        href="/treasury/"
        className="mt-5 inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
      >
        How profit is measured <IconArrowRight />
      </Link>
    </Card>
  );
}
