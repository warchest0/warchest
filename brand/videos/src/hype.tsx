// Fast pre-launch hype cuts: hard cuts, slammed type, printed palette (bone, ink, signal orange).
// Every shot is a pure function of its local frame, so renders are deterministic.
import React from "react";
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { loadFont as loadStencil } from "@remotion/google-fonts/BigShouldersStencil";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

const anton = loadAnton().fontFamily;
const stencil = loadStencil("normal", { weights: ["900"] }).fontFamily;
const mono = loadMono("normal", { weights: ["700"] }).fontFamily;

export const HFPS = 30;
const INK = "#0f0e0c", BONE = "#ece4d2", SIGNAL = "#ff4a1c", BLOOD = "#c4160c";

type Shot = { d: number; bg?: string; render: (f: number) => React.ReactNode };
const total = (s: Shot[]) => s.reduce((a, x) => a + x.d, 0);

// ---------- primitives ----------
const useWH = () => { const { width, height } = useVideoConfig(); return { W: width, H: height }; };

// Camera shake on impact, decays over a few frames.
const shake = (f: number, seed: number, amp = 14) => {
  const k = Math.max(0, 1 - f / 5);
  return `translate(${(random(`x${seed}${f}`) - 0.5) * amp * k}px, ${(random(`y${seed}${f}`) - 0.5) * amp * k}px)`;
};
const punch = (f: number) => [1.22, 1.07, 1.02, 1.0][Math.min(f, 3)];

// A line of type sized to fill the frame width.
function Big({ text, color = INK, font = anton, k = 0.5, max = 420, w, ls = 0, shadow }: { text: string; color?: string; font?: string; k?: number; max?: number; w: number; ls?: number; shadow?: string }) {
  const size = Math.min(max, (w * 0.86) / (text.length * k));
  return <div style={{ fontFamily: font, fontSize: size, lineHeight: 0.9, color, letterSpacing: ls, textTransform: "uppercase", whiteSpace: "nowrap", textShadow: shadow ? `${size * 0.035}px ${size * 0.025}px 0 ${shadow}` : undefined }}>{text}</div>;
}

// Lines that slam in one by one, `every` frames apart.
function Stack({ f, lines, every = 5, color = INK, shadow, k, max }: { f: number; lines: string[]; every?: number; color?: string; shadow?: string; k?: number; max?: number }) {
  const { W } = useWH();
  const shown = Math.min(lines.length, Math.floor(f / every) + 1);
  const last = f - (shown - 1) * every;
  return <div style={{ transform: `${shake(last, shown)} scale(${punch(last)})`, display: "flex", flexDirection: "column", alignItems: "center", gap: W * 0.012 }}>
    {lines.slice(0, shown).map((l, i) => <Big key={i} text={l} w={W} color={color} shadow={shadow} k={k} max={max} />)}
  </div>;
}

function Grain({ op = 0.22 }: { op?: number }) {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ mixBlendMode: "multiply", opacity: op, pointerEvents: "none" }}>
    <svg width="100%" height="100%"><filter id="hg"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={f % 12} stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter><rect width="100%" height="100%" filter="url(#hg)" /></svg>
  </AbsoluteFill>;
}

// Editorial chrome: corner labels and a running timecode.
function Chrome({ color, tag }: { color: string; tag: string }) {
  const f = useCurrentFrame(); const { W } = useWH();
  const s = W * 0.019, pad = W * 0.045;
  const tc = `00:${String(Math.floor(f / HFPS)).padStart(2, "0")}:${String(f % HFPS).padStart(2, "0")}`;
  const st: React.CSSProperties = { position: "absolute", fontFamily: mono, fontSize: s, letterSpacing: s * 0.18, color, opacity: 0.8 };
  return <AbsoluteFill style={{ pointerEvents: "none" }}>
    <div style={{ ...st, left: pad, top: pad }}>$WAR</div>
    <div style={{ ...st, right: pad, top: pad }}>{tag}</div>
    <div style={{ ...st, left: pad, bottom: pad }}>{tc}</div>
    <div style={{ ...st, right: pad, bottom: pad }}>WARCHEST</div>
  </AbsoluteFill>;
}

function Cuts({ shots, tag }: { shots: Shot[]; tag: string }) {
  const frame = useCurrentFrame();
  let acc = 0, i = 0;
  while (i < shots.length - 1 && frame >= acc + shots[i].d) { acc += shots[i].d; i++; }
  const s = shots[i], bg = s.bg ?? BONE;
  const fg = bg === INK || bg === BLOOD ? BONE : INK;
  return <AbsoluteFill style={{ background: bg }}>
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>{s.render(frame - acc)}</AbsoluteFill>
    <Chrome color={fg} tag={tag} />
    <Grain op={bg === INK ? 0.5 : 0.22} />
  </AbsoluteFill>;
}

// ---------- shared shots ----------
const flash = (bg = SIGNAL): Shot => ({ d: 1, bg, render: () => null });
const slam = (lines: string[], bg = BONE, d = 14, opts: { every?: number; color?: string; shadow?: string; k?: number; max?: number } = {}): Shot =>
  ({ d, bg, render: (f) => <Stack f={f} lines={lines} color={opts.color ?? (bg === INK || bg === BLOOD ? BONE : INK)} {...opts} /> });

// End card: the crate-stencil lockup stamped in letter by letter.
function EndCardShot({ f }: { f: number }) {
  const { W } = useWH();
  const box = W * 0.78;
  const war = "WAR", chest = "CHEST";
  const stamp = (i: number) => f >= 4 + i * 2;
  const last = Math.max(0, f - 4 - Math.min(7, Math.floor((f - 4) / 2)) * 2);
  return <div style={{ display: "flex", flexDirection: "column", alignItems: "center", transform: shake(f < 20 ? last : 9, 99, 10) }}>
    <div style={{ width: box, border: `${W * 0.012}px solid ${INK}`, padding: `${W * 0.03}px 0`, position: "relative", opacity: f >= 1 ? 1 : 0 }}>
      <div style={{ position: "absolute", left: W * 0.03, top: W * 0.025, fontFamily: mono, fontSize: W * 0.024, color: INK }}>NO. 10</div>
      <div style={{ position: "absolute", right: W * 0.03, top: W * 0.025, fontFamily: mono, fontSize: W * 0.024, color: INK }}>$WAR</div>
      <div style={{ textAlign: "center", fontFamily: stencil, fontWeight: 900, fontSize: box * 0.3, lineHeight: 1, color: INK, letterSpacing: box * 0.006 }}>
        {[...war].map((c, i) => <span key={i} style={{ opacity: stamp(i) ? 1 : 0 }}>{c}</span>)}
      </div>
      <div style={{ textAlign: "center", fontFamily: stencil, fontWeight: 900, fontSize: box * 0.15, lineHeight: 1.05, color: INK, letterSpacing: box * 0.055, paddingLeft: box * 0.055 }}>
        {[...chest].map((c, i) => <span key={i} style={{ opacity: stamp(i + 3) ? 1 : 0 }}>{c}</span>)}
      </div>
    </div>
    <div style={{ marginTop: W * 0.05, fontFamily: anton, fontSize: W * 0.055, color: INK, opacity: f >= 22 ? 1 : 0, textTransform: "uppercase" }}>Hold longer. Rank higher.</div>
    <div style={{ marginTop: W * 0.025, fontFamily: mono, fontSize: W * 0.03, letterSpacing: W * 0.012, color: BONE, background: SIGNAL, padding: `${W * 0.01}px ${W * 0.025}px`, opacity: f >= 30 && (f < 30 || Math.floor(f / 8) % 2 === 0 || f > 60) ? 1 : 0 }}>COMING SOON</div>
  </div>;
}
const endCard = (d = 75): Shot => ({ d, bg: BONE, render: (f) => <EndCardShot f={f} /> });

// ---------- 05 · Manifesto ----------
const MANIFESTO: Shot[] = [
  slam(["SOMETHING"], INK, 8), slam(["IS BEING"], INK, 7), slam(["BUILT."], SIGNAL, 12),
  flash(BONE),
  slam(["EVERY", "TRADE"], BONE, 12, { every: 4 }), slam(["FILLS", "THE CHEST."], SIGNAL, 16, { every: 5 }),
  slam(["EVERY DAY", "YOU HOLD"], INK, 14, { every: 5 }), slam(["YOU", "RANK UP."], BONE, 16, { every: 5, shadow: SIGNAL }),
  flash(), slam(["SELLERS"], INK, 7), slam(["PAY."], BLOOD, 10), slam(["HOLDERS"], INK, 7), slam(["RISE."], SIGNAL, 12),
  flash(INK), endCard(),
];
export const MANIFESTO_D = total(MANIFESTO);
export const Manifesto = () => <Cuts shots={MANIFESTO} tag="PRE-LAUNCH" />;

// ---------- 06 · Rank rush ----------
const RANKS = ["RECRUIT", "SOLDIER", "CORPORAL", "SERGEANT", "LIEUTENANT", "CAPTAIN", "COMMANDER", "COLONEL", "GENERAL", "MARSHAL", "WARLORD"];
// Frame at which each rank lands: fast in the middle, slow at both ends.
const RANK_AT = [0, 10, 17, 22, 26, 30, 34, 39, 46, 56, 70];
function RankRush({ f }: { f: number }) {
  const { W } = useWH();
  let r = 0; while (r < 10 && f >= RANK_AT[r + 1]) r++;
  const since = f - RANK_AT[r], top = r === 10;
  return <div style={{ display: "flex", flexDirection: "column", alignItems: "center", transform: `${shake(since, r, top ? 26 : 10)} scale(${top ? punch(since) : 1})` }}>
    <div style={{ fontFamily: mono, fontSize: W * 0.04, letterSpacing: W * 0.01, color: top ? BONE : INK }}>DAY {String(r).padStart(2, "0")}</div>
    <div style={{ marginTop: W * 0.02 }}><Big text={RANKS[r]} w={W} color={top ? BONE : INK} shadow={top ? INK : undefined} max={300} /></div>
    <div style={{ display: "flex", gap: W * 0.012, marginTop: W * 0.05 }}>
      {Array.from({ length: 10 }, (_, i) => <div key={i} style={{ width: W * 0.06, height: W * 0.06, background: i < r ? (top ? BONE : INK) : "transparent", border: `${W * 0.005}px solid ${top ? BONE : INK}` }} />)}
    </div>
  </div>;
}
const RUSH: Shot[] = [
  slam(["DAY ONE."], INK, 12), slam(["YOU'RE", "NOBODY."], BONE, 16, { every: 5 }), flash(INK),
  { d: 70, bg: BONE, render: (f) => <RankRush f={f} /> },
  { d: 24, bg: SIGNAL, render: (f) => <RankRush f={70 + f} /> },
  slam(["NO SHORTCUTS."], INK, 14), slam(["NO RANK", "FOR SALE."], BONE, 16, { every: 5 }), slam(["TIME IS THE", "ONLY WAY UP."], SIGNAL, 22, { every: 6 }),
  flash(INK), endCard(),
];
export const RUSH_D = total(RUSH);
export const Rush = () => <Cuts shots={RUSH} tag="10 RANKS" />;

// ---------- 07 · Siege ----------
// Price line falling through the -30% line; the frame turns into an alarm once it crosses.
const PATH = [0.18, 0.12, 0.2, 0.16, 0.3, 0.26, 0.42, 0.5, 0.47, 0.62, 0.7, 0.78];
function Dump({ f }: { f: number }) {
  const { W, H } = useWH();
  const cw = W * 0.84, ch = Math.min(H * 0.5, W * 0.62), lineY = 0.48;
  const n = Math.min(PATH.length, 2 + Math.floor(f / 2.5));
  const pts = PATH.slice(0, n).map((y, i) => `${(i / (PATH.length - 1)) * cw},${y * ch}`).join(" ");
  const crossed = PATH[n - 1] > lineY;
  return <div style={{ position: "relative", width: cw, height: ch }}>
    <div style={{ position: "absolute", left: 0, right: 0, top: lineY * ch, borderTop: `${W * 0.005}px dashed ${INK}` }} />
    <div style={{ position: "absolute", right: 0, top: lineY * ch - W * 0.05, fontFamily: mono, fontSize: W * 0.03, color: INK }}>−30% FROM ATH</div>
    <svg width={cw} height={ch} style={{ position: "absolute", inset: 0, overflow: "visible" }}><polyline points={pts} fill="none" stroke={crossed ? BLOOD : INK} strokeWidth={W * 0.014} strokeLinejoin="miter" /></svg>
  </div>;
}
function Hazard({ f, text }: { f: number; text: string }) {
  const { W } = useWH();
  const on = Math.floor(f / 4) % 2 === 0;
  return <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", background: on ? BLOOD : INK }}>
    <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: W * 0.09, background: `repeating-linear-gradient(45deg, ${SIGNAL} 0 ${W * 0.04}px, ${INK} ${W * 0.04}px ${W * 0.08}px)`, backgroundPosition: `${f * 6}px 0` }} />
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: W * 0.09, background: `repeating-linear-gradient(45deg, ${SIGNAL} 0 ${W * 0.04}px, ${INK} ${W * 0.04}px ${W * 0.08}px)`, backgroundPosition: `${-f * 6}px 0` }} />
    <div style={{ transform: `${shake(f % 8, f, 18)} scale(${punch(f)})` }}><Big text={text} w={W} color={BONE} max={330} /></div>
  </AbsoluteFill>;
}
function Burn({ f }: { f: number }) {
  const { W } = useWH();
  const p = Math.min(1, f / 30), v = Math.round(1284000 * (1 - Math.pow(1 - p, 3)));
  return <div style={{ display: "flex", flexDirection: "column", alignItems: "center", transform: shake(f % 3 === 0 ? 0 : 9, f, 4) }}>
    <div style={{ fontFamily: mono, fontSize: W * 0.035, letterSpacing: W * 0.01, color: BONE }}>BURNED</div>
    <Big text={v.toLocaleString("en-US")} w={W} color={SIGNAL} max={260} k={0.5} />
    <div style={{ fontFamily: mono, fontSize: W * 0.035, letterSpacing: W * 0.01, color: BONE, marginTop: W * 0.01 }}>$WAR · GONE FOREVER</div>
    <div style={{ fontFamily: mono, fontSize: W * 0.02, color: BONE, opacity: 0.5, marginTop: W * 0.04 }}>ILLUSTRATION</div>
  </div>;
}
const SIEGE: Shot[] = [
  slam(["THEY DUMP."], INK, 12),
  { d: 30, bg: BONE, render: (f) => <Dump f={f} /> },
  { d: 22, bg: BLOOD, render: (f) => <Hazard f={f} text="SIEGE MODE" /> },
  slam(["THE CHEST", "FIGHTS BACK."], BONE, 18, { every: 6, shadow: SIGNAL }),
  slam(["HALF OF", "EVERY SELL"], INK, 14, { every: 5 }), slam(["BOUGHT", "BACK."], SIGNAL, 14, { every: 5 }),
  slam(["AND"], INK, 6), slam(["BURNED."], BLOOD, 12),
  { d: 40, bg: INK, render: (f) => <Burn f={f} /> },
  flash(), endCard(),
];
export const SIEGE_D = total(SIEGE);
export const SiegeCut = () => <Cuts shots={SIEGE} tag="SIEGE MODE" />;

// ---------- 08 · Paper vs diamond ----------
function Strike({ f, text }: { f: number; text: string }) {
  const { W } = useWH();
  const p = Math.min(1, Math.max(0, (f - 5) / 4));
  return <div style={{ position: "relative" }}>
    <Big text={text} w={W} color={BONE} max={260} />
    <div style={{ position: "absolute", left: "-3%", top: "46%", height: W * 0.03, width: `${106 * p}%`, background: SIGNAL, transform: "rotate(-3deg)" }} />
  </div>;
}
function Compare({ f }: { f: number }) {
  const { W } = useWH();
  const col = (rank: string, share: number, label: string, i: number, hot: boolean) => (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", opacity: f >= i * 8 ? 1 : 0, transform: shake(f - i * 8, i, 14) }}>
      <div style={{ fontFamily: mono, fontSize: W * 0.03, color: INK }}>{label}</div>
      <div style={{ fontFamily: anton, fontSize: W * 0.13, color: hot ? SIGNAL : INK, lineHeight: 1.1 }}>{rank}</div>
      <div style={{ width: W * 0.26, height: W * 0.42, display: "flex", alignItems: "flex-end", border: `${W * 0.006}px solid ${INK}` }}>
        <div style={{ width: "100%", height: `${Math.min(1, Math.max(0, (f - 16) / 14)) * share * 100}%`, background: hot ? SIGNAL : INK }} />
      </div>
      <div style={{ fontFamily: anton, fontSize: W * 0.08, color: INK, marginTop: W * 0.02, opacity: f > 30 ? 1 : 0 }}>{hot ? "×5" : "×1"}</div>
    </div>);
  return <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
    <div style={{ display: "flex", gap: W * 0.1, alignItems: "flex-end" }}>{col("RANK 2", 0.2, "SAME BAG", 0, false)}{col("RANK 10", 1, "SAME BAG", 1, true)}</div>
    <div style={{ fontFamily: mono, fontSize: W * 0.02, color: INK, opacity: 0.5, marginTop: W * 0.04 }}>SHARE OF THE REWARDS · ILLUSTRATIVE</div>
  </div>;
}
const HANDS: Shot[] = [
  { d: 14, bg: INK, render: (f) => <div style={{ transform: shake(f, 1) }}><Strike f={f} text="PAPER HANDS" /></div> },
  slam(["PAY 10%."], BLOOD, 12), flash(BONE),
  slam(["IT GOES", "IN THE CHEST."], INK, 16, { every: 5 }),
  slam(["SAME BAG."], BONE, 12), slam(["DIFFERENT", "RANK."], SIGNAL, 14, { every: 5 }),
  { d: 50, bg: BONE, render: (f) => <Compare f={f} /> },
  slam(["HOLD."], INK, 8), slam(["RISE."], BONE, 8), slam(["EARN."], SIGNAL, 12),
  flash(INK), endCard(),
];
export const HANDS_D = total(HANDS);
export const Hands = () => <Cuts shots={HANDS} tag="SELLERS PAY" />;

// ---------- Countdown: one 4-second post per day ----------
const DAY_LINES: Record<number, string[]> = {
  7: ["SOMETHING IS", "BEING BUILT."], 6: ["EVERY TRADE", "FILLS THE CHEST."], 5: ["TEN RANKS.", "NO SHORTCUTS."],
  4: ["TIME IS THE", "ONLY WAY UP."], 3: ["SELLERS PAY.", "HOLDERS RISE."], 2: ["THE CHEST", "FIGHTS BACK."], 1: ["TOMORROW."],
};
function Count({ f, days }: { f: number; days: number }) {
  const { W } = useWH();
  // The number ticks down from days+3 before locking on the real value.
  const n = f < 9 ? days + 3 - Math.floor(f / 3) : days;
  const lock = f - 9;
  return <div style={{ display: "flex", flexDirection: "column", alignItems: "center", transform: lock >= 0 ? `${shake(lock, days, 24)} scale(${punch(lock)})` : undefined }}>
    <div style={{ fontFamily: mono, fontSize: W * 0.04, letterSpacing: W * 0.02, color: BONE }}>LAUNCH IN</div>
    <div style={{ fontFamily: anton, fontSize: W * 0.62, lineHeight: 0.95, color: lock >= 0 ? SIGNAL : BONE }}>{n}</div>
    <div style={{ fontFamily: mono, fontSize: W * 0.04, letterSpacing: W * 0.02, color: BONE }}>{days === 1 ? "DAY" : "DAYS"}</div>
  </div>;
}
export const countdownShots = (days: number): Shot[] => [
  { d: 36, bg: INK, render: (f) => <Count f={f} days={days} /> },
  flash(),
  slam(DAY_LINES[days], BONE, 40, { every: 6, shadow: SIGNAL }),
  flash(INK), endCard(42),
];
export const COUNT_D = total(countdownShots(7));
export const Countdown = ({ days }: { days: number }) => <Cuts shots={countdownShots(days)} tag={`T-${days}`} />;
