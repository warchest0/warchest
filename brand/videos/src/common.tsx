// Shared building blocks for the Warchest pre-launch teasers. Everything is driven by useCurrentFrame():
// no CSS animation, so every frame renders identically and motion stays perfectly smooth.
import React from "react";
import { AbsoluteFill, Easing, interpolate, random, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadSerif } from "@remotion/google-fonts/InstrumentSerif";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

export const inter = loadInter("normal", { weights: ["500", "600", "800"] }).fontFamily;
export const serif = loadSerif("italic").fontFamily;
export const mono = loadMono("normal", { weights: ["500"] }).fontFamily;

export const FPS = 60;
export const SIZE = 1080;
export const NAVY = "#080c12";
export const GOLD = "#e5af66";
export const GOLD_HI = "#f4d6a0";
export const ICE = "#b8d2f4";
export const STEEL = "#668fbf";
export const INK = "#e8edf5";
export const RED = "#fb7185";

export const ease = Easing.bezier(0.65, 0, 0.35, 1);
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const lerp = (t: number, a: number, b: number, from: number, to: number, e = ease) =>
  interpolate(t, [a, b], [from, to], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: e });
export const useT = () => useCurrentFrame() / FPS;

export const mix = (a: string, b: string, t: number) => {
  const h = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [r1, g1, b1] = h(a), [r2, g2, b2] = h(b);
  return `rgb(${Math.round(r1 + (r2 - r1) * t)},${Math.round(g1 + (g2 - g1) * t)},${Math.round(b1 + (b2 - b1) * t)})`;
};

export const RANKS = ["Recruit", "Soldier", "Corporal", "Sergeant", "Lieutenant", "Captain", "Commander", "Colonel", "General", "Marshal", "Warlord"];

// When a square teaser is placed inside the vertical (9:16) frame, the frame draws the background, embers,
// vignette and grain over its full height; the square only keeps its local glow so no seam shows.
export const Inset = React.createContext(false);

// ——— Background: deep navy, soft vignette, rising gold embers ———
const EMBERS = Array.from({ length: 140 }, (_, i) => ({
  x: random(`ex${i}`) * SIZE, y: random(`ey${i}`) * SIZE, z: 0.25 + random(`ez${i}`) * 0.75, p: random(`ep${i}`) * 6.28, w: random(`ew${i}`) * 40,
}));
export function Background({ t, embers = 1, glow = 0.5, tint = GOLD, height = SIZE }: { t: number; embers?: number; glow?: number; tint?: string; height?: number }) {
  const inset = React.useContext(Inset);
  const glowLayer = <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 46%, ${tint}${Math.round(glow * 26).toString(16).padStart(2, "0")} 0%, transparent 55%)` }} />;
  if (inset) return glowLayer;
  return (
    <AbsoluteFill style={{ background: NAVY }}>
      {glowLayer}
      <svg width={SIZE} height={height} style={{ position: "absolute", inset: 0, opacity: embers }}>
        {EMBERS.map((e, i) => {
          const y = (((e.y * (height / SIZE) - t * 28 * e.z) % height) + height) % height;
          const x = e.x + Math.sin(t * 0.7 + e.p) * e.w * 0.4;
          const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * (1 + e.z) + e.p));
          return <circle key={i} cx={x} cy={y} r={0.6 + e.z * 1.6} fill={i % 5 === 0 ? ICE : GOLD} opacity={tw * e.z * 0.55} />;
        })}
      </svg>
      <AbsoluteFill style={{ background: "radial-gradient(circle at 50% 50%, transparent 55%, rgba(0,0,0,.55) 100%)" }} />
    </AbsoluteFill>
  );
}

export function Grain() {
  const f = useCurrentFrame();
  if (React.useContext(Inset)) return null;
  return (
    <AbsoluteFill style={{ opacity: 0.05, mixBlendMode: "screen", pointerEvents: "none" }}>
      <svg width="100%" height="100%">
        <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={f % 30} /></filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
    </AbsoluteFill>
  );
}

// ——— Words: one word at a time, blur → sharp, small slide. *word* = serif italic gold accent ———
type Part = { w: string; serif?: boolean };
export const P = (s: string): Part[] =>
  s.split(/(\*[^*]+\*)/).filter(Boolean).flatMap((chunk) =>
    chunk.startsWith("*") ? chunk.slice(1, -1).split(" ").map((w) => ({ w, serif: true })) : chunk.trim().split(" ").filter(Boolean).map((w) => ({ w })));

export function Words({ text, start, end, size = 64, y = "center", sub, color = INK }: { text: string; start: number; end: number; size?: number; y?: number | "center"; sub?: string; color?: string }) {
  const t = useT();
  const { fps } = useVideoConfig();
  if (t < start - 0.05 || t > end + 0.05) return null;
  const parts = P(text);
  const out = lerp(t, end - 0.35, end, 0, 1, Easing.in(Easing.cubic));
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: y === "center" ? "center" : "flex-start", paddingTop: y === "center" ? 0 : y, flexDirection: "column" }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", maxWidth: 940, columnGap: size * 0.26, rowGap: size * 0.1, fontFamily: inter, fontWeight: 600, fontSize: size, color, letterSpacing: "-0.035em", alignItems: "baseline",
        filter: `blur(${out * 10}px)`, opacity: 1 - out, textShadow: "0 2px 18px rgba(0,0,0,.9)" }}>
        {parts.map((p, i) => {
          const s = spring({ frame: (t - start - i * 0.07) * fps, fps, config: { damping: 200, mass: 0.7 } });
          return (
            <span key={i} style={{ display: "inline-block", opacity: s, filter: `blur(${(1 - s) * 14}px)`, transform: `translateY(${(1 - s) * 26}px)`,
              ...(p.serif ? { fontFamily: serif, fontWeight: 400, fontSize: size * 1.14, color: GOLD_HI, letterSpacing: "-0.01em" } : {}) }}>{p.w}</span>
          );
        })}
      </div>
      {sub && (() => {
        const s = spring({ frame: (t - start - 0.45) * fps, fps, config: { damping: 200 } });
        return <div style={{ marginTop: 18, fontFamily: inter, fontWeight: 500, fontSize: size * 0.42, color: "rgba(232,237,245,.62)", opacity: s * (1 - out), transform: `translateY(${(1 - s) * 14}px)` }}>{sub}</div>;
      })()}
    </AbsoluteFill>
  );
}

// ——— Mono label (e.g. "DAY 03 / 10") ———
export function Label({ children, t, at, x = SIZE / 2, y, size = 22, color = "rgba(232,237,245,.8)", anchor = "center" }: { children: React.ReactNode; t: number; at: number; x?: number; y: number; size?: number; color?: string; anchor?: "center" | "left" }) {
  const a = lerp(t, at, at + 0.5, 0, 1, easeOut);
  return (
    <div style={{ position: "absolute", top: y, left: anchor === "center" ? 0 : x, width: anchor === "center" ? SIZE : undefined, textAlign: anchor, fontFamily: mono, fontSize: size, letterSpacing: "0.3em", color, opacity: a, transform: `translateY(${(1 - a) * 10}px)` }}>
      {children}
    </div>
  );
}

// ——— The "Ten" mark: ten segments, filled from steel to gold as `fill` goes 0 → 10 ———
export function TenRing({ fill, size, t, w = 1, glow = 1 }: { fill: number; size: number; t: number; w?: number; glow?: number }) {
  const R = 186, sw = 40;
  const seg = (i: number) => {
    const a0 = i * 36 + 4, a1 = i * 36 + 32;
    const p = (a: number) => [256 + R * Math.cos(((a - 90) * Math.PI) / 180), 256 + R * Math.sin(((a - 90) * Math.PI) / 180)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M${x0} ${y0} A${R} ${R} 0 0 1 ${x1} ${y1}`;
  };
  const breathe = 1 + 0.012 * Math.sin(t * 2.2);
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" style={{ overflow: "visible", transform: `scale(${breathe})`, filter: `drop-shadow(0 0 ${22 * glow}px rgba(229,175,102,${0.35 * glow}))` }}>
      {Array.from({ length: 10 }, (_, i) => {
        const k = Math.max(0, Math.min(1, fill - i));
        return (
          <g key={i}>
            <path d={seg(i)} fill="none" stroke="rgba(232,237,245,.09)" strokeWidth={sw} />
            <path d={seg(i)} fill="none" stroke={mix(STEEL, GOLD, i / 9)} strokeWidth={sw} opacity={k} />
          </g>
        );
      })}
      <polyline points="168,196 210,326 256,236 302,326 344,196" fill="none" stroke={GOLD} strokeWidth={34} strokeLinejoin="miter" opacity={w}
        strokeDasharray={700} strokeDashoffset={700 * (1 - w)} />
    </svg>
  );
}

// ——— The war chest (used in the opening teaser) ———
export function Chest({ size, lid = 0, glow = 1 }: { size: number; lid?: number; glow?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" style={{ overflow: "visible", filter: `drop-shadow(0 0 ${30 * glow}px rgba(229,175,102,${0.45 * glow}))` }}>
      <g transform={`translate(0 ${-lid * 26}) rotate(${-lid * 8} 108 226)`}>
        <path d="M108 226 V192 C108 128 158 100 256 100 C354 100 404 128 404 192 V226 Z" fill={GOLD} />
        <rect x="166" y="100" width="22" height="126" fill={NAVY} opacity="0.28" />
        <rect x="324" y="100" width="22" height="126" fill={NAVY} opacity="0.28" />
      </g>
      <rect x="108" y="244" width="296" height="170" rx="16" fill={GOLD} />
      <rect x="166" y="244" width="22" height="170" fill={NAVY} opacity="0.28" />
      <rect x="324" y="244" width="22" height="170" fill={NAVY} opacity="0.28" />
      <rect x="224" y="206" width="64" height="86" rx="12" fill={NAVY} />
      <polyline points="240,266 256,248 272,266" fill="none" stroke={GOLD} strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ——— End card: ring fills, wordmark types in, ticker + tagline + "coming soon" ———
export function EndCard({ start }: { start: number }) {
  const t = useT() - start;
  const { fps } = useVideoConfig();
  if (t < -0.05) return null;
  const fill = lerp(t, 0.1, 1.1, 0, 10, easeOut);
  const w = lerp(t, 0.7, 1.3, 0, 1, easeOut);
  const letters = "WARCHEST".split("");
  const tick = spring({ frame: (t - 1.6) * fps, fps, config: { damping: 200 } });
  const tag = spring({ frame: (t - 1.95) * fps, fps, config: { damping: 200 } });
  const soon = lerp(t, 2.4, 3.0, 0, 1, easeOut);
  const fadeIn = lerp(t, 0, 0.35, 0, 1, Easing.linear);
  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>
      <Background t={t + 50} glow={0.7} />
      <AbsoluteFill style={{ alignItems: "center", paddingTop: 210 }}>
        <TenRing fill={fill} size={250} t={t} w={w} />
        <div style={{ marginTop: 56, display: "flex", gap: 6 }}>
          {letters.map((l, i) => {
            const s = spring({ frame: (t - 1.0 - i * 0.05) * fps, fps, config: { damping: 200, mass: 0.6 } });
            return <span key={i} style={{ fontFamily: inter, fontWeight: 800, fontSize: 86, letterSpacing: "0.14em", color: INK, opacity: s, filter: `blur(${(1 - s) * 10}px)`, transform: `translateY(${(1 - s) * 18}px)` }}>{l}</span>;
          })}
        </div>
        <div style={{ marginTop: 10, fontFamily: inter, fontWeight: 600, fontSize: 34, letterSpacing: "0.12em", color: GOLD, opacity: tick }}>$WAR</div>
        <div style={{ marginTop: 34, fontFamily: inter, fontWeight: 600, fontSize: 44, color: INK, letterSpacing: "-0.03em", opacity: tag, transform: `translateY(${(1 - tag) * 14}px)` }}>
          Hold longer. <span style={{ fontFamily: serif, fontWeight: 400, fontSize: 50, color: GOLD_HI }}>Rank higher.</span>
        </div>
        <div style={{ marginTop: 60, fontFamily: mono, fontSize: 22, letterSpacing: "0.4em", color: "rgba(232,237,245,.75)", opacity: soon }}>COMING SOON</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
