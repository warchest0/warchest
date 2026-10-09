// Terminal-native teasers: a tmux-like frame, typed commands, live logs, and the grid wordmark drawn stroke by stroke.
import React from "react";
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

const mono = loadMono("normal", { weights: ["400", "700"] }).fontFamily;
export const TFPS = 30;
const BG = "#0a0b0d", LINE = "#23262d", FG = "#e3e7ee", DIM = "#6b7280", AMBER = "#ffb43a", RED = "#ff5a4e", GRIDDOT = "#22262d";

const useWH = () => { const { width, height } = useVideoConfig(); return { W: width, H: height }; };
const clamp = (v: number) => Math.max(0, Math.min(1, v));

// ---------- grid wordmark (same glyphs as logos-v3) ----------
const G: Record<string, number[][][]> = {
  w: [[[0, 3], [0, 9], [5, 9], [5, 3]], [[2.5, 3], [2.5, 9]]],
  a: [[[0, 3], [5, 3], [5, 9], [0, 9], [0, 5.8], [5, 5.8]]],
  r: [[[0, 9], [0, 3], [4.2, 3]]],
  c: [[[5, 3], [0, 3], [0, 9], [5, 9]]],
  h: [[[0, 0], [0, 9]], [[0, 3], [5, 3], [5, 9]]],
  e: [[[5, 9], [0, 9], [0, 3], [5, 3], [5, 6], [0, 6]]],
  s: [[[5, 3], [0, 3], [0, 6], [5, 6], [5, 9], [0, 9]]],
  t: [[[1.6, 0], [1.6, 9], [4.6, 9]], [[0, 3], [4.6, 3]]],
};
const ADV: Record<string, number> = { r: 6.4, t: 6.8 };
function Wordmark({ f, width, color = FG }: { f: number; width: number; color?: string }) {
  // Each letter draws over 6 frames, staggered by 2; then the cursor blinks.
  let x = 0; const strokes: React.ReactNode[] = [];
  [..."warchest"].forEach((ch, i) => {
    const p = clamp((f - i * 2) / 6);
    G[ch].forEach((pl, j) => strokes.push(<polyline key={`${i}-${j}`} points={pl.map(([px, py]) => `${x + px},${py}`).join(" ")} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - p} fill="none" stroke={color} strokeWidth={0.5} strokeLinecap="square" />));
    x += ADV[ch] ?? 7.2;
  });
  const cursorOn = f > 20 && Math.floor(f / 8) % 2 === 0;
  const w = x + 3.4;
  return <svg viewBox={`-0.5 -0.5 ${w} 10`} width={width} height={(width * 10) / w}>{strokes}{f > 18 && <rect x={x + 0.2} y={3} width={3} height={6.25} fill={AMBER} opacity={cursorOn || f < 22 ? 1 : 0} />}</svg>;
}

// ---------- frame ----------
function Frame({ tab, children, status }: { tab: number; children: React.ReactNode; status: string }) {
  const f = useCurrentFrame(); const { W } = useWH();
  const s = W * 0.022, bar = W * 0.052;
  const tabs = ["0:chest", "1:ranks", "2:siege"];
  return <AbsoluteFill style={{ background: BG, fontFamily: mono, color: FG }}>
    <div style={{ height: bar, display: "flex", borderBottom: `1px solid ${LINE}`, fontSize: s }}>
      {tabs.map((t, i) => <div key={t} style={{ padding: `0 ${W * 0.022}px`, display: "flex", alignItems: "center", borderRight: `1px solid ${LINE}`, background: i === tab ? AMBER : undefined, color: i === tab ? BG : "#9aa3af", fontWeight: i === tab ? 700 : 400 }}>{t}{i === tab ? "*" : ""}</div>)}
      <div style={{ marginLeft: "auto", padding: `0 ${W * 0.022}px`, display: "flex", alignItems: "center", background: FG, color: BG, fontWeight: 700 }}>$WAR</div>
    </div>
    <div style={{ position: "absolute", left: 0, right: 0, top: bar, bottom: bar, overflow: "hidden" }}>{children}</div>
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: bar, borderTop: `1px solid ${LINE}`, display: "flex", alignItems: "center", fontSize: s * 0.9, color: DIM }}>
      <div style={{ background: FG, color: BG, height: "100%", display: "flex", alignItems: "center", padding: `0 ${W * 0.02}px`, fontWeight: 700 }}>warchest</div>
      <div style={{ marginLeft: "auto", paddingRight: W * 0.022 }}><span style={{ color: Math.floor(f / 15) % 2 ? AMBER : DIM }}>●</span> {status} · 00:{String(Math.floor(f / TFPS)).padStart(2, "0")}:{String(f % TFPS).padStart(2, "0")}</div>
    </div>
    {/* faint scanlines */}
    <AbsoluteFill style={{ background: "repeating-linear-gradient(0deg, rgba(255,255,255,.018) 0 1px, transparent 1px 3px)", pointerEvents: "none" }} />
  </AbsoluteFill>;
}

// Typed text: reveals `speed` characters per frame from `start`.
const typed = (text: string, f: number, start: number, speed = 1.4) => text.slice(0, Math.max(0, Math.floor((f - start) * speed)));
const Cursor = ({ f }: { f: number }) => <span style={{ background: Math.floor(f / 8) % 2 ? "transparent" : AMBER, color: "transparent" }}>_</span>;

type L = { t: number; node: React.ReactNode };
// Lines appear at their frame and the block scrolls so the newest line stays in view.
function Log({ lines, f, size, max }: { lines: L[]; f: number; size: number; max: number }) {
  const shown = lines.filter((l) => f >= l.t);
  return <div style={{ fontSize: size, lineHeight: 1.75, whiteSpace: "pre" }}>{shown.slice(-max).map((l, i) => <div key={i}>{l.node}</div>)}</div>;
}
const S = ({ c, children }: { c: string; children: React.ReactNode }) => <span style={{ color: c }}>{children}</span>;

// End segment: dot grid, wordmark draws in, tagline types, launch tag.
function End({ f, tagline = "hold longer. rank higher." }: { f: number; tagline?: string }) {
  const { W } = useWH();
  return <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
    <AbsoluteFill style={{ backgroundImage: `radial-gradient(${GRIDDOT} ${W * 0.0022}px, transparent ${W * 0.0026}px)`, backgroundSize: `${W * 0.04}px ${W * 0.04}px`, opacity: clamp(f / 6) }} />
    <Wordmark f={f} width={W * 0.8} />
    <div style={{ marginTop: W * 0.06, fontSize: W * 0.036, width: W * 0.8, color: FG }}><S c={DIM}>❯ </S>{typed(tagline, f, 22, 1.2)}{f > 22 && f < 22 + tagline.length / 1.2 + 4 ? <Cursor f={f} /> : null}</div>
    <div style={{ marginTop: W * 0.03, fontSize: W * 0.026, width: W * 0.8, color: DIM, opacity: f > 52 ? 1 : 0 }}># $WAR · <S c={AMBER}>launching soon</S></div>
  </AbsoluteFill>;
}

// ---------- 09 · boot ----------
const addr = (k: string) => `0x${Math.floor(random(k) * 0xfff).toString(16).padStart(3, "0")}…${Math.floor(random(k + "b") * 0xfff).toString(16).padStart(3, "0")}`;
const RANKS = ["recruit", "soldier", "corporal", "sergeant", "lieutenant", "captain", "commander", "colonel", "general", "marshal", "warlord"];
const ts = (i: number) => `00:15:${String(10 + (i % 50)).padStart(2, "0")}`;
function liveLines(from: number, n: number, every: number, seed: string): L[] {
  return Array.from({ length: n }, (_, i) => {
    const r = random(seed + i), t = from + Math.floor(i * every);
    if (r < 0.55) { const k = 1 + Math.floor(random(seed + "k" + i) * 10); return { t, node: <><S c={DIM}>{ts(i)} </S>{addr(seed + i)} <S c={DIM}>rank {k - 1} → {k}</S> <S c={AMBER}>{RANKS[k]}</S></> }; }
    if (r < 0.85) return { t, node: <><S c={DIM}>{ts(i)} </S>chest <S c={DIM}>fee in</S> +{(random(seed + "e" + i) * 0.9 + 0.05).toFixed(2)} eth</> };
    return { t, node: <><S c={DIM}>{ts(i)} </S>{addr(seed + i)} <S c={DIM}>sold {10 + Math.floor(random(seed + "s" + i) * 50)}%</S> <S c={RED}>rank reset on sold part</S></> };
  });
}
export const BOOT_D = 285;
export function Boot() {
  const f = useCurrentFrame(); const { W, H } = useWH();
  const size = W * 0.028, pad = W * 0.05;
  const cmd = "chest status --live";
  const boot: L[] = [
    { t: 30, node: <><S c={AMBER}>[ ok ]</S> hook    <S c={DIM}>10% of every trade → the chest</S></> },
    { t: 36, node: <><S c={AMBER}>[ ok ]</S> ranks   <S c={DIM}>one per day held, 0 → 10</S></> },
    { t: 42, node: <><S c={AMBER}>[ ok ]</S> siege   <S c={DIM}>armed at −30% from ATH</S></> },
    { t: 48, node: <><S c={AMBER}>[ ok ]</S> burn    <S c={DIM}>buybacks are burned</S></> },
    { t: 56, node: <><S c={FG}>[ .. ]</S> launch  <S c={AMBER}>soon</S></> },
    { t: 66, node: " " },
    { t: 68, node: <><S c={DIM}>❯ </S>tail -f chest.log</> },
    ...liveLines(74, 60, 1.6, "boot"),
  ];
  const maxLines = Math.floor((H - W * 0.104 - pad * 2) / (size * 1.75)) - 2;
  if (f >= 180) return <Frame tab={0} status="live"><End f={f - 180} /></Frame>;
  // A 3-frame glitch before the wordmark.
  const glitch = f >= 175;
  return <Frame tab={0} status={f < 66 ? "booting" : "live"}>
    <div style={{ padding: pad, transform: glitch ? `translateX(${(random(`g${f}`) - 0.5) * 40}px)` : undefined, opacity: glitch ? 0.6 : 1 }}>
      <div style={{ fontSize: size, lineHeight: 1.75 }}><S c={DIM}>~/warchest ❯ </S>{typed(cmd, f, 4, 0.9)}{f < 30 && <Cursor f={f} />}</div>
      <Log lines={boot} f={f} size={size} max={maxLines} />
      {f > 100 && <div style={{ marginTop: size, fontSize: size, color: DIM, borderTop: `1px solid ${LINE}`, paddingTop: size * 0.8, lineHeight: 1.75 }}>
        <div>ranks [<S c={AMBER}>{"|".repeat(Math.min(24, Math.floor((f - 100) / 3)))}</S><S c={LINE}>{"|".repeat(Math.max(0, 24 - Math.floor((f - 100) / 3)))}</S>]</div>
        <div>chest [<S c={FG}>{"|".repeat(Math.min(24, Math.floor((f - 100) / 2.5)))}</S><S c={LINE}>{"|".repeat(Math.max(0, 24 - Math.floor((f - 100) / 2.5)))}</S>] {((f - 100) * 0.53).toFixed(1)} eth</div>
        <div style={{ fontSize: size * 0.7 }}>illustration · not live data</div></div>}
    </div>
  </Frame>;
}

// ---------- 10 · siege.log ----------
export const SIEGE_T_D = 270;
export function SiegeLog() {
  const f = useCurrentFrame(); const { W, H } = useWH();
  const size = W * 0.036, pad = W * 0.055;
  if (f >= 165) return <Frame tab={2} status="siege"><End f={f - 165} tagline="the chest fights back." /></Frame>;
  const drop = [-2, -4, -7, -9, -12, -15, -18, -21, -24, -27, -29, -31];
  const di = Math.min(drop.length - 1, Math.floor(Math.max(0, f - 20) / 4));
  const armed = drop[di] <= -30 && f >= 20;
  const armedAt = 20 + 11 * 4;
  const sells: L[] = Array.from({ length: 9 }, (_, i) => {
    const amt = 4000 + Math.floor(random("sl" + i) * 30000);
    return { t: armedAt + 18 + i * 6, node: <>sell {amt.toLocaleString("en-US")} <S c={DIM}>→ buy</S> {Math.floor(amt / 2).toLocaleString("en-US")} <S c={RED}>→ burn</S></> };
  });
  const burned = sells.filter((l) => f >= l.t).length;
  const flashOn = armed && f < armedAt + 16 && Math.floor(f / 3) % 2 === 0;
  return <Frame tab={2} status={armed ? "siege armed" : "watching"}>
    <div style={{ padding: pad, paddingTop: W * 0.08, fontSize: size, lineHeight: 1.75 }}>
      <div><S c={DIM}>~/warchest ❯ </S>{typed("siege watch", f, 2, 0.9)}{f < 16 && <Cursor f={f} />}</div>
      {f >= 20 && <div style={{ marginTop: size * 0.6 }}>price vs ATH <span style={{ fontSize: size * 3.2, fontWeight: 700, color: drop[di] <= -30 ? RED : FG, marginLeft: size }}>{drop[di]}%</span></div>}
      {f >= 20 && <div style={{ color: DIM }}>threshold      <S c={FG}>−30%</S></div>}
      {armed && <div style={{ marginTop: size, padding: `${size * 0.4}px ${size * 0.8}px`, background: flashOn ? RED : "transparent", border: `2px solid ${RED}`, color: flashOn ? BG : RED, fontWeight: 700, display: "inline-block" }}>SIEGE ARMED · buyback 50%</div>}
      <div style={{ marginTop: size }}><Log lines={sells} f={f} size={size} max={H > W ? 6 : 3} /></div>
      {burned > 0 && <div style={{ marginTop: size * 0.6, color: DIM }}>burned <S c={AMBER}>{sells.slice(0, burned).reduce((a, _, i) => a + Math.floor((4000 + Math.floor(random("sl" + i) * 30000)) / 2), 0).toLocaleString("en-US")} $WAR</S> <span style={{ fontSize: size * 0.7 }}>· illustration</span></div>}
    </div>
  </Frame>;
}

// ---------- 11 · rank.up ----------
export const RANKUP_D = 265;
export function RankUp() {
  const f = useCurrentFrame(); const { W } = useWH();
  const size = W * 0.036, pad = W * 0.055;
  if (f >= 160) return <Frame tab={1} status="ranks"><End f={f - 160} /></Frame>;
  // Day counter accelerates, then lands on 10.
  const AT = [14, 34, 50, 62, 72, 80, 88, 96, 106, 118, 134];
  let d = -1; while (d < 10 && f >= AT[d + 1]) d++;
  const top = d === 10, since = d >= 0 ? f - AT[d] : 0;
  return <Frame tab={1} status="holding">
    <div style={{ padding: pad, fontSize: size, lineHeight: 1.75, height: "100%", display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <div><S c={DIM}>~/warchest ❯ </S>{typed("rank 0x8c3…11e", f, 2, 1)}{f < 14 && <Cursor f={f} />}</div>
      {d >= 0 && <>
        <div style={{ marginTop: size * 1.2, color: DIM }}>day held</div>
        <div style={{ fontSize: size * 5, fontWeight: 700, lineHeight: 1.1, color: top ? AMBER : FG, transform: since < 3 ? `translateY(${(3 - since) * -3}px)` : undefined }}>{String(d).padStart(2, "0")}</div>
        <div style={{ color: DIM, marginTop: size * 0.4 }}>rank</div>
        <div style={{ fontSize: size * 2.4, fontWeight: 700, lineHeight: 1.2, color: top ? AMBER : FG, textTransform: "uppercase" }}>{RANKS[d]}</div>
        <div style={{ marginTop: size * 0.9, display: "flex", gap: size * 0.35 }}>{Array.from({ length: 10 }, (_, i) => <div key={i} style={{ width: size * 1.4, height: size * 1.4, background: i < d ? (top ? AMBER : FG) : "transparent", border: `2px solid ${i < d ? (top ? AMBER : FG) : LINE}` }} />)}</div>
        <div style={{ marginTop: size * 1.2, color: DIM }}># share of rewards scales with tokens × rank</div>
        {top && <div style={{ color: AMBER }}>❯ max rank reached. no shortcuts were taken.</div>}
      </>}
    </div>
  </Frame>;
}
