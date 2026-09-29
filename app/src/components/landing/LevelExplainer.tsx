"use client";

import { useState } from "react";
import { tickerLabel } from "@/config/brand";
import { MAX_LEVEL, levelAt } from "@/lib/levels";
import { simulateSell } from "@/lib/lifo";
import { LevelRing } from "../ui/LevelRing";
import { cx } from "../ui/primitives";

const E = 10n ** 18n;
/** Example book on day 20: 1,000 bought on day 5, 500 on day 16, 500 on day 19. */
const LOTS = [
  { amount: 1000n * E, day: 5 },
  { amount: 500n * E, day: 16 },
  { amount: 500n * E, day: 19 },
];
const DAY_NOW = 20;

export function LevelExplainer() {
  const [days, setDays] = useState(6);
  const [sold, setSold] = useState(false);
  const level = levelAt(0, days);
  const sim = simulateSell(LOTS, 700n * E, DAY_NOW);

  return (
    <section id="levels" className="mx-auto max-w-6xl px-4 py-20 sm:px-6 md:py-28">
      <div className="max-w-2xl">
        <div className="text-xs font-medium uppercase tracking-[0.14em] text-accent-2">The level mechanic</div>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Time in the market is your voting power</h2>
        <p className="mt-4 text-muted">
          Every purchase is a lot. A lot starts at level 0 and gains one level at each UTC midnight, up to {MAX_LEVEL}.
          Your weight is the sum of each lot times its level.
        </p>
      </div>

      <div className="mt-12 grid gap-4 md:grid-cols-2">
        <div className="rounded-3xl border border-border bg-surface p-6 sm:p-8">
          <div className="flex flex-col items-center gap-8 sm:flex-row">
            <LevelRing level={level} size={170} dayProgress={level < MAX_LEVEL ? 0.5 : undefined} />
            <div className="w-full">
              <div className="text-sm text-muted">Days held</div>
              <div className="num text-4xl font-semibold">{days}</div>
              <label htmlFor="days" className="sr-only">
                Days held
              </label>
              <input
                id="days"
                type="range"
                min={0}
                max={12}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="range mt-4 w-full"
                style={{ ["--fill" as string]: `${(days / 12) * 100}%` }}
              />
              <p className="mt-4 text-sm text-muted">
                1,000 {tickerLabel} held {days} day{days === 1 ? "" : "s"} ={" "}
                <span className="num text-fg">{(1000 * level).toLocaleString("en-US")}</span> voting weight.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-border bg-surface p-6 sm:p-8">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">Selling is LIFO</div>
              <p className="mt-1 text-sm text-muted">The newest tokens go first. Your veterans keep their level.</p>
            </div>
            <button
              type="button"
              onClick={() => setSold((s) => !s)}
              aria-pressed={sold}
              className={cx(
                "shrink-0 rounded-xl px-3 py-2 text-sm font-medium ring-1 ring-inset transition-colors",
                sold ? "bg-short/15 text-short ring-short/40" : "bg-surface-2 ring-border hover:ring-muted",
              )}
            >
              {sold ? "Undo" : "Sell 35%"}
            </button>
          </div>
          <ul className="mt-6 space-y-3">
            {LOTS.map((l, i) => {
              const after = sim.lotsAfter[i]?.amount ?? 0n;
              const keptPct = Number((after * 100n) / l.amount);
              const lvl = levelAt(l.day, DAY_NOW);
              return (
                <li key={i} className="flex items-center gap-3">
                  <LevelRing level={lvl} size={44} />
                  <div className="flex-1">
                    <div className="flex justify-between text-xs text-muted">
                      <span>Lot {i + 1} · level {lvl}</span>
                      <span className="num">{(Number((sold ? after : l.amount) / E)).toLocaleString("en-US")}</span>
                    </div>
                    <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-700"
                        style={{ width: `${((sold ? keptPct : 100) * Number(l.amount / E)) / 1000}%` }}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-6 text-sm text-muted">
            {sold ? (
              <>
                Sold 700: the two newest lots paid for it. Weight kept:{" "}
                <span className="num text-accent">{(sim.weightKeptBps / 100).toFixed(0)}%</span> of it, with 35% of the tokens gone.
              </>
            ) : (
              "Tap sell to see which lots are consumed."
            )}
          </p>
        </div>
      </div>
    </section>
  );
}
