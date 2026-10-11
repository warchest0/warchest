// Warchest seal: the chosen mark. Builds font-independent SVGs (all lettering outlined from the bundled fonts)
// and the PNG exports for X, the site and favicons. Run from brand/logos after `npm ci`: node seal/build.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const font = (f) => { const b = readFileSync(join(here, "fonts", f)); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const GOTHIC = font("UnifrakturCook-Bold.ttf"), MONO = font("JetBrainsMono-Bold.ttf"), ANTON = font("Anton-Regular.ttf");

export const COLORS = { WAX: "#a3221b", WAX_DARK: "#7f150e", WAX_DEEP: "#5c0c07", WAX_HI: "#cf4a39", BONE: "#ece4d2", INK: "#0f0e0c" };
const { WAX, WAX_DARK, WAX_DEEP, WAX_HI, BONE, INK } = COLORS;
const C = 256; // centre of the 512 viewBox

// ---------- geometry ----------
// Irregular wax edge: a circle perturbed by a few fixed harmonics, so the shape is organic but deterministic.
function blob(r, amp = 1) {
  const pts = [];
  for (let i = 0; i < 360; i++) {
    const t = (i / 360) * Math.PI * 2;
    const d = amp * (8 * Math.sin(3 * t + 1.1) + 5 * Math.sin(5 * t + 0.4) + 3.2 * Math.sin(9 * t + 2.3) + 2 * Math.sin(17 * t + 0.9) + 9 * Math.exp(-((t - 2.2) ** 2) / 0.02) + 6 * Math.exp(-((t - 4.9) ** 2) / 0.012));
    pts.push(`${(C + (r + d) * Math.sin(t)).toFixed(1)},${(C - (r + d) * Math.cos(t)).toFixed(1)}`);
  }
  return `M${pts.join("L")}Z`;
}

// Text set on a circle, reading clockwise from the top, glyph tops pointing outward.
function ringText(text, r, size, f = MONO) {
  const glyphs = [...text].map((ch) => ({ ch, adv: (f.charToGlyph(ch).advanceWidth / f.unitsPerEm) * size }));
  const total = glyphs.reduce((a, g) => a + g.adv, 0);
  const extra = (2 * Math.PI * r - total) / glyphs.length;
  const capH = ((f.tables.os2.sCapHeight || f.unitsPerEm * 0.7) / f.unitsPerEm) * size;
  const rb = r - capH / 2; // baseline radius: caps centred on r
  let s = 0, out = "";
  for (const g of glyphs) {
    const mid = s + g.adv / 2, theta = (mid / (2 * Math.PI * r)) * 360;
    if (g.ch.trim()) {
      const d = f.getPath(g.ch, -g.adv / 2, 0, size).toPathData(2);
      const a = (theta * Math.PI) / 180;
      out += `<path d="${d}" transform="translate(${(C + rb * Math.sin(a)).toFixed(2)} ${(C - rb * Math.cos(a)).toFixed(2)}) rotate(${theta.toFixed(2)})"/>`;
    }
    s += g.adv + extra;
  }
  return out;
}

// A string outlined and centred on (x, y).
function centred(text, f, size, x, y) {
  const p = f.getPath(text, 0, 0, size), b = p.getBoundingBox();
  return f.getPath(text, x - (b.x1 + b.x2) / 2, y - (b.y1 + b.y2) / 2, size).toPathData(2);
}

const RING = "HOLD LONGER · RANK HIGHER · NO RANK FOR SALE · ";
const W_PATH = centred("W", GOTHIC, 196, C, C + 4);
const RING_PATHS = ringText(RING, 146, 25);

// ---------- marks ----------
// Full colour: wax body with a soft sheen, pressed rim, raised lettering (shadow + highlight, no filters).
export const sealFull = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><radialGradient id="sheen" cx="0.38" cy="0.32" r="0.75"><stop offset="0" stop-color="#c13324"/><stop offset="0.55" stop-color="${WAX}"/><stop offset="1" stop-color="${WAX_DARK}"/></radialGradient>
  <radialGradient id="well" cx="0.5" cy="0.5" r="0.5"><stop offset="0.82" stop-color="${WAX_DARK}"/><stop offset="1" stop-color="${WAX_DEEP}"/></radialGradient></defs>
  <path d="${blob(222)}" fill="${WAX_DEEP}" transform="translate(3 6)" opacity="0.55"/>
  <path d="${blob(222)}" fill="url(#sheen)"/>
  <circle cx="${C}" cy="${C}" r="180" fill="url(#well)"/>
  <circle cx="${C}" cy="${C}" r="180" fill="none" stroke="${WAX_HI}" stroke-width="3" opacity="0.7"/>
  <g fill="${WAX_DEEP}" transform="translate(1.5 2)">${RING_PATHS}<path d="${W_PATH}"/></g>
  <g fill="${WAX_HI}">${RING_PATHS}<path d="${W_PATH}"/></g>
  <circle cx="${C}" cy="${C}" r="118" fill="none" stroke="${WAX_DEEP}" stroke-width="5" transform="translate(1.5 2)"/>
  <circle cx="${C}" cy="${C}" r="118" fill="none" stroke="${WAX_HI}" stroke-width="5"/>
  <ellipse cx="190" cy="120" rx="46" ry="16" fill="#fff" opacity="0.08" transform="rotate(-28 190 120)"/>
</svg>`;

// Flat: two colours, no relief. For favicons, small sizes and print.
export const sealFlat = (wax = WAX, mark = BONE) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <path d="${blob(222)}" fill="${wax}"/>
  <circle cx="${C}" cy="${C}" r="180" fill="none" stroke="${mark}" stroke-width="7"/>
  <g fill="${mark}">${RING_PATHS}<path d="${W_PATH}"/></g>
  <circle cx="${C}" cy="${C}" r="118" fill="none" stroke="${mark}" stroke-width="7"/>
</svg>`;

// Mono: one colour with the lettering knocked out (transparent), for stamps, embossing and one-colour print.
export const sealMono = (ink = INK) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><mask id="k"><path d="${blob(222)}" fill="#fff"/><g fill="#000">${RING_PATHS}<path d="${W_PATH}"/></g>
  <circle cx="${C}" cy="${C}" r="180" fill="none" stroke="#000" stroke-width="7"/><circle cx="${C}" cy="${C}" r="118" fill="none" stroke="#000" stroke-width="7"/></mask></defs>
  <rect width="512" height="512" fill="${ink}" mask="url(#k)"/>
</svg>`;

// Simplified glyph for 16-32 px: wax disc and the W only (the ring text is unreadable that small).
export const sealIcon = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <path d="${blob(236, 0.6)}" fill="${WAX}"/><path d="${centred("W", GOTHIC, 300, C, C + 8)}" fill="${BONE}"/></svg>`;

// Wordmark: "Warchest" in the same gothic, outlined.
export function wordmark(color = INK, size = 160) {
  const p = GOTHIC.getPath("Warchest", 0, 0, size), b = p.getBoundingBox();
  const pad = size * 0.06, w = b.x2 - b.x1 + pad * 2, h = b.y2 - b.y1 + pad * 2;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}"><path d="${GOTHIC.getPath("Warchest", pad - b.x1, pad - b.y1, size).toPathData(2)}" fill="${color}"/></svg>`, w, h };
}
const tagline = (text, color, size) => {
  const p = MONO.getPath(text, 0, 0, size), b = p.getBoundingBox(), w = b.x2 - b.x1, h = size * 1.3;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x1.toFixed(1)} ${(-size).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}"><path d="${p.toPathData(2)}" fill="${color}"/></svg>`;
};

// Horizontal lockup: seal + wordmark.
export function lockup(color = INK) {
  const wm = wordmark(color, 160), sealH = wm.h * 1.55, gap = wm.h * 0.28;
  const w = sealH + gap + wm.w, h = sealH;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}">
    <svg x="0" y="0" width="${sealH.toFixed(1)}" height="${sealH.toFixed(1)}" viewBox="0 0 512 512">${sealFull().replace(/^<svg[^>]*>|<\/svg>$/g, "")}</svg>
    <svg x="${(sealH + gap).toFixed(1)}" y="${((h - wm.h) / 2).toFixed(1)}" width="${wm.w.toFixed(1)}" height="${wm.h.toFixed(1)}" viewBox="0 0 ${wm.w.toFixed(1)} ${wm.h.toFixed(1)}">${wm.svg.replace(/^<svg[^>]*>|<\/svg>$/g, "")}</svg></svg>`;
}

// ---------- build ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = (p) => join(here, p);
  mkdirSync(out("svg"), { recursive: true }); mkdirSync(out("png"), { recursive: true });
  const files = {
    "svg/seal.svg": sealFull(), "svg/seal-flat.svg": sealFlat(), "svg/seal-mono-ink.svg": sealMono(INK), "svg/seal-mono-bone.svg": sealMono(BONE),
    "svg/seal-icon.svg": sealIcon(), "svg/wordmark-ink.svg": wordmark(INK).svg, "svg/wordmark-bone.svg": wordmark(BONE).svg,
    "svg/lockup-ink.svg": lockup(INK), "svg/lockup-bone.svg": lockup(BONE),
  };
  for (const [p, s] of Object.entries(files)) writeFileSync(out(p), s);

  const grain = (op) => `<svg style="position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:multiply;opacity:${op}"><filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#g)"/></svg>`;
  const page = (w, h, body, bg = BONE) => `<html><body style="margin:0;width:${w}px;height:${h}px;background:${bg};position:relative;overflow:hidden">${body}</body></html>`;
  const abs = (x, y, w, svg, extra = "") => `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;${extra}">${svg.replace("<svg ", '<svg width="100%" ')}</div>`;

  const renders = [
    // X avatar: seal on bone, sized to survive the round crop.
    ["png/avatar-1024.png", 1024, 1024, page(1024, 1024, abs(112, 112, 800, sealFull()) + grain(0.12)), false],
    ["png/avatar-400.png", 400, 400, page(400, 400, abs(44, 44, 312, sealFull()) + grain(0.12)), false],
    // X header 1500x500: wordmark and tagline left, seal right; the avatar overlaps the bottom-left corner on X.
    ["png/x-banner-1500x500.png", 1500, 500, page(1500, 500, abs(400, 120, 560, wordmark(INK).svg) + abs(406, 300, 470, tagline("HOLD LONGER. RANK HIGHER.", INK, 40)) + abs(408, 370, 170, tagline("$WAR · SOON", WAX, 40)) + abs(1040, 60, 380, sealFull(), "transform:rotate(-8deg)") + grain(0.16)), false],
    // Link preview 1200x630.
    ["png/og-1200x630.png", 1200, 630, page(1200, 630, abs(90, 125, 380, sealFull(), "transform:rotate(-6deg)") + abs(540, 210, 580, wordmark(INK).svg) + abs(546, 380, 470, tagline("HOLD LONGER. RANK HIGHER.", INK, 40)) + grain(0.16)), false],
    // Dark variants.
    ["png/avatar-1024-dark.png", 1024, 1024, page(1024, 1024, abs(112, 112, 800, sealFull()), INK), false],
    ["png/x-banner-1500x500-dark.png", 1500, 500, page(1500, 500, abs(400, 120, 560, wordmark(BONE).svg) + abs(406, 300, 470, tagline("HOLD LONGER. RANK HIGHER.", BONE, 40)) + abs(408, 370, 170, tagline("$WAR · SOON", WAX_HI, 40)) + abs(1040, 60, 380, sealFull(), "transform:rotate(-8deg)"), INK), false],
    // Transparent masters.
    ["png/seal-2048.png", 2048, 2048, page(2048, 2048, abs(0, 0, 2048, sealFull()), "transparent"), true],
    ["png/seal-flat-1024.png", 1024, 1024, page(1024, 1024, abs(0, 0, 1024, sealFlat()), "transparent"), true],
    ["png/lockup-ink-2400.png", 2400, Math.round(2400 / 3.6), page(2400, Math.round(2400 / 3.6), abs(0, 0, 2400, lockup(INK)), "transparent"), true],
    // Favicons.
    ["png/favicon-16.png", 16, 16, page(16, 16, abs(0, 0, 16, sealIcon()), "transparent"), true],
    ["png/favicon-32.png", 32, 32, page(32, 32, abs(0, 0, 32, sealIcon()), "transparent"), true],
    ["png/apple-touch-icon-180.png", 180, 180, page(180, 180, abs(16, 16, 148, sealFlat()), BONE), false],
  ];
  const sheet = page(1600, 1000, `
    <div style="position:absolute;left:70px;top:60px;font:700 15px monospace;letter-spacing:.2em;color:${INK}">WARCHEST · SEAL — FINAL MARK</div>
    ${abs(70, 120, 440, sealFull())}
    ${abs(560, 150, 220, sealFlat())}${abs(810, 150, 220, sealMono(INK))}
    <div style="position:absolute;left:1060px;top:150px;width:220px;height:220px;background:${INK}">${abs(0, 0, 220, sealMono(BONE))}</div>
    ${abs(1310, 190, 140, sealIcon())}
    ${["flat", "mono ink", "mono bone", "icon"].map((t, i) => `<div style="position:absolute;left:${[560, 810, 1060, 1310][i]}px;top:395px;width:${i === 3 ? 140 : 220}px;text-align:center;font:12px monospace;letter-spacing:.15em;text-transform:uppercase;color:${INK};opacity:.6">${t}</div>`).join("")}
    ${abs(560, 470, 560, lockup(INK))}
    <div style="position:absolute;left:0;top:700px;width:1600px;height:300px;background:${INK}">${abs(560, 70, 560, lockup(BONE))}${abs(70, 40, 220, sealFull())}</div>
    <div style="position:absolute;left:1180px;top:470px;display:flex;gap:18px;align-items:center">
      <div style="width:120px;height:120px;border-radius:50%;overflow:hidden;box-shadow:0 0 0 1px #0002">${abs(0, 0, 120, sealFull(), "background:" + BONE)}</div>
      ${abs(0, 0, 32, sealIcon(), "position:static")}${abs(0, 0, 16, sealIcon(), "position:static")}</div>
    ${grain(0.1)}`);

  const browser = await chromium.launch();
  const p = await browser.newPage();
  for (const [file, w, h, html, transparent] of [...renders, ["sheet.png", 1600, 1000, sheet, false]]) {
    await p.setViewportSize({ width: w, height: h });
    await p.setContent(html);
    await p.screenshot({ path: out(file), omitBackground: transparent });
  }
  await browser.close();
  console.log("done");
}
