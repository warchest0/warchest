"use client";

import { useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import { tickerLabel } from "@/config/brand";
import { IconChart, IconCoins, IconShield, IconVault, IconVote } from "../icons";
import { cx } from "../ui/primitives";

const STEPS: { title: string; body: string; stat: string; statLabel: string; icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  {
    title: "Every trade pays a 10% fee",
    body: `Buys and sells of ${tickerLabel} pay 10% in ETH, collected by a Uniswap v4 hook at swap time. Plain wallet transfers pay nothing.`,
    stat: "10%",
    statLabel: "of every swap, in ETH",
    icon: IconCoins,
  },
  {
    title: "Fees fill a shared treasury",
    body: "The fee lands in a vault with no owner and no withdraw function. ETH is converted to USDG near the 30-minute TWAP, never below it.",
    stat: "0",
    statLabel: "admin withdraw functions",
    icon: IconVault,
  },
  {
    title: "Holders vote on the trade",
    body: "In 24-hour rounds, holders vote on an asset and a direction, for example long ETH or short BTC. Votes are weighted by tokens × level.",
    stat: "×10",
    statLabel: "max weight per token",
    icon: IconVote,
  },
  {
    title: "The treasury trades on Hyperliquid",
    body: "A keeper opens the winning position with at most 20% of the treasury, fixed leverage and a stop-loss. Its key can trade, never withdraw.",
    stat: "20%",
    statLabel: "hard cap per trade",
    icon: IconChart,
  },
  {
    title: "Profit above the high-water mark",
    body: "Realized profit is tracked on-chain. Only gains above the previous peak can be distributed, and only if distribution is switched on.",
    stat: "HWM",
    statLabel: "losses are recovered first",
    icon: IconShield,
  },
];

/** Scrollytelling-lite: the sticky panel follows the step currently in view. */
export function HowItWorks() {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.step));
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  const s = STEPS[active]!;
  const Icon = s.icon;
  return (
    <section id="how" className="mx-auto max-w-6xl px-4 py-20 sm:px-6 md:py-28">
      <div className="max-w-2xl">
        <div className="text-xs font-medium uppercase tracking-[0.14em] text-accent">How it works</div>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">From a swap fee to a shared trade</h2>
      </div>
      <div className="mt-12 grid gap-10 md:grid-cols-[1fr_1fr]">
        <ol className="space-y-4 md:space-y-40 md:py-24">
          {STEPS.map((st, i) => (
            <li
              key={st.title}
              data-step={i}
              ref={(el) => {
                refs.current[i] = el;
              }}
              className={cx(
                "rounded-2xl border p-6 transition-all duration-500",
                active === i ? "border-accent/40 bg-surface" : "border-border bg-surface/40 md:opacity-50",
              )}
            >
              <div className="num text-xs text-muted">0{i + 1}</div>
              <h3 className="mt-2 text-lg font-semibold">{st.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{st.body}</p>
            </li>
          ))}
        </ol>
        <div className="hidden md:block">
          <div className="sticky top-28 rounded-3xl border border-border bg-surface p-8">
            <div className="flex items-center justify-between">
              {STEPS.map((st, i) => {
                const I = st.icon;
                return (
                  <div key={st.title} className="flex flex-1 items-center last:flex-none">
                    <span
                      className={cx(
                        "grid size-10 place-items-center rounded-full text-lg ring-1 transition-all duration-500",
                        i <= active ? "bg-accent/15 text-accent ring-accent/40" : "bg-surface-2 text-muted ring-border",
                        i === active && "scale-110 shadow-[0_0_24px_-4px_var(--color-accent)]",
                      )}
                    >
                      <I />
                    </span>
                    {i < STEPS.length - 1 && (
                      <span className="mx-1 h-px flex-1 bg-border">
                        <span className="block h-full bg-accent transition-all duration-500" style={{ width: i < active ? "100%" : "0%" }} />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div key={active} className="mt-12 animate-fade-up">
              <Icon className="text-3xl text-accent-2" />
              <div className="num mt-6 text-7xl font-semibold tracking-tight">
                <span className="text-gradient">{s.stat}</span>
              </div>
              <div className="mt-2 text-sm text-muted">{s.statLabel}</div>
              <div className="mt-10 text-lg font-medium">{s.title}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
