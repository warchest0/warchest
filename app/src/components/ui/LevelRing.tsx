"use client";

import { useId } from "react";
import { MAX_LEVEL } from "@/lib/levels";

/**
 * Activity-ring style level gauge. The outer ring fills level / 10; the thin inner ring shows today's progress
 * towards the next level (every lot gains a level at UTC midnight).
 */
export function LevelRing({
  level,
  dayProgress,
  size = 160,
  stroke,
  label = "Level",
  decimals = 0,
  className,
}: {
  level: number;
  dayProgress?: number;
  size?: number;
  stroke?: number;
  label?: string;
  decimals?: number;
  className?: string;
}) {
  const id = useId().replace(/:/g, "");
  const sw = stroke ?? Math.max(6, Math.round(size / 11));
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, level / MAX_LEVEL));
  const maxed = level >= MAX_LEVEL;
  const inner = dayProgress !== undefined && !maxed;
  const r2 = r - sw - 3;
  const c2 = 2 * Math.PI * r2;
  const big = size >= 120;

  return (
    <div className={className} style={{ width: size, height: size, position: "relative" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} ${level.toFixed(decimals)} of ${MAX_LEVEL}`}>
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" />
            <stop offset="100%" stopColor="var(--color-accent-2)" />
          </linearGradient>
          <filter id={`f${id}`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation={sw / 2.5} />
          </filter>
        </defs>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-surface-2)" strokeWidth={sw} />
          {frac > 0 && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={`url(#g${id})`}
              strokeWidth={sw}
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - frac)}
              opacity={0.35}
              filter={`url(#f${id})`}
            />
          )}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={`url(#g${id})`}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - frac)}
            style={{ transition: "stroke-dashoffset 900ms cubic-bezier(.2,.7,.2,1)" }}
          />
          {inner && (
            <>
              <circle cx={size / 2} cy={size / 2} r={r2} fill="none" stroke="var(--color-surface-2)" strokeWidth={Math.max(2, sw / 3)} />
              <circle
                cx={size / 2}
                cy={size / 2}
                r={r2}
                fill="none"
                stroke="var(--color-warm)"
                strokeWidth={Math.max(2, sw / 3)}
                strokeLinecap="round"
                strokeDasharray={c2}
                strokeDashoffset={c2 * (1 - Math.max(0.01, dayProgress))}
                style={{ transition: "stroke-dashoffset 900ms ease" }}
              />
            </>
          )}
        </g>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {big && <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted">{label}</span>}
        <span className="num font-semibold leading-none" style={{ fontSize: size * (big ? 0.27 : 0.32) }}>
          {level.toFixed(decimals)}
        </span>
        {big && <span className="mt-1 text-[11px] text-muted">{maxed ? "Max level" : `of ${MAX_LEVEL}`}</span>}
      </div>
    </div>
  );
}
