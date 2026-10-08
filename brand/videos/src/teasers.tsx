import React from "react";
import { AbsoluteFill, Easing, interpolate, random, spring, useVideoConfig } from "remotion";
import {
  Background, Chest, EndCard, GOLD, GOLD_HI, Grain, ICE, INK, Label, NAVY, RANKS, RED, SIZE, STEEL, TenRing, Words,
  ease, easeOut, inter, lerp, mix, mono, useT,
} from "./common";

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

// ————————————————————————————————————————————————————————————————
// 01 · THE CHEST — every trade fills the chest, every day you hold you rank up.
// ————————————————————————————————————————————————————————————————
const COINS = Array.from({ length: 80 }, (_, i) => {
  const a = random(`ca${i}`) * Math.PI * 2;
  const d = 620 + random(`cd${i}`) * 260;
  return { x: 540 + Math.cos(a) * d, y: 470 + Math.sin(a) * d, delay: 0.7 + random(`cl${i}`) * 2.0, r: 9 + random(`cr${i}`) * 8, spin: 2 + random(`cs${i}`) * 4 };
});
export const TEASER1 = 12;
export function TheChest() {
  const t = useT();
  const { fps } = useVideoConfig();
  const appear = spring({ frame: (t - 0.25) * fps, fps, config: { damping: 14, mass: 0.9 } });
  const lid = lerp(t, 0.6, 1.3, 0, 0.7, easeOut);
  const arrivals = COINS.filter((c) => t > c.delay + 0.9).length;
  const pulse = 1 + 0.03 * Math.sin(arrivals * 1.7) * lerp(t, 0.8, 3.2, 1, 0);
  const chestOut = lerp(t, 3.1, 3.7, 0, 1);
  const fill = lerp(t, 3.5, 6.4, 0, 10, Easing.inOut(Easing.cubic));
  const ringIn = lerp(t, 3.2, 3.8, 0, 1, easeOut);
  const dim = lerp(t, 6.4, 7.0, 1, 0.45);
  const rank = Math.min(10, Math.floor(fill + 1e-6));
  return (
    <AbsoluteFill style={{ background: NAVY }}>
      <Background t={t} glow={0.45 + 0.35 * lerp(t, 0.6, 3, 0, 1)} />
      {/* coins flying into the chest */}
      <svg width={SIZE} height={SIZE} style={{ position: "absolute", inset: 0, opacity: 1 - chestOut }}>
        {COINS.map((c, i) => {
          const k = lerp(t, c.delay, c.delay + 0.9, 0, 1, Easing.bezier(0.55, 0, 0.9, 0.6));
          if (k <= 0 || k >= 1) return null;
          const x = c.x + (540 - c.x) * k, y = c.y + (440 - c.y) * k - Math.sin(k * Math.PI) * 120;
          return <ellipse key={i} cx={x} cy={y} rx={c.r * Math.abs(Math.cos(t * c.spin))} ry={c.r} fill={GOLD} stroke={GOLD_HI} strokeWidth={2} opacity={0.95} />;
        })}
      </svg>
      <div style={{ position: "absolute", left: 540 - 200, top: 470 - 220, width: 400, height: 400, transform: `scale(${appear * pulse * (1 - chestOut * 0.4)})`, opacity: 1 - chestOut }}>
        <Chest size={400} lid={lid} glow={1 + 0.5 * lerp(t, 0.8, 3.2, 0, 1)} />
      </div>
      {/* the chest becomes the rank ring */}
      <div style={{ position: "absolute", left: 540 - 210, top: 470 - 230, opacity: ringIn * dim, transform: `scale(${0.85 + 0.15 * ringIn})` }}>
        <TenRing fill={fill} size={420} t={t} w={ringIn} />
      </div>
      {t > 3.6 && t < 7.0 && (
        <div style={{ position: "absolute", top: 700, width: SIZE, textAlign: "center", fontFamily: mono, fontSize: 24, letterSpacing: "0.32em", color: rank === 10 ? GOLD : "rgba(232,237,245,.75)", opacity: ringIn * dim }}>
          DAY {String(rank).padStart(2, "0")} · {RANKS[rank].toUpperCase()}
        </div>
      )}
      <Words text="Every trade *fills the chest.*" start={0.5} end={3.0} size={62} y={800} />
      <Words text="Every day you hold, you *rank up.*" start={3.5} end={6.3} size={62} y={800} />
      <Words text="Hold longer. Take a *bigger share.*" start={6.5} end={8.2} size={62} y={800} />
      <EndCard start={8.0} />
      <Grain />
    </AbsoluteFill>
  );
}

// ————————————————————————————————————————————————————————————————
// 02 · RANKS — ten days, ten ranks, no shortcut.
// ————————————————————————————————————————————————————————————————
export const TEASER2 = 11.5;
export function Ranks() {
  const t = useT();
  const { fps } = useVideoConfig();
  const d = lerp(t, 0.9, 7.2, 0, 10, Easing.inOut(Easing.quad));
  const idx = Math.min(10, Math.floor(d + 1e-6));
  // each new rank pops in when its day is reached
  const reached = 0.9 + 6.3 * (idx / 10);
  const pop = spring({ frame: (t - reached) * fps, fps, config: { damping: 12, mass: 0.6 } });
  const ringIn = lerp(t, 0.2, 1.0, 0, 1, easeOut);
  const out = lerp(t, 7.5, 7.9, 0, 1);
  const top = idx === 10;
  return (
    <AbsoluteFill style={{ background: NAVY }}>
      <Background t={t} glow={0.3 + 0.5 * (d / 10)} />
      <AbsoluteFill style={{ opacity: 1 - out }}>
        <div style={{ position: "absolute", left: 540 - 250, top: 230, opacity: ringIn, transform: `scale(${0.9 + 0.1 * ringIn})` }}>
          <TenRing fill={d} size={500} t={t} w={ringIn} glow={0.6 + (top ? 1 : d / 14)} />
        </div>
        <div style={{ position: "absolute", top: 790, width: SIZE, textAlign: "center", fontFamily: inter, fontWeight: 800, fontSize: 72, letterSpacing: "0.04em",
          color: top ? GOLD : mix(ICE, GOLD, idx / 10), transform: `scale(${0.85 + 0.15 * pop})`, opacity: ringIn * (0.4 + 0.6 * pop) }}>
          {RANKS[idx].toUpperCase()}
        </div>
        <Label t={t} at={0.9} y={890} size={22}>DAY {String(idx).padStart(2, "0")} / 10</Label>
      </AbsoluteFill>
      <Words text="Time is the only *way up.*" start={0.3} end={3.7} size={56} y={92} />
      <Words text="No shortcuts. *No rank for sale.*" start={4.1} end={7.6} size={56} y={92} />
      <EndCard start={7.8} />
      <Grain />
    </AbsoluteFill>
  );
}

// ————————————————————————————————————————————————————————————————
// 03 · SIEGE — when the price falls 30% under its high, the chest buys back and burns.
// ————————————————————————————————————————————————————————————————
const CH = { x0: 100, x1: 980, y0: 250, y1: 740 };
const price = (u: number) => {
  // rise to the all-time high at u = 0.45, then a sharp fall to −45 %
  const base = u < 0.45 ? 0.38 + 0.62 * Math.pow(u / 0.45, 1.3) : 1 - 0.45 * Math.pow((u - 0.45) / 0.55, 0.85);
  const wiggle = 0.035 * Math.sin(u * 47) + 0.02 * Math.sin(u * 113 + 1.3);
  return Math.min(1, base + wiggle * (u < 0.43 || u > 0.47 ? 1 : 0));
};
const py = (p: number) => CH.y1 - ((p - 0.3) / 0.75) * (CH.y1 - CH.y0);
const px = (u: number) => CH.x0 + u * (CH.x1 - CH.x0);
const U_CROSS = (() => { for (let u = 0.46; u < 1; u += 0.001) if (price(u) < 0.7) return u; return 1; })();
export const TEASER3 = 12.5;
export function Siege() {
  const t = useT();
  const { fps } = useVideoConfig();
  const T0 = 0.4, T1 = 4.8;
  const u = lerp(t, T0, T1, 0, 1, Easing.linear);
  const tc = T0 + U_CROSS * (T1 - T0);
  const siege = lerp(t, tc, tc + 0.5, 0, 1, easeOut);
  const pts: string[] = [];
  for (let k = 0; k <= u + 1e-9; k += 0.004) pts.push(`${px(k).toFixed(1)},${py(price(k)).toFixed(1)}`);
  const lead = { x: px(u), y: py(price(u)) };
  const athIn = lerp(t, T0 + 0.45 * (T1 - T0), T0 + 0.45 * (T1 - T0) + 0.4, 0, 1);
  const flash = interpolate(t, [tc, tc + 0.12, tc + 0.9], [0, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const walls = spring({ frame: (t - tc - 0.15) * fps, fps, config: { damping: 15, mass: 1 } });
  const bought = lerp(t, tc + 0.6, 8.0, 0, 48250, Easing.out(Easing.quad));
  const burned = lerp(t, tc + 0.6, 8.0, 0, 1284000, Easing.out(Easing.quad));
  const out = lerp(t, 8.2, 8.6, 0, 1);
  // sell / buyback pulses: each red sell bar is answered by a gold bar half its size
  const pulses = Array.from({ length: 9 }, (_, i) => tc + 0.7 + i * 0.36);
  return (
    <AbsoluteFill style={{ background: NAVY }}>
      <Background t={t} glow={0.35} tint={siege > 0 ? RED : GOLD} embers={0.6} />
      <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 60%, rgba(251,113,133,${0.28 * flash}), transparent 60%)` }} />
      <AbsoluteFill style={{ opacity: 1 - out }}>
        <svg width={SIZE} height={SIZE} style={{ position: "absolute", inset: 0 }}>
          {/* all-time high and −30 % threshold */}
          <g opacity={athIn}>
            <line x1={CH.x0} x2={CH.x1} y1={py(1)} y2={py(1)} stroke="rgba(232,237,245,.35)" strokeWidth={2} strokeDasharray="6 10" />
            <text x={CH.x1} y={py(1) - 14} textAnchor="end" fontFamily={mono} fontSize={18} letterSpacing="4" fill="rgba(232,237,245,.6)">ALL-TIME HIGH</text>
            <line x1={CH.x0} x2={CH.x1} y1={py(0.7)} y2={py(0.7)} stroke={siege > 0 ? RED : "rgba(232,237,245,.35)"} strokeWidth={2} strokeDasharray="6 10" />
            <text x={CH.x1} y={py(0.7) - 14} textAnchor="end" fontFamily={mono} fontSize={18} letterSpacing="4" fill={siege > 0 ? RED : "rgba(232,237,245,.6)"}>−30% · SIEGE LINE</text>
          </g>
          <polyline points={pts.join(" ")} fill="none" stroke={siege > 0 ? mix(GOLD, RED, 0.35) : GOLD} strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={lead.x} cy={lead.y} r={9} fill={siege > 0 ? RED : GOLD} />
          <circle cx={lead.x} cy={lead.y} r={9 + 10 * ((t * 1.6) % 1)} fill="none" stroke={siege > 0 ? RED : GOLD} opacity={1 - ((t * 1.6) % 1)} />
          {/* buyback pulses near the line's end */}
          {pulses.map((p, i) => {
            const k = lerp(t, p, p + 0.25, 0, 1, easeOut);
            const f = lerp(t, p + 0.5, p + 1.1, 1, 0);
            if (k <= 0 || f <= 0) return null;
            const x = 770 + i * 24, h = 60 + 30 * random(`h${i}`), base = 735;
            const hb = (h / 2) * lerp(t, p + 0.12, p + 0.35, 0, 1, easeOut);
            return (
              <g key={i} opacity={f}>
                <rect x={x} y={base - h * k} width={9} height={h * k} fill={RED} rx={2} />
                <rect x={x + 10} y={base - hb} width={9} height={hb} fill={GOLD} rx={2} />
              </g>
            );
          })}
        </svg>
        {/* ramparts rising */}
        <svg width={SIZE} height={90} style={{ position: "absolute", left: 0, top: 990 + (1 - walls) * 100, opacity: siege * 0.6 }}>
          {Array.from({ length: 12 }, (_, i) => <rect key={i} x={i * 92 + 8} y={0} width={60} height={32} rx={4} fill={GOLD} />)}
          <rect x={0} y={30} width={SIZE} height={60} fill={GOLD} />
        </svg>
        {siege > 0 && (
          <>
            <div style={{ position: "absolute", top: 196, width: SIZE, textAlign: "center", fontFamily: mono, fontSize: 30, letterSpacing: "0.5em", color: RED, opacity: siege, textShadow: `0 0 ${24 * siege}px rgba(251,113,133,.6)` }}>SIEGE MODE</div>
            <div style={{ position: "absolute", top: 790, left: 100, width: 880, display: "flex", justifyContent: "space-between", opacity: lerp(t, tc + 0.5, tc + 0.9, 0, 1) }}>
              <Counter label="BOUGHT BACK" value={`$${fmt(bought)}`} color={GOLD} />
              <Counter label="BURNED" value={`${fmt(burned)} $WAR`} color={INK} align="right" />
            </div>
          </>
        )}
        <div style={{ position: "absolute", top: 26, right: 40, fontFamily: mono, fontSize: 14, letterSpacing: "0.3em", color: "rgba(232,237,245,.35)" }}>ILLUSTRATION</div>
      </AbsoluteFill>
      <Words text="When it falls, the chest *fights back.*" start={0.35} end={tc - 0.1} size={54} y={86} />
      <Words text="Half of every sell, *bought back and burned.*" start={tc + 0.7} end={8.1} size={50} y={86} />
      <EndCard start={8.3} />
      <Grain />
    </AbsoluteFill>
  );
}
function Counter({ label, value, color, align = "left" }: { label: string; value: string; color: string; align?: "left" | "right" }) {
  return (
    <div style={{ textAlign: align }}>
      <div style={{ fontFamily: mono, fontSize: 18, letterSpacing: "0.35em", color: "rgba(232,237,245,.55)" }}>{label}</div>
      <div style={{ marginTop: 8, fontFamily: inter, fontWeight: 800, fontSize: 52, color, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

// ————————————————————————————————————————————————————————————————
// 04 · EARN — same bag, different rank, five times the reward.
// ————————————————————————————————————————————————————————————————
export const TEASER4 = 12;
export function Earn() {
  const t = useT();
  const out = lerp(t, 6.6, 7.0, 0, 1);
  return (
    <AbsoluteFill style={{ background: NAVY }}>
      <Background t={t} glow={0.4} />
      <AbsoluteFill style={{ opacity: 1 - out }}>
        <Holder t={t} at={0.5} y={250} name="HOLDER A" rank={10} weight={10000} reward={600} />
        <Holder t={t} at={0.8} y={520} name="HOLDER B" rank={2} weight={2000} reward={120} />
        <div style={{ position: "absolute", bottom: 26, right: 40, fontFamily: mono, fontSize: 14, letterSpacing: "0.3em", color: "rgba(232,237,245,.35)" }}>ILLUSTRATIVE EXAMPLE</div>
      </AbsoluteFill>
      <Words text="Same bag. Different *rank.*" start={0.3} end={3.9} size={58} y={96} />
      <Words text="*5× the reward.*" start={4.2} end={6.6} size={70} y={830} sub="Rewards are split by tokens × rank." />
      <Words text="Hold. Rise. *Earn.*" start={6.9} end={8.6} size={84} y="center" />
      <EndCard start={8.5} />
      <Grain />
    </AbsoluteFill>
  );
}
function Holder({ t, at, y, name, rank, weight, reward }: { t: number; at: number; y: number; name: string; rank: number; weight: number; reward: number }) {
  const { fps } = useVideoConfig();
  const s = spring({ frame: (t - at) * fps, fps, config: { damping: 200 } });
  const bar = lerp(t, at + 0.9, at + 2.5, 0, weight / 10000, easeOut);
  const cash = lerp(t, 3.0, 4.4, 0, reward, Easing.out(Easing.quad));
  const top = rank === 10;
  const c = top ? GOLD : mix(STEEL, GOLD, rank / 10);
  return (
    <div style={{ position: "absolute", left: 100, top: y, width: 880, height: 220, borderRadius: 28, border: "1px solid #263141", background: "rgba(13,19,28,.85)", padding: "32px 40px", opacity: s, transform: `translateY(${(1 - s) * 30}px)` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontFamily: mono, fontSize: 20, letterSpacing: "0.35em", color: "rgba(232,237,245,.6)" }}>{name}</div>
        <div style={{ fontFamily: mono, fontSize: 20, letterSpacing: "0.25em", color: c }}>RANK {rank} · {RANKS[rank].toUpperCase()}</div>
      </div>
      <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontFamily: inter, fontWeight: 800, fontSize: 44, color: INK, letterSpacing: "-0.02em" }}>1,000 <span style={{ color: GOLD, fontSize: 30 }}>$WAR</span></div>
        <div style={{ fontFamily: inter, fontWeight: 800, fontSize: 56, color: c, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", opacity: lerp(t, 2.9, 3.2, 0, 1) }}>+${fmt(cash)}</div>
      </div>
      <div style={{ marginTop: 22, height: 14, borderRadius: 7, background: "rgba(232,237,245,.08)", overflow: "hidden" }}>
        <div style={{ width: `${bar * 100}%`, height: "100%", borderRadius: 7, background: `linear-gradient(90deg, ${STEEL}, ${c})`, boxShadow: `0 0 18px ${c}` }} />
      </div>
      <div style={{ marginTop: 10, fontFamily: mono, fontSize: 16, letterSpacing: "0.25em", color: "rgba(232,237,245,.5)" }}>WEIGHT {fmt(weight * Math.min(1, bar / (weight / 10000 || 1)))}</div>
    </div>
  );
}
