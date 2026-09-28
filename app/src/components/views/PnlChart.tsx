"use client";

import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PnlPoint } from "@/data/types";
import { fmtDate } from "@/lib/format";

const usdShort = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v) >= 1000 ? `${(Math.abs(v) / 1000).toFixed(0)}k` : Math.abs(v).toFixed(0)}`;

/** Single series: cumulative realized PnL (step), with the high-water mark as a dashed reference. */
export function PnlChart({ data, highWaterMark }: { data: PnlPoint[]; highWaterMark?: number }) {
  if (data.length < 2) {
    return <div className="grid h-64 place-items-center text-sm text-muted">No closed position yet.</div>;
  }
  return (
    <div className="h-64 w-full" role="img" aria-label="Cumulative realized PnL over time">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="pnl-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--color-border)" strokeOpacity={0.5} vertical={false} />
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(t: number) => fmtDate(t)}
            stroke="var(--color-muted)"
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
          />
          <YAxis tickFormatter={usdShort} stroke="var(--color-muted)" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={48} />
          {highWaterMark !== undefined && (
            <ReferenceLine
              y={highWaterMark}
              stroke="var(--color-muted)"
              strokeDasharray="4 4"
              label={{ value: "High-water mark", position: "insideTopLeft", fill: "var(--color-muted)", fontSize: 11 }}
            />
          )}
          <ReferenceLine y={0} stroke="var(--color-border)" />
          <Tooltip
            cursor={{ stroke: "var(--color-muted)", strokeDasharray: "3 3" }}
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: 12,
              fontSize: 12,
              color: "var(--color-fg)",
            }}
            labelFormatter={(t) => fmtDate(Number(t))}
            formatter={(v) => [usdShort(Number(v)), "Cumulative PnL"]}
          />
          <Area type="stepAfter" dataKey="cumulativePnl" stroke="var(--color-accent)" strokeWidth={2} fill="url(#pnl-fill)" dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
