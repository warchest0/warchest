"use client";

import { forwardRef, useRef, useState } from "react";
import { brand, tickerLabel } from "@/config/brand";
import { shortAddr } from "@/lib/format";
import { MAX_LEVEL } from "@/lib/levels";
import { IconDownload, IconShare } from "../icons";
import { Button } from "../ui/primitives";

export interface RankCardData {
  address: string;
  rank: number;
  holders: number;
  weight: string;
  share: number;
  level?: number;
  streak?: number;
}

const W = 1200;
const H = 630;
const c = brand.colors;
const FONT = "Geist, Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
const MONO = "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace";

/**
 * Share card as a self-contained 1200×630 SVG (Open Graph size). Colors are literal values from `brand.ts` (not
 * CSS variables) so the exported PNG looks the same outside the page.
 */
export const RankCardSvg = forwardRef<SVGSVGElement, { d: RankCardData }>(function RankCardSvg({ d }, ref) {
  const r = 150;
  const sw = 26;
  const circ = 2 * Math.PI * r;
  const frac = d.level !== undefined ? Math.min(1, d.level / MAX_LEVEL) : Math.min(1, d.share * 10);
  const top = Math.max(0.01, (d.rank / Math.max(1, d.holders)) * 100);
  return (
    <svg ref={ref} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Rank card: rank ${d.rank} of ${d.holders}`}>
      <defs>
        <linearGradient id="rc-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={c.accent} />
          <stop offset="1" stopColor={c.accent2} />
        </linearGradient>
        <radialGradient id="rc-glow1" cx="0.1" cy="0" r="0.8">
          <stop offset="0" stopColor={c.accent} stopOpacity="0.22" />
          <stop offset="1" stopColor={c.accent} stopOpacity="0" />
        </radialGradient>
        <radialGradient id="rc-glow2" cx="1" cy="0.1" r="0.7">
          <stop offset="0" stopColor={c.accent2} stopOpacity="0.25" />
          <stop offset="1" stopColor={c.accent2} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width={W} height={H} rx="36" fill={c.bg} />
      <rect width={W} height={H} rx="36" fill="url(#rc-glow1)" />
      <rect width={W} height={H} rx="36" fill="url(#rc-glow2)" />
      <rect x="1" y="1" width={W - 2} height={H - 2} rx="35" fill="none" stroke={c.border} strokeWidth="2" />

      <g transform="translate(72 78)">
        <rect width="44" height="44" rx="13" fill="url(#rc-ring)" />
        <rect x="11" y="24" width="6" height="10" rx="3" fill={c.bg} />
        <rect x="19" y="17.5" width="6" height="16.5" rx="3" fill={c.bg} />
        <rect x="27" y="11" width="6" height="23" rx="3" fill={c.bg} />
        <text x="62" y="31" fill={c.text} fontFamily={FONT} fontSize="28" fontWeight="600">
          {brand.name}
        </text>
      </g>
      <text x="72" y="228" fill={c.muted} fontFamily={FONT} fontSize="26" letterSpacing="4">
        HOLDER RANK
      </text>
      <text x="66" y="365" fill={c.text} fontFamily={MONO} fontSize="150" fontWeight="600" letterSpacing="-6">
        #{d.rank}
      </text>
      <text x="72" y="420" fill={c.muted} fontFamily={FONT} fontSize="28">
        of {d.holders.toLocaleString("en-US")} holders · top {top < 1 ? top.toFixed(1) : top.toFixed(0)}%
      </text>

      <g fontFamily={FONT}>
        <text x="72" y="515" fill={c.muted} fontSize="22">Voting weight</text>
        <text x="72" y="556" fill={c.text} fontFamily={MONO} fontSize="36" fontWeight="600">{d.weight}</text>
        <text x="352" y="515" fill={c.muted} fontSize="22">Share</text>
        <text x="352" y="556" fill={c.text} fontFamily={MONO} fontSize="36" fontWeight="600">{(d.share * 100).toFixed(2)}%</text>
        {d.streak !== undefined && (
          <>
            <text x="562" y="515" fill={c.muted} fontSize="22">Streak</text>
            <text x="562" y="556" fill={c.warm} fontFamily={MONO} fontSize="36" fontWeight="600">{d.streak}d</text>
          </>
        )}
      </g>

      <g transform="translate(930 300)">
        <circle r={r} fill="none" stroke={c.surface2} strokeWidth={sw} />
        <circle
          r={r}
          fill="none"
          stroke="url(#rc-ring)"
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - frac)}
          transform="rotate(-90)"
        />
        <text y="-34" textAnchor="middle" fill={c.muted} fontFamily={FONT} fontSize="20" letterSpacing="3">
          {d.level !== undefined ? "AVG LEVEL" : "TOP"}
        </text>
        <text y="42" textAnchor="middle" fill={c.text} fontFamily={MONO} fontSize="84" fontWeight="600">
          {d.level !== undefined ? d.level.toFixed(1) : `${top < 1 ? top.toFixed(1) : top.toFixed(0)}%`}
        </text>
        <text y="84" textAnchor="middle" fill={c.muted} fontFamily={FONT} fontSize="20">
          {d.level !== undefined ? `of ${MAX_LEVEL}` : "of holders"}
        </text>
      </g>
      <text x={W - 72} y={H - 48} textAnchor="end" fill={c.muted} fontFamily={MONO} fontSize="22">
        {shortAddr(d.address)} · {tickerLabel}
      </text>
    </svg>
  );
});

async function svgToPng(svg: SVGSVGElement): Promise<Blob> {
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    img.width = W;
    img.height = H;
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("could not render the card"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = W * 2;
    canvas.height = H * 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0, W, H);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("export failed"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function RankCard({ d }: { d: RankCardData }) {
  const ref = useRef<SVGSVGElement>(null);
  const [status, setStatus] = useState<string>();
  const text = `I'm #${d.rank} of ${d.holders} ${tickerLabel} holders${d.level !== undefined ? `, avg level ${d.level.toFixed(1)}/${MAX_LEVEL}` : ""}. Hold longer, vote heavier.`;

  async function download() {
    if (!ref.current) return;
    try {
      const blob = await svgToPng(ref.current);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${brand.name.toLowerCase()}-rank-${d.rank}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setStatus("Saved");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Export failed");
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied to clipboard");
    } catch {
      setStatus("Copy failed");
    }
  }

  return (
    <div>
      <div className="overflow-hidden rounded-2xl shadow-[0_30px_80px_-30px_rgba(0,0,0,0.8)]">
        <RankCardSvg ref={ref} d={d} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={download}>
          <IconDownload /> Download PNG
        </Button>
        <Button variant="secondary" onClick={copy}>
          <IconShare /> Copy share text
        </Button>
        <a
          className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
          href={`https://x.com/intent/post?text=${encodeURIComponent(text)}`}
          target="_blank"
          rel="noreferrer"
        >
          Post on X
        </a>
        {status && <span className="text-xs text-muted" role="status">{status}</span>}
      </div>
    </div>
  );
}
