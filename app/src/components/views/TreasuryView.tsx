"use client";

import { assetMeta } from "@/config/assets";
import { explorerAddress, explorerTx } from "@/config/chains";
import { env, isDemo } from "@/config/env";
import type { TreasuryState, VaultEvent, VaultEventKind } from "@/data/types";
import { usePnlHistory, useTreasury, useVaultEvents } from "@/hooks/queries";
import { useNow } from "@/hooks/useNow";
import { fmtAgo, fmtBps, fmtDuration, fmtEth, fmtUsd, shortAddr, toNumber } from "@/lib/format";
import { sideLabel } from "@/lib/options";
import { IconAlert, IconCheck, IconExternal, IconShield } from "../icons";
import { AssetDot, SideBadge } from "../ui/AssetTag";
import { Badge, Card, CardHeader, DemoBadge, ErrorNote, Meter, PageHeader, Skeleton, Stat, cx } from "../ui/primitives";
import { PnlChart } from "./PnlChart";

export function TreasuryView() {
  const t = useTreasury();
  const d = t.data;
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <PageHeader
        eyebrow={
          <>
            <DemoBadge />
            <span>Transparency</span>
          </>
        }
        title="The treasury, in the open"
      >
        Every number below is read from the vault contract. The keeper can trade but can never withdraw, and each order
        is capped at 20% of the liquid treasury.
      </PageHeader>
      {t.error && <ErrorNote error={t.error} />}

      <Card>
        <div className="grid grid-cols-2 gap-6 lg:grid-cols-5">
          <Stat loading={!d} label="Liquid NAV" value={d && fmtUsd(d.nav)} sub="USDG + ETH at the TWAP floor" />
          <Stat loading={!d} label={`Max order (${d ? fmtBps(d.capBps, 0) : "20%"} cap)`} value={d && fmtUsd(d.maxOrder)} sub="Hard-coded ceiling" />
          <Stat
            loading={!d}
            label="Cumulative realized PnL"
            value={d && fmtUsd(d.cumulativePnl, { sign: true })}
            tone={d && d.cumulativePnl < 0n ? "short" : "long"}
            sub="Closed positions only"
          />
          <Stat loading={!d} label="High-water mark" value={d && fmtUsd(d.highWaterMark)} sub="Profit already distributed" />
          <Stat
            loading={!d}
            label="Distributable"
            value={d && (d.distributorEnabled ? fmtUsd(d.distributable) : "Off")}
            sub={d?.position ? "0 while a position is open" : "Profit above the HWM"}
          />
        </div>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.1fr_1fr]">
        {d ? <PositionCard d={d} /> : <Skeleton className="h-80" />}
        <PnlCard hwm={d ? toNumber(d.highWaterMark, 6) : undefined} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.1fr]">
        <Guarantees />
        <EventsCard />
      </div>
      <Contracts />
    </div>
  );
}

function PositionCard({ d }: { d: TreasuryState }) {
  const now = useNow();
  const p = d.position;
  if (!p) {
    return (
      <Card>
        <CardHeader title="Open position" />
        <p className="text-sm text-muted">No position is open. The next quorate decision will be executed by the keeper.</p>
        <RiskGrid d={d} />
      </Card>
    );
  }
  const m = assetMeta(p.asset);
  const upnl = p.equity !== undefined ? p.equity - p.capital : undefined;
  const upnlPct = upnl !== undefined && p.capital > 0n ? Number((upnl * 10_000n) / p.capital) / 100 : undefined;
  const tpProgress = upnlPct !== undefined ? Math.max(0, upnlPct / (d.risk.takeProfitBps / 100)) : 0;
  const closing = p.closeReportedAt > 0;
  return (
    <Card>
      <CardHeader
        title="Open position"
        hint={`Decision #${p.decisionId} · opened ${now ? fmtDuration(now - p.openedAt) + " ago" : ""}`}
        right={
          d.mustClose ? (
            <Badge tone="short"><IconAlert /> Must close</Badge>
          ) : closing ? (
            <Badge tone="warm">Closing</Badge>
          ) : (
            <Badge tone="long"><span className="size-1.5 animate-pulse-soft rounded-full bg-long" /> Running</Badge>
          )
        }
      />
      <div className="flex items-center gap-4">
        <AssetDot asset={p.asset} size={44} />
        <div>
          <div className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            {m.symbol} <SideBadge side={p.side} />
          </div>
          <div className="text-sm text-muted">
            {m.name} perp on Hyperliquid · {sideLabel(p.side)} {d.risk.leverage}×
          </div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-xs text-muted">Unrealized</div>
          <div className={cx("num text-xl font-semibold", upnl === undefined ? "text-muted" : upnl >= 0n ? "text-long" : "text-short")}>
            {upnl === undefined ? "—" : `${upnlPct! >= 0 ? "+" : ""}${upnlPct!.toFixed(2)}%`}
          </div>
          <div className="num text-xs text-muted">{upnl === undefined ? "No matured report" : fmtUsd(upnl, { sign: true })}</div>
        </div>
      </div>
      <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Item label="Capital" value={fmtUsd(p.capital)} />
        <Item label="Notional" value={fmtUsd(p.capital * BigInt(d.risk.leverage))} />
        <Item label="Reported equity" value={p.equity !== undefined ? fmtUsd(p.equity) : "—"} />
      </dl>
      <div className="mt-6">
        <div className="flex justify-between text-xs text-muted">
          <span>Progress to take-profit ({fmtBps(d.risk.takeProfitBps, 0)})</span>
          <span className="num">{Math.min(100, tpProgress * 100).toFixed(0)}%</span>
        </div>
        <Meter className="mt-2" value={tpProgress} tone="long" />
        <p className="mt-2 text-xs text-muted">
          {d.closeVoteAllowed ? "Threshold reached: anyone can open a close vote." : "Past the threshold, holders can vote to close and lock the gain."}
        </p>
      </div>
      <RiskGrid d={d} />
      {d.mustClose && (
        <p className="mt-4 rounded-xl bg-short/10 p-3 text-xs text-short">
          The keeper must close this position and bring the funds back: governance voted to close, a newer decision
          superseded it, or the guardian paused the vault.
        </p>
      )}
    </Card>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="num mt-1 font-semibold">{value}</dd>
    </div>
  );
}

function RiskGrid({ d }: { d: TreasuryState }) {
  return (
    <dl className="mt-6 grid grid-cols-3 gap-2 rounded-xl border border-border bg-bg/40 p-3 text-center">
      <div>
        <dt className="text-[11px] text-muted">Leverage</dt>
        <dd className="num font-semibold">{d.risk.leverage}×</dd>
      </div>
      <div>
        <dt className="text-[11px] text-muted">Stop-loss</dt>
        <dd className="num font-semibold text-short">{fmtBps(d.risk.stopLossBps, 0)}</dd>
      </div>
      <div>
        <dt className="text-[11px] text-muted">Take-profit</dt>
        <dd className="num font-semibold text-long">{fmtBps(d.risk.takeProfitBps, 0)}</dd>
      </div>
    </dl>
  );
}

function PnlCard({ hwm }: { hwm?: number }) {
  const h = usePnlHistory();
  return (
    <Card>
      <CardHeader title="Cumulative realized PnL" hint="Steps at each closed position. Only profit above the high-water mark can ever be distributed." />
      {h.error ? <ErrorNote error={h.error} /> : h.data ? <PnlChart data={h.data} highWaterMark={hwm} /> : <Skeleton className="h-64" />}
    </Card>
  );
}

function Guarantees() {
  const items = [
    ["Keeper cannot withdraw", "Its Hyperliquid agent key can trade, never move funds out. Returns are signed by a multisig."],
    ["20% hard cap per trade", "Checked on-chain against the liquid NAV; a deployment above 20% is impossible."],
    ["One decision, one order", "Each quorate decision can be executed once. Stopped out means waiting for a new vote."],
    ["Fail-closed conversions", "ETH is sold for USDG only near a 30 min TWAP, with a circuit breaker on the 6 h TWAP."],
    ["Guardian can block, not choose", "It can pause and revoke, but never pick a trade or touch funds."],
  ] as const;
  return (
    <Card>
      <CardHeader icon={<IconShield />} title="What the contracts guarantee" />
      <ul className="space-y-4">
        {items.map(([t, s]) => (
          <li key={t} className="flex gap-3">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent/15 text-xs text-accent">
              <IconCheck />
            </span>
            <div>
              <div className="text-sm font-medium">{t}</div>
              <div className="text-xs leading-relaxed text-muted">{s}</div>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-5 text-xs leading-relaxed text-muted">
        What they cannot guarantee: the stop-loss lives on Hyperliquid (placed by the keeper, watched by an independent
        monitor), and a compromised agent could still trade badly within the cap.
      </p>
    </Card>
  );
}

const KIND_TONE: Record<VaultEventKind, string> = {
  fee: "bg-accent-2",
  conversion: "bg-accent",
  order: "bg-long",
  report: "bg-muted",
  closeReported: "bg-warm",
  closed: "bg-warm",
  lateReturn: "bg-warm",
  distributed: "bg-accent",
  paused: "bg-short",
};

function EventsCard() {
  const ev = useVaultEvents();
  const now = useNow();
  return (
    <Card>
      <CardHeader title="Recent vault activity" hint="Fees, conversions, orders, reports and closes." />
      {ev.error && <ErrorNote error={ev.error} />}
      {!ev.data && !ev.error && <Skeleton className="h-72" />}
      {ev.data && ev.data.length === 0 && <p className="text-sm text-muted">No activity yet.</p>}
      <ol className="relative max-h-[420px] space-y-1 overflow-y-auto pr-1">
        {ev.data?.slice(0, 30).map((e) => <EventRow key={e.id} e={e} now={now} />)}
      </ol>
    </Card>
  );
}

function EventRow({ e, now }: { e: VaultEvent; now: number }) {
  const link = !isDemo && e.txHash ? explorerTx(env.chainId, e.txHash) : undefined;
  return (
    <li className="flex items-start gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2/60">
      <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", KIND_TONE[e.kind])} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{e.title}</span>
          <span className="shrink-0 text-[11px] text-muted">{now ? fmtAgo(e.timestamp, now) : ""}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-muted">{e.detail}</span>
          {e.pnl !== undefined && (
            <span className={cx("num shrink-0 text-xs font-semibold", e.pnl >= 0n ? "text-long" : "text-short")}>{fmtUsd(e.pnl, { sign: true })}</span>
          )}
          {link && (
            <a href={link} target="_blank" rel="noreferrer" className="shrink-0 text-muted hover:text-fg" aria-label="View on explorer">
              <IconExternal />
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

function Contracts() {
  const rows = [
    ["Vault", env.vault],
    ["Governance", env.governance],
    ["Token", env.token],
    ["Distributor", env.distributor],
  ] as const;
  const t = useTreasury();
  return (
    <section className="mt-12">
      <h2 className="mb-4 text-lg font-semibold tracking-tight">Contracts</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map(([name, a]) => (
          <div key={name} className="rounded-xl border border-border bg-surface/60 p-4">
            <div className="text-xs text-muted">{name}</div>
            {a ? (
              <a className="num mt-1 inline-flex items-center gap-1 text-sm hover:text-accent" href={explorerAddress(env.chainId, a)} target="_blank" rel="noreferrer">
                {shortAddr(a)} <IconExternal />
              </a>
            ) : (
              <div className="mt-1 text-sm text-muted">{isDemo ? "Not deployed yet" : "Not configured"}</div>
            )}
          </div>
        ))}
      </div>
      {t.data?.feesEth !== undefined && (
        <p className="mt-4 text-xs text-muted">Swap fees collected since launch: <span className="num text-fg">{fmtEth(t.data.feesEth)}</span></p>
      )}
    </section>
  );
}
