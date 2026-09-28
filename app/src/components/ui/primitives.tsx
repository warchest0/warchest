import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { isDemo } from "@/config/env";
import { IconAlert } from "../icons";

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

export function Card({ className, children, ...p }: ComponentProps<"section">) {
  return (
    <section
      className={cx(
        "rounded-2xl border border-border bg-surface/80 p-5 shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset] backdrop-blur-sm sm:p-6",
        className,
      )}
      {...p}
    >
      {children}
    </section>
  );
}

export function CardHeader({ title, hint, right, icon }: { title: ReactNode; hint?: ReactNode; right?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
          {icon && <span className="text-muted">{icon}</span>}
          {title}
        </h2>
        {hint && <p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

type Tone = "accent" | "long" | "short" | "warm" | "muted" | "violet";
const toneCls: Record<Tone, string> = {
  accent: "bg-accent/12 text-accent ring-accent/25",
  long: "bg-long/12 text-long ring-long/25",
  short: "bg-short/12 text-short ring-short/25",
  warm: "bg-warm/12 text-warm ring-warm/25",
  muted: "bg-surface-2 text-muted ring-border",
  violet: "bg-accent-2/12 text-accent-2 ring-accent-2/25",
};

export function Badge({ tone = "muted", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", toneCls[tone], className)}>
      {children}
    </span>
  );
}

type Variant = "primary" | "secondary" | "ghost";
const btn: Record<Variant, string> = {
  primary:
    "bg-accent text-bg hover:brightness-110 active:brightness-95 shadow-[0_0_0_1px_rgba(255,255,255,0.08)_inset,0_8px_24px_-8px_var(--color-accent)]",
  secondary: "bg-surface-2 text-fg ring-1 ring-inset ring-border hover:bg-border/60",
  ghost: "text-muted hover:text-fg hover:bg-surface-2",
};
const btnBase =
  "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50";

export function Button({ variant = "primary", className, ...p }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button type="button" className={cx(btnBase, btn[variant], className)} {...p} />;
}

export function ButtonLink({ variant = "primary", className, ...p }: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={cx(btnBase, btn[variant], className)} {...p} />;
}

export function Stat({
  label,
  value,
  sub,
  tone,
  loading,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "long" | "short" | "accent";
  loading?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      {loading ? (
        <div className="skeleton mt-2 h-7 w-28 rounded-md" />
      ) : (
        <div
          className={cx(
            "num mt-1 truncate text-2xl font-semibold tracking-tight",
            tone === "long" && "text-long",
            tone === "short" && "text-short",
            tone === "accent" && "text-accent",
          )}
        >
          {value}
        </div>
      )}
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton rounded-md", className)} />;
}

export function DemoBadge({ className }: { className?: string }) {
  if (!isDemo) return null;
  return (
    <span
      title="Contracts are not deployed yet: every number on this screen is simulated."
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full bg-warm/12 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-warm ring-1 ring-inset ring-warm/30",
        className,
      )}
    >
      <span className="size-1.5 animate-pulse-soft rounded-full bg-warm" />
      Demo data
    </span>
  );
}

export function PageHeader({ eyebrow, title, children, right }: { eyebrow?: ReactNode; title: ReactNode; children?: ReactNode; right?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        {eyebrow && <div className="mb-3 flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted">{eyebrow}</div>}
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
        {children && <p className="mt-3 text-sm leading-relaxed text-muted sm:text-base">{children}</p>}
      </div>
      {right}
    </header>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl border border-short/30 bg-short/8 p-3 text-sm text-short">
      <IconAlert className="mt-0.5 shrink-0" />
      <span className="break-words">{msg}</span>
    </div>
  );
}

export function Meter({ value, className, tone = "accent", marker }: { value: number; className?: string; tone?: "accent" | "long" | "short" | "warm"; marker?: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const bg = { accent: "bg-accent", long: "bg-long", short: "bg-short", warm: "bg-warm" }[tone];
  return (
    <div className={cx("relative h-2 overflow-hidden rounded-full bg-surface-2", className)}>
      <div className={cx("h-full rounded-full transition-[width] duration-700 ease-out", bg)} style={{ width: `${pct}%` }} />
      {marker !== undefined && <div className="absolute inset-y-0 w-0.5 bg-fg/70" style={{ left: `${Math.min(100, marker * 100)}%` }} />}
    </div>
  );
}
