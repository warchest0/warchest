"use client";

import { useEffect, useState } from "react";
import { brand, tickerLabel } from "@/config/brand";
import { assetMeta } from "@/config/assets";
import { useActiveRounds, useLeaderboard, useTreasury } from "@/hooks/queries";
import { fmtUsd } from "@/lib/format";
import { MAX_LEVEL } from "@/lib/levels";
import { decodeOption, sideLabel, uniqueLeader } from "@/lib/options";
import { IconArrowRight, IconFlame } from "../icons";
import { LevelRing } from "../ui/LevelRing";
import { ButtonLink, DemoBadge, cx } from "../ui/primitives";

export function Hero() {
  const parts = brand.tagline.split(/(?<=\.)\s+/);
  const last = parts.pop();
  return (
    <section className="relative overflow-hidden">
      <div className="glow-bg pointer-events-none absolute inset-0" />
      <div className="grid-bg pointer-events-none absolute inset-0 opacity-60" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-14 sm:px-6 md:pt-24 lg:grid-cols-[1.15fr_1fr]">
        <div className="animate-fade-up">
          <div className="mb-6 flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-border bg-surface/70 px-3 py-1 text-xs text-muted">
              {tickerLabel} on Robinhood Chain · trades on Hyperliquid
            </span>
            <DemoBadge />
          </div>
          <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight text-balance sm:text-6xl">
            {parts.join(" ")} <span className="text-gradient">{last}</span>
          </h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-muted sm:text-lg">{brand.description}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/dashboard/" className="px-5 py-3">
              Open the app <IconArrowRight />
            </ButtonLink>
            <ButtonLink href="/treasury/" variant="secondary" className="px-5 py-3">
              See the treasury
            </ButtonLink>
          </div>
        </div>
        <HeroVisual />
      </div>
      <LiveStrip />
    </section>
  );
}

function HeroVisual() {
  const [level, setLevel] = useState(3);
  useEffect(() => {
    const id = setInterval(() => setLevel((l) => (l >= MAX_LEVEL ? 1 : l + 1)), 1400);
    return () => clearInterval(id);
  }, []);
  const bars = [
    { label: "ETH Long", v: 0.41, tone: "bg-long" },
    { label: "BTC Long", v: 0.3, tone: "bg-long" },
    { label: "BTC Short", v: 0.09, tone: "bg-short" },
  ];
  return (
    <div className="relative mx-auto w-full max-w-md animate-fade-up [animation-delay:120ms]">
      <div className="rounded-3xl border border-border bg-surface/80 p-6 shadow-[0_40px_120px_-40px_rgba(0,0,0,0.9)] backdrop-blur">
        <div className="flex items-center gap-6">
          <LevelRing level={level} dayProgress={0.66} size={150} />
          <div>
            <div className="text-xs uppercase tracking-[0.14em] text-muted">Your vote counts</div>
            <div className="num text-4xl font-semibold">
              <span className="text-gradient">×{level}</span>
            </div>
            <div className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-warm/10 px-2.5 py-1.5 text-xs text-warm">
              <IconFlame /> {level}-day streak
            </div>
          </div>
        </div>
        <div className="mt-6 text-[11px] font-medium uppercase tracking-[0.14em] text-muted">Example round</div>
        <div className="mt-2 space-y-2.5">
          {bars.map((b) => (
            <div key={b.label} className="relative overflow-hidden rounded-xl border border-border bg-bg/50 px-3 py-2.5">
              <div className={cx("absolute inset-y-0 left-0 opacity-20", b.tone)} style={{ width: `${b.v * 100}%` }} />
              <div className="relative flex justify-between text-sm">
                <span>{b.label}</span>
                <span className="num text-muted">{(b.v * 100).toFixed(0)}%</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="absolute -bottom-12 -right-4 hidden rounded-2xl border border-border bg-surface px-4 py-3 text-xs shadow-2xl sm:block">
        <div className="text-muted">Each trade capped at</div>
        <div className="num text-lg font-semibold text-accent">20% of treasury</div>
      </div>
    </div>
  );
}

function LiveStrip() {
  const t = useTreasury();
  const r = useActiveRounds();
  const lb = useLeaderboard();
  const round = r.data?.direction;
  const lead = round ? uniqueLeader(round.tallies) : -1;
  const leadLabel = round && lead >= 0 ? (() => {
    const d = decodeOption(lead, round.assets);
    return `${assetMeta(d.asset).symbol} ${sideLabel(d.side)}`;
  })() : "—";
  const items = [
    { k: "Treasury NAV", v: t.data ? fmtUsd(t.data.nav) : "…" },
    { k: "Realized PnL", v: t.data ? fmtUsd(t.data.cumulativePnl, { sign: true }) : "…", tone: t.data && t.data.cumulativePnl < 0n ? "text-short" : "text-long" },
    { k: "Leading the vote", v: leadLabel },
    { k: "Holders with weight", v: lb.data ? lb.data.entries.length.toLocaleString("en-US") : "…" },
  ];
  return (
    <div className="relative border-y border-border/70 bg-surface/50">
      <dl className="mx-auto grid max-w-6xl grid-cols-2 divide-border px-4 sm:px-6 md:grid-cols-4 md:divide-x">
        {items.map((i) => (
          <div key={i.k} className="py-5 md:px-6 md:first:pl-0">
            <dt className="text-xs text-muted">{i.k}</dt>
            <dd className={cx("num mt-1 text-xl font-semibold", i.tone)}>{i.v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
