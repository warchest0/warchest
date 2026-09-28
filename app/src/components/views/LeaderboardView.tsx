"use client";

import { useMemo, useState } from "react";
import type { LeaderboardEntry } from "@/data/types";
import { useHolder, useLeaderboard } from "@/hooks/queries";
import { useNow } from "@/hooks/useNow";
import { useViewer } from "@/hooks/useViewer";
import { fmtWeight, shortAddr } from "@/lib/format";
import { DAY, averageLevel, dayOf, streakDays } from "@/lib/levels";
import { ConnectButton } from "../ConnectButton";
import { IconCheck, IconSearch, IconTrophy } from "../icons";
import { AddressLabel, Avatar } from "../ui/Avatar";
import { Badge, Button, Card, CardHeader, DemoBadge, ErrorNote, PageHeader, Skeleton, cx } from "../ui/primitives";
import { RankCard, type RankCardData } from "./RankCard";

const PAGE = 25;

export function LeaderboardView() {
  const lb = useLeaderboard();
  const { account } = useViewer();
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const entries = useMemo(() => lb.data?.entries ?? [], [lb.data]);
  const filtered = useMemo(() => (q ? entries.filter((e) => e.account.toLowerCase().includes(q.trim().toLowerCase())) : entries), [entries, q]);
  const mine = account ? entries.find((e) => e.account.toLowerCase() === account.toLowerCase()) : undefined;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <PageHeader
        eyebrow={
          <>
            <DemoBadge />
            <span>Leaderboard</span>
          </>
        }
        title="Holders by voting weight"
        right={
          lb.data && lb.data.epoch > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="num">Snapshot epoch {lb.data.epoch}</span>
              {lb.data.rootVerified === true && <Badge tone="long"><IconCheck /> Root verified on-chain</Badge>}
              {lb.data.rootVerified === false && <Badge tone="short">Root mismatch</Badge>}
            </div>
          ) : null
        }
      >
        Weight = tokens × level, from the latest daily snapshot published by the indexer. Everyone can rebuild it from
        the published tree.
      </PageHeader>
      {lb.error && <ErrorNote error={lb.error} />}

      <div className="grid gap-4 sm:grid-cols-3">
        {lb.isLoading
          ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-36" />)
          : entries.slice(0, 3).map((e) => <Podium key={e.account} e={e} you={e.account === mine?.account} />)}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_420px]">
        <div>
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-border bg-surface px-3 focus-within:border-accent">
            <IconSearch className="text-muted" />
            <label htmlFor="lb-search" className="sr-only">
              Search an address
            </label>
            <input
              id="lb-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search an address"
              className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted"
            />
          </div>
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="bg-surface text-left text-xs text-muted">
                <tr>
                  <th className="w-16 px-4 py-3 font-medium">Rank</th>
                  <th className="px-4 py-3 font-medium">Holder</th>
                  <th className="px-4 py-3 text-right font-medium">Weight</th>
                  <th className="w-40 px-4 py-3 font-medium">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lb.isLoading &&
                  Array.from({ length: 8 }, (_, i) => (
                    <tr key={i}>
                      <td colSpan={4} className="px-4 py-3">
                        <Skeleton className="h-5" />
                      </td>
                    </tr>
                  ))}
                {filtered.slice(0, limit).map((e) => {
                  const you = e.account === mine?.account;
                  const maxShare = entries[0]?.share || 1;
                  return (
                    <tr key={e.account} className={cx("transition-colors hover:bg-surface", you ? "bg-accent/8" : "bg-surface/40")}>
                      <td className="num px-4 py-3 text-muted">{e.rank}</td>
                      <td className="px-4 py-3">
                        <AddressLabel address={e.account} you={you} />
                      </td>
                      <td className="num px-4 py-3 text-right">{fmtWeight(e.weight)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                            <div className="h-full rounded-full bg-accent/80" style={{ width: `${(e.share / maxShare) * 100}%` }} />
                          </div>
                          <span className="num w-12 text-right text-xs text-muted">{(e.share * 100).toFixed(2)}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {lb.data && filtered.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-muted">
                      No holder matches.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {filtered.length > limit && (
            <Button variant="secondary" className="mt-3 w-full" onClick={() => setLimit((l) => l + PAGE)}>
              Show more ({filtered.length - limit} left)
            </Button>
          )}
        </div>

        <div className="lg:sticky lg:top-20 lg:self-start">
          <MyRankCard entry={mine} total={entries.length} example={entries[0]} />
        </div>
      </div>
    </div>
  );
}

function Podium({ e, you }: { e: LeaderboardEntry; you: boolean }) {
  const medal = ["text-warm", "text-fg/80", "text-[#d08b5b]"][e.rank - 1];
  return (
    <Card className={cx("relative overflow-hidden", e.rank === 1 && "sm:-translate-y-1")}>
      {e.rank === 1 && <div className="glow-bg pointer-events-none absolute inset-0" />}
      <div className="relative flex items-center gap-4">
        <Avatar address={e.account} size={44} />
        <div className="min-w-0">
          <div className={cx("flex items-center gap-1.5 text-sm font-semibold", medal)}>
            <IconTrophy /> #{e.rank}
          </div>
          <div className="num truncate text-sm">
            {shortAddr(e.account)}
            {you && <span className="ml-2 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">YOU</span>}
          </div>
        </div>
      </div>
      <div className="relative mt-5 flex items-end justify-between">
        <div>
          <div className="text-xs text-muted">Weight</div>
          <div className="num text-xl font-semibold">{fmtWeight(e.weight)}</div>
        </div>
        <div className="num text-sm text-muted">{(e.share * 100).toFixed(2)}%</div>
      </div>
    </Card>
  );
}

function MyRankCard({ entry, total, example }: { entry?: LeaderboardEntry; total: number; example?: LeaderboardEntry }) {
  const { account } = useViewer();
  const holder = useHolder(entry ? account : undefined);
  const now = useNow();
  const today = dayOf(now || (holder.data?.snapshotEpoch ?? 0) * DAY + DAY);

  const base = entry ?? example;
  if (!base) return <Skeleton className="h-80" />;
  const d: RankCardData = {
    address: base.account,
    rank: base.rank,
    holders: total,
    weight: fmtWeight(base.weight),
    share: base.share,
    level: entry && holder.data ? averageLevel(holder.data.lots, today) : undefined,
    streak: entry && holder.data ? streakDays(holder.data.lots, today) : undefined,
  };
  return (
    <Card>
      <CardHeader
        icon={<IconTrophy />}
        title={entry ? "Your rank card" : "Rank card"}
        hint={entry ? "Image-ready, 1200×630. Share it anywhere." : account ? "This wallet is not in the latest snapshot. Example card below." : "Connect to get your own. Example card below."}
      />
      <RankCard d={d} />
      {!account && (
        <div className="mt-4">
          <ConnectButton />
        </div>
      )}
    </Card>
  );
}
