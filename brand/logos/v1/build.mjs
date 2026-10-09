// Builds the Warchest logo proposals: one SVG per mark, a dark and a light board, and PNG exports.
// Run: node build.mjs   (needs playwright: run `npm ci` in brand/logos first)
import { writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const GOLD = "#e5af66", GOLD_HI = "#f4d6a0", ICE = "#b8d2f4", STEEL = "#668fbf", NAVY = "#080c12", INK = "#e8edf5";

// ---------- marks (viewBox 0 0 512 512) ----------
const arc = (cx, cy, r, a0, a1) => {
  const p = (a) => [cx + r * Math.cos((a - 90) * Math.PI / 180), cy + r * Math.sin((a - 90) * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};
const mix = (a, b, t) => {
  const h = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [r1, g1, b1] = h(a), [r2, g2, b2] = h(b);
  return "#" + [r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
};

const marks = {
  bastion: {
    title: "Bastion",
    idea: "A shield that is also a chest: the treasury that defends its holders.",
    svg: (c) => `
      <path d="M256 44 L430 104 V244 C430 352 356 430 256 470 C156 430 82 352 82 244 V104 Z" fill="none" stroke="${c.main}" stroke-width="28" stroke-linejoin="round"/>
      <path d="M150 236 C150 150 362 150 362 236" fill="none" stroke="${c.main}" stroke-width="22" stroke-linecap="round"/>
      <line x1="136" y1="236" x2="376" y2="236" stroke="${c.main}" stroke-width="22" stroke-linecap="round"/>
      <circle cx="256" cy="298" r="27" fill="${c.alt}"/>
      <path d="M241 306 H271 L263 360 H249 Z" fill="${c.alt}"/>`,
  },
  rank: {
    title: "Rank",
    idea: "Three chevrons climbing from steel to gold: every day held is a step up.",
    svg: (c) => `
      <polyline points="136,420 256,300 376,420" fill="none" stroke="${c.low}" stroke-width="44" stroke-linejoin="miter" stroke-linecap="square"/>
      <polyline points="136,320 256,200 376,320" fill="none" stroke="${c.mid}" stroke-width="44" stroke-linejoin="miter" stroke-linecap="square"/>
      <polyline points="136,220 256,100 376,220" fill="none" stroke="${c.main}" stroke-width="44" stroke-linejoin="miter" stroke-linecap="square"/>
      <rect x="240" y="30" width="32" height="32" transform="rotate(45 256 46)" fill="${c.main}"/>`,
  },
  rampart: {
    title: "Rampart",
    idea: "A W standing under castle walls: the Siege that holds the line.",
    svg: (c) => `
      ${[76, 154, 232, 310, 388].map((x) => `<rect x="${x}" y="70" width="48" height="58" rx="4" fill="${c.alt}"/>`).join("")}
      <rect x="76" y="124" width="360" height="40" rx="4" fill="${c.alt}"/>
      <polyline points="112,214 184,424 256,288 328,424 400,214" fill="none" stroke="${c.main}" stroke-width="46" stroke-linejoin="miter" stroke-linecap="butt"/>`,
  },
  vault: {
    title: "Vault",
    idea: "A coin with a keyhole: the shared treasury, locked and transparent.",
    svg: (c) => `
      <circle cx="256" cy="256" r="196" fill="none" stroke="${c.main}" stroke-width="30"/>
      ${Array.from({ length: 24 }, (_, i) => `<rect x="251" y="34" width="10" height="22" rx="3" fill="${c.main}" transform="rotate(${i * 15} 256 256)"/>`).join("")}
      <circle cx="256" cy="256" r="150" fill="none" stroke="${c.main}" stroke-width="6" opacity="0.45"/>
      <circle cx="256" cy="214" r="54" fill="${c.alt}"/>
      <path d="M224 238 H288 L306 360 H206 Z" fill="${c.alt}"/>`,
  },
  ten: {
    title: "Ten",
    idea: "Ten segments, ten ranks: the ring fills as you hold, from steel to gold.",
    svg: (c) => `
      ${Array.from({ length: 10 }, (_, i) => `<path d="${arc(256, 256, 186, i * 36 + 4, i * 36 + 32)}" fill="none" stroke="${c.ring(i / 9)}" stroke-width="40" stroke-linecap="butt"/>`).join("")}
      <polyline points="168,196 210,326 256,236 302,326 344,196" fill="none" stroke="${c.main}" stroke-width="34" stroke-linejoin="miter"/>`,
  },
  chest: {
    title: "Chest",
    idea: "The war chest itself, its latch an arrow pointing up.",
    svg: (c) => `
      <path d="M108 226 V192 C108 128 158 100 256 100 C354 100 404 128 404 192 V226 Z" fill="${c.main}"/>
      <rect x="108" y="244" width="296" height="170" rx="16" fill="${c.main}"/>
      <rect x="166" y="100" width="22" height="314" fill="${c.bg}" opacity="0.28"/>
      <rect x="324" y="100" width="22" height="314" fill="${c.bg}" opacity="0.28"/>
      <rect x="224" y="206" width="64" height="86" rx="12" fill="${c.bg}"/>
      <polyline points="240,266 256,248 272,266" fill="none" stroke="${c.main}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
};

const darkColors = { main: GOLD, alt: ICE, mid: mix(ICE, GOLD, 0.55), low: STEEL, bg: NAVY, ring: (t) => mix(STEEL, GOLD, t) };
const lightColors = { main: "#b9822f", alt: "#2f5d93", mid: mix("#2f5d93", "#b9822f", 0.5), low: "#2f5d93", bg: "#f6f3ec", ring: (t) => mix("#2f5d93", "#b9822f", t) };
const svgDoc = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${body}</svg>`;

mkdirSync("svg", { recursive: true });
mkdirSync("png", { recursive: true });
for (const [id, m] of Object.entries(marks)) {
  writeFileSync(`svg/${id}-dark.svg`, svgDoc(m.svg(darkColors)));
  writeFileSync(`svg/${id}-light.svg`, svgDoc(m.svg(lightColors)));
}

// ---------- boards ----------
const font = `@font-face{font-family:Inter;src:url(InterVariable.woff2) format("woff2");font-weight:100 900}`;
const card = (id, m, c, theme) => `
  <div class="card ${theme}">
    <svg viewBox="0 0 512 512" class="mark">${m.svg(c)}</svg>
    <div class="lockup"><span class="word">WARCHEST</span><span class="tick">$WAR</span></div>
    <div class="name">${String(Object.keys(marks).indexOf(id) + 1).padStart(2, "0")} · ${m.title}</div>
    <div class="idea">${m.idea}</div>
  </div>`;
const board = (theme) => {
  const c = theme === "dark" ? darkColors : lightColors;
  return `<html><head><style>${font}
  *{box-sizing:border-box;margin:0}
  body{font-family:Inter,sans-serif;background:${theme === "dark" ? NAVY : "#f6f3ec"};color:${theme === "dark" ? INK : "#141821"};padding:72px;width:1920px}
  h1{font-size:44px;font-weight:700;letter-spacing:-.02em} h1 span{color:${c.main}}
  .sub{margin-top:10px;font-size:20px;opacity:.6}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:32px;margin-top:48px}
  .card{border:1px solid ${theme === "dark" ? "#263141" : "#dcd5c6"};border-radius:28px;padding:44px;background:${theme === "dark" ? "#0d131c" : "#fffdf8"};display:flex;flex-direction:column;align-items:center}
  .mark{width:240px;height:240px}
  .lockup{margin-top:34px;display:flex;align-items:baseline;gap:14px}
  .word{font-size:34px;font-weight:800;letter-spacing:.2em}
  .tick{font-size:18px;font-weight:600;letter-spacing:.08em;color:${c.main}}
  .name{margin-top:26px;font-size:15px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;opacity:.55}
  .idea{margin-top:8px;font-size:17px;line-height:1.45;text-align:center;opacity:.8;max-width:440px}
  </style></head><body>
  <h1>WARCHEST <span>logo proposals</span></h1>
  <div class="sub">Six directions, ${theme} version. Gold = treasury and top rank · Ice blue = steel, the early ranks.</div>
  <div class="grid">${Object.entries(marks).map(([id, m]) => card(id, m, c, theme)).join("")}</div>
  </body></html>`;
};
// Avatar board: how each mark reads as an X profile picture and a favicon.
const avatars = () => `<html><head><style>${font}
  *{margin:0;box-sizing:border-box} body{background:#000;color:#e7e9ea;font-family:Inter,sans-serif;padding:64px;width:1920px}
  h1{font-size:36px;font-weight:700} .row{display:flex;gap:40px;margin-top:40px;flex-wrap:wrap}
  .it{display:flex;flex-direction:column;align-items:center;gap:16px;width:250px}
  .av{width:200px;height:200px;border-radius:50%;background:${NAVY};display:flex;align-items:center;justify-content:center;border:4px solid #000;box-shadow:0 0 0 1px #2f3336}
  .av svg{width:130px;height:130px} .fav{display:flex;gap:14px;align-items:center}
  .f{border-radius:8px;background:${NAVY};display:flex;align-items:center;justify-content:center}
  .lbl{font-size:16px;opacity:.6;letter-spacing:.1em;text-transform:uppercase}
  </style></head><body><h1>As an X avatar and a favicon</h1><div class="row">
  ${Object.values(marks).map((m) => `<div class="it"><div class="av"><svg viewBox="0 0 512 512">${m.svg(darkColors)}</svg></div>
  <div class="fav"><div class="f" style="width:64px;height:64px"><svg viewBox="0 0 512 512" width="48" height="48">${m.svg(darkColors)}</svg></div>
  <div class="f" style="width:32px;height:32px"><svg viewBox="0 0 512 512" width="24" height="24">${m.svg(darkColors)}</svg></div>
  <div class="f" style="width:16px;height:16px;border-radius:4px"><svg viewBox="0 0 512 512" width="13" height="13">${m.svg(darkColors)}</svg></div></div>
  <div class="lbl">${m.title}</div></div>`).join("")}</div></body></html>`;

writeFileSync("board-dark.html", board("dark"));
writeFileSync("board-light.html", board("light"));
writeFileSync("board-avatars.html", avatars());

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
for (const f of ["board-dark", "board-light", "board-avatars"]) {
  await page.goto(`file://${process.cwd()}/${f}.html`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `png/${f}.png`, fullPage: true });
}
// One 1024 px PNG per mark on navy (X avatar / app icon ready), and transparent.
for (const [id, m] of Object.entries(marks)) {
  for (const [suffix, bg] of [["navy", NAVY], ["transparent", "transparent"]]) {
    await page.setViewportSize({ width: 1024, height: 1024 });
    await page.setContent(`<html><body style="margin:0;background:${bg}"><svg viewBox="-64 -64 640 640" width="1024" height="1024">${m.svg(darkColors)}</svg></body></html>`);
    await page.screenshot({ path: `png/${id}-${suffix}.png`, omitBackground: bg === "transparent" });
  }
}
await browser.close();
console.log("done");
