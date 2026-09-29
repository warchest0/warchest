"use client";

import type { ReactNode } from "react";
import { cx } from "./primitives";

/** Live, selectable result bar (prediction-market style): share of the votes cast so far. */
export function VoteBar({
  label,
  sub,
  share,
  weightLabel,
  tone,
  leader,
  selected,
  disabled,
  onSelect,
}: {
  label: ReactNode;
  sub?: ReactNode;
  share: number;
  weightLabel: string;
  tone: "long" | "short" | "accent" | "muted";
  leader?: boolean;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}) {
  const pct = Math.max(0, Math.min(1, share)) * 100;
  const fill = {
    long: "bg-long/22",
    short: "bg-short/22",
    accent: "bg-accent/22",
    muted: "bg-muted/15",
  }[tone];
  const text = { long: "text-long", short: "text-short", accent: "text-accent", muted: "text-muted" }[tone];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={!!selected}
      disabled={disabled}
      onClick={onSelect}
      className={cx(
        "group relative w-full overflow-hidden rounded-xl border text-left transition-all duration-200",
        selected ? "border-accent bg-surface-2 shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_18%,transparent)]" : "border-border bg-surface hover:border-muted/50",
        disabled && !selected && "cursor-default hover:border-border",
      )}
    >
      <div className={cx("absolute inset-y-0 left-0 transition-[width] duration-700 ease-out", fill)} style={{ width: `${pct}%` }} />
      <div className="relative flex items-center gap-3 px-4 py-3.5">
        <span
          aria-hidden="true"
          className={cx(
            "grid size-5 shrink-0 place-items-center rounded-full border-2 transition-colors",
            selected ? "border-accent bg-accent" : "border-border group-hover:border-muted",
          )}
        >
          {selected && <span className="size-1.5 rounded-full bg-bg" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            {label}
            {leader && <span className="rounded-full bg-fg/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg/80">Leading</span>}
          </div>
          {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
        </div>
        <div className="text-right">
          <div className={cx("num text-lg font-semibold", text)}>{pct.toFixed(1)}%</div>
          <div className="num text-[11px] text-muted">{weightLabel}</div>
        </div>
      </div>
    </button>
  );
}
