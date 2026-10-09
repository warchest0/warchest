// Warchest logo directions, v3: terminal-native marks (grid monoline wordmark, dot-matrix lettering,
// pixel icons) and the mockups that show them in use. Run: node build.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BG = "#0a0b0d", DOT = "#262a31", FG = "#e3e7ee", AMBER = "#ffb43a", RED = "#ff5a4e", DIM = "#6b7280";
const FONTS = `<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=UnifrakturCook:wght@700&family=Instrument+Serif:ital@0;1&family=Archivo+Black&display=block" rel="stylesheet">`;

// ---------- 1. Grid monoline wordmark ----------
// Glyphs on a 5-wide grid: y=0 ascender, y=3 x-height, y=9 baseline.
const G = {
  w: [[[0, 3], [0, 9], [5, 9], [5, 3]], [[2.5, 3], [2.5, 9]]],
  a: [[[0, 3], [5, 3], [5, 9], [0, 9], [0, 5.8], [5, 5.8]]],
  r: [[[0, 9], [0, 3], [4.2, 3]]],
  c: [[[5, 3], [0, 3], [0, 9], [5, 9]]],
  h: [[[0, 0], [0, 9]], [[0, 3], [5, 3], [5, 9]]],
  e: [[[5, 9], [0, 9], [0, 3], [5, 3], [5, 6], [0, 6]]],
  s: [[[5, 3], [0, 3], [0, 6], [5, 6], [5, 9], [0, 9]]],
  t: [[[1.6, 0], [1.6, 9], [4.6, 9]], [[0, 3], [4.6, 3]]],
};
const ADV = { r: 4.2 + 2.2, t: 4.6 + 2.2 };
// Returns { svg body, width } in grid units; `accent` maps letter index -> color.
function gridWord(word, { u = 20, sw = 0.5, color = FG, accent = {}, cursor = null } = {}) {
  let x = 0, out = "";
  [...word].forEach((ch, i) => {
    const c = accent[i] ?? color;
    for (const pl of G[ch]) out += `<polyline points="${pl.map(([px, py]) => `${((x + px) * u).toFixed(1)},${(py * u).toFixed(1)}`).join(" ")}" fill="none" stroke="${c}" stroke-width="${sw * u}" stroke-linejoin="miter" stroke-linecap="square"/>`;
    x += ADV[ch] ?? 7.2;
  });
  if (cursor) { out += `<rect x="${(x + 0.2) * u}" y="${3 * u}" width="${3 * u}" height="${6.25 * u}" fill="${cursor}"/>`; x += 3.4; }
  return { body: out, w: (x - 2.2) * u, h: 9 * u, u };
}
const gridSvg = (word, opts = {}, pad = 1.5) => {
  const g = gridWord(word, opts), p = pad * g.u;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-p} ${-p} ${g.w + 2 * p} ${g.h + 2 * p}" width="${g.w + 2 * p}" height="${g.h + 2 * p}">${g.body}</svg>`;
};

// ---------- 2. Dot-matrix lettering (sampled from a font in the browser) ----------
async function dotify(page, { text, font, size, cell }) {
  return page.evaluate(async ({ text, font, size, cell }) => {
    await document.fonts.load(font.replace("{S}", size + "px"));
    const c = document.createElement("canvas"), x = c.getContext("2d");
    x.font = font.replace("{S}", size + "px");
    const m = x.measureText(text);
    c.width = Math.ceil(m.width + size * 0.2); c.height = Math.ceil(size * 1.3);
    x.font = font.replace("{S}", size + "px"); x.fillStyle = "#fff"; x.textBaseline = "alphabetic";
    x.fillText(text, size * 0.1, size);
    const d = x.getImageData(0, 0, c.width, c.height).data, pts = [];
    for (let y = 0; y < c.height; y += cell) for (let X = 0; X < c.width; X += cell) {
      let s = 0, n = 0;
      for (let j = 0; j < cell; j++) for (let i = 0; i < cell; i++) { s += d[((y + j) * c.width + X + i) * 4 + 3] || 0; n++; }
      if (s / n > 110) pts.push([X / cell, y / cell]);
    }
    return { pts, cols: Math.ceil(c.width / cell), rows: Math.ceil(c.height / cell) };
  }, { text, font, size, cell });
}
const dotSvg = ({ pts, cols, rows }, { r = 0.36, color = FG, square = false, accentFrom = Infinity, accent = AMBER } = {}) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs) - 1, y0 = Math.min(...ys) - 1, w = Math.max(...xs) - x0 + 2, h = Math.max(...ys) - y0 + 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w} ${h}">${pts.map(([x, y]) => {
    const c = x >= accentFrom ? accent : color;
    return square ? `<rect x="${x + 0.5 - r}" y="${y + 0.5 - r}" width="${2 * r}" height="${2 * r}" fill="${c}"/>` : `<circle cx="${x + 0.5}" cy="${y + 0.5}" r="${r}" fill="${c}"/>`;
  }).join("")}</svg>`;
};

// ---------- 3. Icons ----------
const ICONS = {
  // Monoline chest with an amber keyhole pixel.
  chest: (s = 200, fg = FG) => `<svg viewBox="-2 -2 16 16" width="${s}" height="${s}"><g fill="none" stroke="${fg}" stroke-width="0.75" stroke-linejoin="miter">
    <polyline points="0,5 0,1.5 12,1.5 12,5"/><rect x="0" y="5" width="12" height="6.5"/></g>
    <rect x="5.1" y="4.2" width="1.8" height="2.6" fill="${AMBER}"/></svg>`,
  // Ten ascending bars, the last one amber: the ten ranks.
  ranks: (s = 200, fg = FG) => `<svg viewBox="-1 -1 22 22" width="${s}" height="${s}">${Array.from({ length: 10 }, (_, i) => `<rect x="${i * 2}" y="${18 - (i + 1) * 1.7}" width="1.15" height="${(i + 1) * 1.7}" fill="${i === 9 ? AMBER : fg}"/>`).join("")}</svg>`,
  // [w] in brackets, terminal-style.
  bracket: (s = 200, fg = FG) => { const g = gridWord("w", { u: 1, sw: 0.62, color: AMBER }); return `<svg viewBox="-4.2 -0.5 13.4 10.5" width="${s}" height="${s}"><g transform="translate(0,0)">${g.body}</g>
    <polyline points="-2,1.5 -3.4,1.5 -3.4,9.4 -2,9.4" fill="none" stroke="${fg}" stroke-width="0.62"/><polyline points="7,1.5 8.4,1.5 8.4,9.4 7,9.4" fill="none" stroke="${fg}" stroke-width="0.62"/></svg>`; },
  // Pixel chest walker: the little mascot (chest body on four pixel legs).
  walker: (s = 200, fg = FG) => `<svg viewBox="0 0 16 16" width="${s}" height="${s}" shape-rendering="crispEdges">
    ${["....XXXXXXXX....", "...X........X...", "...XXXXXXXXXX...", "...X...AA...X...", "...X...AA...X...", "...XXXXXXXXXX...", "..X..X....X..X..", ".X..X......X..X.", ".X..X......X..X."]
      .flatMap((row, y) => [...row].map((ch, x) => ch === "." ? "" : `<rect x="${x}" y="${y + 3}" width="1" height="1" fill="${ch === "A" ? AMBER : fg}"/>`)).join("")}</svg>`,
};

// ---------- pages ----------
const css = `*{margin:0;box-sizing:border-box} body{background:${BG};color:${FG};font-family:'JetBrains Mono',monospace;position:relative;overflow:hidden}
.dots{position:absolute;inset:0;background-image:radial-gradient(${DOT} 1.4px,transparent 1.6px);background-size:28px 28px;background-position:14px 14px}
.lbl{font-size:14px;letter-spacing:.18em;text-transform:uppercase;color:${DIM}} .lbl b{color:${FG};font-weight:700;margin-right:12px}`;
const doc = (body, w = 1600, h = 900) => `<html><head>${FONTS}<style>${css} body{width:${w}px;height:${h}px}</style></head><body>${body}</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.setContent(doc(`<span style="font-family:UnifrakturCook">a</span><span style="font-family:Archivo Black">a</span><span style="font-family:Instrument Serif;font-style:italic">a</span>`), { waitUntil: "networkidle" });
const dmGothic = await dotify(page, { text: "warchest", font: "700 {S} UnifrakturCook", size: 220, cell: 7 });
const dmSerif = await dotify(page, { text: "warchest", font: "italic {S} 'Instrument Serif'", size: 260, cell: 7 });
const dmBlock = await dotify(page, { text: "warchest", font: "{S} 'Archivo Black'", size: 200, cell: 8 });
const dmW = await dotify(page, { text: "w", font: "700 {S} UnifrakturCook", size: 300, cell: 12 });

mkdirSync("svg", { recursive: true }); mkdirSync("sheets", { recursive: true }); mkdirSync("png", { recursive: true });
writeFileSync("svg/grid-wordmark.svg", gridSvg("warchest", { cursor: AMBER }));
writeFileSync("svg/grid-wordmark-plain.svg", gridSvg("warchest"));
writeFileSync("svg/dot-gothic.svg", dotSvg(dmGothic, { accentFrom: Infinity }));
writeFileSync("svg/dot-serif.svg", dotSvg(dmSerif));
for (const [k, f] of Object.entries(ICONS)) writeFileSync(`svg/icon-${k}.svg`, f(512).replace("<svg ", `<svg xmlns="http://www.w3.org/2000/svg" `));

const sheets = {
  "1-grid-wordmark": doc(`<div class="dots"></div>
    <div style="position:absolute;left:100px;top:90px" class="lbl"><b>01</b>grid wordmark · drawn on the same grid as the app</div>
    <div style="position:absolute;left:100px;top:200px;width:1300px">${gridSvg("warchest", { u: 22, cursor: AMBER }).replace(/width="[^"]+" height="[^"]+"/, 'width="100%"')}</div>
    <div style="position:absolute;left:100px;top:560px;display:flex;gap:70px;align-items:center">
      <div style="width:520px">${gridSvg("warchest", { u: 8, color: FG }).replace(/width="[^"]+" height="[^"]+"/, 'width="100%"')}</div>
      <div style="width:520px">${gridSvg("warchest", { u: 8, color: FG, accent: { 3: AMBER, 4: AMBER, 5: AMBER, 6: AMBER, 7: AMBER } }).replace(/width="[^"]+" height="[^"]+"/, 'width="100%"')}</div>
    </div>
    <div style="position:absolute;left:100px;top:720px;width:1400px;height:110px;background:${FG};display:flex;align-items:center;padding-left:40px;gap:60px">
      <div style="width:420px">${gridSvg("warchest", { u: 7, color: BG, cursor: "#d9480f" }).replace(/width="[^"]+" height="[^"]+"/, 'width="100%"')}</div>
      <div style="color:${BG};font-size:20px">hold longer. rank higher.</div></div>`),

  "2-dot-matrix": doc(`<div style="position:absolute;left:100px;top:70px" class="lbl"><b>02</b>dot-matrix lettering · LED board, sampled from type</div>
    <div style="position:absolute;left:100px;top:140px;width:1000px">${dotSvg(dmGothic, { r: 0.38 })}</div>
    <div style="position:absolute;left:100px;top:480px;width:640px">${dotSvg(dmSerif, { r: 0.4 })}</div>
    <div style="position:absolute;left:820px;top:520px;width:680px">${dotSvg(dmBlock, { r: 0.42, square: true, accentFrom: 999 })}</div>
    <div style="position:absolute;left:100px;bottom:70px;display:flex;gap:80px" class="lbl"><span>a · gothic, the war side</span><span>b · serif italic, editorial</span><span>c · block, loud</span></div>`),

  "3-icons": doc(`<div class="dots"></div><div style="position:absolute;left:100px;top:90px" class="lbl"><b>03</b>icons · avatar, favicon, in-app</div>
    <div style="position:absolute;left:100px;top:180px;display:flex;gap:44px">
    ${Object.entries(ICONS).map(([k, f]) => `<div style="display:flex;flex-direction:column;align-items:center;gap:26px">
      <div style="width:300px;height:300px;background:#111318;border:1px solid #23262d;display:flex;align-items:center;justify-content:center">${f(200)}</div>
      <div style="display:flex;gap:18px;align-items:center"><div style="width:110px;height:110px;border-radius:50%;background:${BG};border:1px solid #2f3336;display:flex;align-items:center;justify-content:center">${f(70)}</div>
      <div style="width:44px;height:44px;border-radius:9px;background:${FG};display:flex;align-items:center;justify-content:center">${f(32, BG)}</div>
      <div style="width:22px;height:22px;background:${BG};display:flex;align-items:center;justify-content:center">${f(18)}</div></div>
      <div class="lbl">${k}</div></div>`).join("")}</div>
    <div style="position:absolute;left:100px;top:720px;width:300px;height:92px;display:flex;align-items:center;gap:22px">${ICONS.chest(70)}<div style="width:240px">${gridSvg("warchest", { u: 3 }).replace(/width="[^"]+" height="[^"]+"/, 'width="100%"')}</div></div>
    <div style="position:absolute;left:520px;top:720px;width:400px;height:92px;display:flex;align-items:center;gap:22px">${ICONS.walker(80)}<div style="width:250px">${dotSvg(dmGothic, { r: 0.4 })}</div></div>`),

  "4-x-profile": doc(`<div style="position:absolute;left:250px;top:30px;width:1100px;height:840px;background:#000;border-left:1px solid #2f3336;border-right:1px solid #2f3336;font-family:system-ui,sans-serif">
      <div style="height:367px;background:${BG};position:relative;overflow:hidden"><div class="dots" style="background-size:22px 22px"></div>
        <div style="position:absolute;left:60px;top:70px;width:700px">${gridSvg("warchest", { u: 10, cursor: AMBER }).replace(/width="[^"]+" height="[^"]+"/, 'width="100%"')}</div>
        <div style="position:absolute;left:66px;top:250px;font:500 22px 'JetBrains Mono';color:${DIM}">❯ <span style="color:${FG}">hold longer. rank higher.</span></div>
        <div style="position:absolute;right:60px;top:60px;bottom:60px;width:270px;border:1px solid #2a2e36;padding:18px;font:13px/1.9 'JetBrains Mono';color:${DIM}">
          <div style="color:${FG}">chest status --live</div>rank 10 <span style="color:${AMBER}">warlord</span><br>fee 10% → chest<br>siege <span style="color:${RED}">armed @ −30%</span><br>buyback → burn<br><span style="color:${AMBER}">▌</span></div></div>
      <div style="position:absolute;left:30px;top:290px;width:150px;height:150px;border-radius:50%;background:${BG};border:5px solid #000;display:flex;align-items:center;justify-content:center">${ICONS.chest(92)}</div>
      <div style="padding:100px 30px 0;color:#e7e9ea"><div style="font-size:26px;font-weight:800">warchest</div><div style="color:#71767b;font-size:17px;margin-top:2px">@warchest</div>
        <div style="font-size:18px;margin-top:16px;line-height:1.45">every trade fills the chest. every day you hold, you rank up.<br>10 ranks. no shortcuts. $WAR · soon</div>
        <div style="display:flex;gap:26px;margin-top:22px;border-bottom:1px solid #2f3336;padding-bottom:0;font-size:16px;color:#71767b">${["Posts", "Replies", "Media"].map((t, i) => `<div style="padding:14px 0;${i ? "" : `color:#e7e9ea;font-weight:700;border-bottom:4px solid ${AMBER}`}">${t}</div>`).join("")}</div></div>
    </div><div style="position:absolute;left:60px;top:60px" class="lbl"><b>04</b>x profile</div>`),

  "5-site": doc(`<div style="position:absolute;inset:0;font-size:15px">
    <div style="display:flex;height:52px;border-bottom:1px solid #23262d;align-items:stretch">
      <div style="width:70px;display:flex;align-items:center;justify-content:center;border-right:1px solid #23262d">${ICONS.chest(30)}</div>
      ${["0:chest*", "1:ranks", "2:siege", "3:treasury", "4:missions", "5:manual"].map((t, i) => `<div style="padding:0 22px;display:flex;align-items:center;border-right:1px solid #23262d;${i ? "color:#9aa3af" : `background:${AMBER};color:${BG};font-weight:700`}">${t}</div>`).join("")}
      <div style="margin-left:auto;padding:0 26px;display:flex;align-items:center;border-left:1px solid #23262d;color:#9aa3af">launch <span style="color:${FG};margin-left:10px">T-07</span></div>
      <div style="padding:0 26px;display:flex;align-items:center;background:${FG};color:${BG};font-weight:700">join the list</div></div>
    <div style="position:absolute;left:0;top:52px;width:900px;bottom:0;border-right:1px solid #23262d;padding:40px">
      <div style="color:${DIM}">~/warchest <span style="color:${FG}">❯ chest status --live</span></div>
      <div style="position:relative;margin-top:30px;height:250px"><div class="dots" style="background-size:26px 26px"></div><div style="position:absolute;top:30px;width:800px">${gridSvg("warchest", { u: 12, cursor: AMBER }).replace(/width="[^"]+" height="[^"]+"/, 'width="100%"')}</div></div>
      <div style="font-size:22px;line-height:1.5;margin-top:20px">❯ every trade fills the chest. every day you hold,<br>&nbsp;&nbsp;you rank up. ten ranks. no shortcuts.</div>
      <div style="color:${DIM};margin-top:22px;line-height:1.7"># 10% of every trade goes to the chest. when price falls 30% under its high,<br># the chest buys back half of every sell and burns it.</div>
      <div style="margin-top:28px;border:1px dashed #3a3f48;padding:16px 18px;color:#9aa3af">❯ <span style="color:${AMBER}">siege</span> arms at −30% from ATH → buyback 50% of each sell → burn</div>
      <div style="display:flex;gap:16px;margin-top:26px"><div style="background:${FG};color:${BG};padding:14px 22px;font-weight:700">join the list ↗</div><div style="border:1px solid #3a3f48;padding:14px 22px">read the manual</div></div></div>
    <div style="position:absolute;left:900px;right:0;top:52px;bottom:0;padding:30px;font-size:14px;line-height:2;color:${DIM}">
      <div style="color:${FG}">❯ tail -f chest.log</div>
      ${[["00:15:19", "0x3f…a91", "rank 7 → 8", "colonel", AMBER], ["00:15:18", "chest", "fee in", "+0.42 eth", FG], ["00:15:16", "0x8c…11e", "rank 9 → 10", "warlord", AMBER], ["00:15:12", "0xa2…7f0", "sold 40%", "rank reset on sold part", RED], ["00:15:09", "chest", "fee in", "+0.18 eth", FG], ["00:15:04", "0x1d…c3b", "rank 2 → 3", "corporal", AMBER], ["00:14:58", "siege", "price −12% ath", "standby", DIM], ["00:14:51", "0x77…02a", "rank 4 → 5", "lieutenant", AMBER], ["00:14:47", "chest", "fee in", "+0.66 eth", FG], ["00:14:40", "0x5e…9d4", "rank 0 → 1", "soldier", AMBER]]
        .map(([t, a, b, c, col]) => `<div>${t} <span style="color:${FG}">${a}</span> ${b} <span style="color:${col}">${c}</span></div>`).join("")}
      <div style="margin-top:24px;border-top:1px solid #23262d;padding-top:18px">ranks [<span style="color:${AMBER}">||||||||||||||||</span><span style="color:#2a2e36">||||||||</span>] 7/10<br>chest [<span style="color:${FG}">||||||||||||||||||||</span><span style="color:#2a2e36">||||</span>] 41.2 eth<br><span style="font-size:12px">illustration · not live data</span></div></div>
    </div>`),
};
for (const [id, html] of Object.entries(sheets)) {
  writeFileSync(`sheets/${id}.html`, html);
  await page.goto(`file://${process.cwd()}/sheets/${id}.html`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(200);
  await page.screenshot({ path: `sheets/${id}.png` });
}
// 1024 px avatars
await page.setViewportSize({ width: 1024, height: 1024 });
for (const [k, f] of Object.entries(ICONS)) {
  await page.setContent(`<body style="margin:0;width:1024px;height:1024px;background:${BG};display:flex;align-items:center;justify-content:center">${f(640)}</body>`);
  await page.screenshot({ path: `png/avatar-${k}.png` });
}
await browser.close();
console.log("done");
