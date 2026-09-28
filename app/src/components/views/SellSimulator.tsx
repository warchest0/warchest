"use client";

import { useMemo, useState } from "react";
import { tickerLabel } from "@/config/brand";
import { fmtToken } from "@/lib/format";
import { MAX_LEVEL, balanceOf, levelAt, type Lot } from "@/lib/levels";
import { simulateSellBps, weightIfFifo } from "@/lib/lifo";
import { Card, CardHeader, cx } from "../ui/primitives";
import { IconChart } from "../icons";

const PRESETS = [1000, 2500, 5000, 7500];

/** "Sell X% → you keep level Y on the rest": LIFO consumes the newest lots first. */
export function SellSimulator({ lots, day }: { lots: Lot[]; day: number }) {
  const [bps, setBps] = useState(2500);
  const sim = useMemo(() => simulateSellBps(lots, bps, day), [lots, bps, day]);
  const fifoKept = useMemo(() => {
    const w = weightIfFifo(lots, sim.sold, day);
    return sim.weightBefore === 0n ? 0 : Number((w * 10_000n) / sim.weightBefore) / 100;
  }, [lots, sim, day]);
  const balance = balanceOf(lots);

  // stacked bar: oldest (left) → newest (right); the sold part eats from the right
  let soldLeft = sim.sold;
  const segments = [...lots]
    .reverse()
    .map((l) => {
      const sold = soldLeft >= l.amount ? l.amount : soldLeft;
      soldLeft -= sold;
      return { lot: l, sold };
    })
    .reverse();

  return (
    <Card>
      <CardHeader
        icon={<IconChart />}
        title="Sell simulator"
        hint="Sales consume your newest tokens first (LIFO), so trimming never resets the level of what you have held the longest."
      />
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setBps(p)}
            className={cx(
              "rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition-colors",
              bps === p ? "bg-accent/15 text-accent ring-accent/40" : "text-muted ring-border hover:text-fg",
            )}
          >
            {p / 100}%
          </button>
        ))}
        <span className="num ml-auto text-sm text-muted">
          Sell <span className="text-fg">{(bps / 100).toFixed(0)}%</span> · {fmtToken(sim.sold)} {tickerLabel}
        </span>
      </div>
      <label className="sr-only" htmlFor="sell-pct">
        Share of the balance to sell
      </label>
      <input
        id="sell-pct"
        type="range"
        min={0}
        max={10_000}
        step={100}
        value={bps}
        onChange={(e) => setBps(Number(e.target.value))}
        className="range mt-5 w-full"
        style={{ ["--fill" as string]: `${bps / 100}%` }}
      />

      <div className="mt-6 flex h-10 w-full overflow-hidden rounded-lg ring-1 ring-border" aria-hidden="true">
        {balance > 0n &&
          segments.map(({ lot, sold }, i) => {
            const w = Number((lot.amount * 10_000n) / balance) / 100;
            const soldPct = lot.amount === 0n ? 0 : Number((sold * 10_000n) / lot.amount) / 100;
            const lvl = levelAt(lot.day, day);
            return (
              <div key={i} className="relative h-full border-r border-bg last:border-r-0" style={{ width: `${w}%` }}>
                <div
                  className="absolute inset-0"
                  style={{
                    background: `color-mix(in oklab, var(--color-accent) ${25 + (lvl / MAX_LEVEL) * 65}%, var(--color-accent-2))`,
                    opacity: 0.35 + (lvl / MAX_LEVEL) * 0.6,
                  }}
                />
                <div className="hatch absolute inset-y-0 right-0 transition-[width] duration-300" style={{ width: `${soldPct}%` }} />
                <span className="num absolute left-1.5 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-bg">
                  {w > 9 ? `L${lvl}` : ""}
                </span>
              </div>
            );
          })}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted">
        <span>Oldest lots</span>
        <span>Newest lots · sold first</span>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">You keep</dt>
          <dd className="num mt-1 text-lg font-semibold">{fmtToken(sim.remaining)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Avg level on the rest</dt>
          <dd className="num mt-1 text-lg font-semibold">
            {sim.avgLevelAfter.toFixed(1)}
            <span className="ml-1 text-xs font-normal text-muted">was {sim.avgLevelBefore.toFixed(1)}</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Voting weight kept</dt>
          <dd className="num mt-1 text-lg font-semibold text-accent">{(sim.weightKeptBps / 100).toFixed(1)}%</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">If sales were FIFO</dt>
          <dd className="num mt-1 text-lg font-semibold text-muted">{fifoKept.toFixed(1)}%</dd>
        </div>
      </dl>
      <p className="mt-4 text-xs leading-relaxed text-muted">
        {sim.remaining === 0n
          ? "Selling everything resets your book: new tokens start again at level 0."
          : `After this sale your oldest tokens stay at level ${sim.topLevelAfter}. Any wallet-to-wallet transfer counts as a sale for the sender and a fresh level-0 lot for the receiver.`}
      </p>
    </Card>
  );
}
