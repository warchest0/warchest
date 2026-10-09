// Warchest logo directions, v2: flat, type-driven, printed-looking marks shown in real-world mockups.
// Run: node build.mjs  -> sheets/*.png, svg/*.svg, png/*-avatar.png
import { writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const INK = "#0f0e0c", BONE = "#ece4d2", SIGNAL = "#ff4a1c", BRASS = "#c9a24b", OLIVE = "#3b4430", WAX = "#a3221b";

const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Anton&family=Big+Shoulders+Stencil:wght@700;900&family=Silkscreen:wght@400;700&family=UnifrakturCook:wght@700&family=JetBrains+Mono:wght@500;700&family=Archivo:wght@500;800&display=block" rel="stylesheet">`;

// Shared SVG filters: rough print edges, paper grain, wax relief.
const DEFS = `
<filter id="rough" x="-5%" y="-5%" width="110%" height="110%">
  <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="3.2"/>
</filter>
<filter id="spray" x="-5%" y="-5%" width="110%" height="110%">
  <feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2" seed="9" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="5" result="d"/>
  <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="3" seed="2" result="w"/>
  <feColorMatrix in="w" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -0.9 1.5" result="m"/>
  <feComposite in="d" in2="m" operator="in"/>
</filter>
<filter id="wax" x="-20%" y="-20%" width="140%" height="140%">
  <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="7" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="34"/>
</filter>
<filter id="emboss">
  <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="b"/>
  <feSpecularLighting in="b" surfaceScale="5" specularConstant=".9" specularExponent="18" lighting-color="#ffd9c9" result="s">
    <fePointLight x="-200" y="-300" z="300"/>
  </feSpecularLighting>
  <feComposite in="s" in2="SourceAlpha" operator="in" result="s2"/>
  <feComposite in="SourceGraphic" in2="s2" operator="arithmetic" k1="0" k2="1" k3=".55" k4="0"/>
</filter>`;
const grain = (op = 0.18, f = 0.8) => `<svg class="grain" width="100%" height="100%" style="position:absolute;inset:0;pointer-events:none;mix-blend-mode:multiply;opacity:${op}"><filter id="g${f}"><feTurbulence type="fractalNoise" baseFrequency="${f}" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#g${f})"/></svg>`;

// ---------- marks ----------
// 1. Stencil: a crate-marking wordmark.
const stencil = (c = INK) => `<svg viewBox="0 0 900 420" xmlns="http://www.w3.org/2000/svg"><defs>${DEFS}</defs>
  <g filter="url(#rough)" fill="${c}" font-family="'Big Shoulders Stencil'" font-weight="900">
    <rect x="10" y="10" width="880" height="400" fill="none" stroke="${c}" stroke-width="14"/>
    <rect x="34" y="34" width="832" height="10"/><rect x="34" y="376" width="832" height="10"/>
    <text x="450" y="236" text-anchor="middle" font-size="210" letter-spacing="6">WAR</text>
    <text x="450" y="352" text-anchor="middle" font-size="118" letter-spacing="40">CHEST</text>
    <text x="64" y="104" font-family="'JetBrains Mono'" font-weight="700" font-size="30">NO. 10</text>
    <text x="836" y="104" text-anchor="end" font-family="'JetBrains Mono'" font-weight="700" font-size="30">$WAR</text>
  </g></svg>`;

// 2. Seal: a red wax seal pressed with a W.
const seal = (size = 420) => `<svg viewBox="0 0 420 420" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><defs>${DEFS}
  <path id="ring" d="M210 210 m-128 0 a128 128 0 1 1 256 0 a128 128 0 1 1 -256 0"/></defs>
  <g filter="url(#emboss)">
    <circle cx="210" cy="212" r="168" fill="${WAX}" filter="url(#wax)"/>
    <circle cx="210" cy="210" r="146" fill="#8d1b15"/>
    <circle cx="210" cy="210" r="146" fill="none" stroke="#c23a2e" stroke-width="5"/>
    <text font-family="'JetBrains Mono'" font-weight="700" font-size="21" fill="#c84a3c">
      <textPath href="#ring" textLength="790" lengthAdjust="spacing">HOLD LONGER · RANK HIGHER · NO RANK FOR SALE ·</textPath></text>
    <circle cx="210" cy="210" r="96" fill="none" stroke="#c23a2e" stroke-width="4"/>
    <text x="210" y="262" text-anchor="middle" font-family="UnifrakturCook" font-weight="700" font-size="150" fill="#c84a3c">W</text>
  </g></svg>`;

// 3. Pixel chest: a 16-bit loot chest.
const PX = [
  "................",
  "...KKKKKKKKKK...",
  "..KHHHHHHHHHHK..",
  ".KHBBBBBBBBBBBK.",
  ".KBBBBBBBBBBBBK.",
  ".KGGGGGKKGGGGGK.",
  ".KKKKKKLLKKKKKK.",
  ".KBBBBKLLKBBBBK.",
  ".KBBBBBKKBBBBBK.",
  ".KBBBBBBBBBBBBK.",
  ".KGGGGGGGGGGGGK.",
  ".KBBBBBBBBBBBBK.",
  ".KKKKKKKKKKKKKK.",
];
const PXC = { K: "#1b120a", B: "#9a5527", H: "#c7773a", G: "#f0c24a", L: "#fff4c9" };
const pixel = (size = 320, flat) => `<svg viewBox="0 -1.5 16 16" width="${size}" height="${size}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${PX.flatMap((row, y) => [...row].map((ch, x) => (ch === "." ? "" : `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${flat ? (ch === "L" || ch === "G" ? flat[1] : flat[0]) : PXC[ch]}"/>`))).join("")}</svg>`;

// 4. Blackletter: a streetwear wordmark.
const gothic = (c = BONE) => `<svg viewBox="0 0 900 300" xmlns="http://www.w3.org/2000/svg"><defs>${DEFS}</defs>
  <g filter="url(#rough)"><text x="450" y="190" text-anchor="middle" font-family="UnifrakturCook" font-weight="700" font-size="190" fill="${c}">Warchest</text>
  <text x="450" y="262" text-anchor="middle" font-family="'JetBrains Mono'" font-weight="700" font-size="26" letter-spacing="14" fill="${c}">HOLD · RISE · EARN</text></g></svg>`;

// 5. Patch: an embroidered rank insignia.
const patch = (size = 420) => `<svg viewBox="0 0 420 480" width="${size}" height="${size * 480 / 420}" xmlns="http://www.w3.org/2000/svg"><defs>${DEFS}
  <pattern id="twill" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="6" height="6" fill="${OLIVE}"/><rect width="3" height="6" fill="#434d37"/></pattern>
  <pattern id="thread" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-50)"><rect width="5" height="5" fill="${BRASS}"/><rect width="1.6" height="5" fill="#e2c477"/></pattern></defs>
  <path d="M30 40 Q30 20 50 20 H370 Q390 20 390 40 V300 Q390 360 210 456 Q30 360 30 300 Z" fill="#1d2118"/>
  <path d="M44 50 Q44 34 60 34 H360 Q376 34 376 50 V296 Q376 350 210 438 Q44 350 44 296 Z" fill="url(#twill)"/>
  <path d="M44 50 Q44 34 60 34 H360 Q376 34 376 50 V296 Q376 350 210 438 Q44 350 44 296 Z" fill="none" stroke="#e2c477" stroke-width="3" stroke-dasharray="7 5"/>
  ${[0, 1, 2].map((i) => `<polyline points="96,${250 - i * 70} 210,${170 - i * 70} 324,${250 - i * 70}" fill="none" stroke="url(#thread)" stroke-width="36" stroke-linejoin="miter"/>`).join("")}
  <text x="210" y="356" text-anchor="middle" font-family="'Big Shoulders Stencil'" font-weight="900" font-size="82" letter-spacing="10" fill="url(#thread)">WAR</text>
</svg>`;

// 6. Poster: a heavy condensed monogram.
const mono = (fg = INK, bg = SIGNAL) => `<svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg"><defs>${DEFS}</defs>
  <rect width="400" height="400" fill="${bg}"/>
  <g filter="url(#rough)" fill="${fg}"><text x="200" y="330" text-anchor="middle" font-family="Anton" font-size="380" letter-spacing="-8">W</text>
  <rect x="0" y="176" width="400" height="22" fill="${bg}"/></g></svg>`;

// ---------- sheets (mark + mockup) ----------
const page = (body, bg = BONE, w = 1600, h = 900) => `<html><head>${FONTS}<style>
*{margin:0;box-sizing:border-box} body{width:${w}px;height:${h}px;background:${bg};position:relative;overflow:hidden;font-family:Archivo,sans-serif}
.tag{position:absolute;left:44px;bottom:36px;font:700 15px 'JetBrains Mono';letter-spacing:.2em;text-transform:uppercase}
.tag b{opacity:.45;font-weight:500;margin-left:14px}
</style></head><body>${body}</body></html>`;
const tag = (n, name, note, color = INK) => `<div class="tag" style="color:${color}">${n} · ${name}<b>${note}</b></div>`;

const sheets = {
  "1-stencil": page(`
    <div style="position:absolute;left:60px;top:300px;width:640px">${stencil()}</div>
    <div style="position:absolute;right:0;top:0;width:820px;height:900px;background:repeating-linear-gradient(0deg,#7a5634 0 148px,#4a3220 148px 152px);overflow:hidden">
      ${grain(0.5, 0.012)}${grain(0.35, 0.9)}
      <div style="position:absolute;left:0;right:0;top:0;bottom:0;background:linear-gradient(90deg,rgba(0,0,0,.35),transparent 30%,transparent 70%,rgba(0,0,0,.4))"></div>
      <div style="position:absolute;left:90px;top:230px;width:640px;opacity:.88;mix-blend-mode:multiply">${stencil("#16120e").replace('filter="url(#rough)"', 'filter="url(#spray)"')}</div>
      <div style="position:absolute;left:96px;top:690px;font:700 22px 'JetBrains Mono';color:#1a140e;opacity:.7;letter-spacing:.2em">THIS SIDE UP ↑ · HANDLE WITH CONVICTION</div>
    </div>${grain(0.12)}${tag("01", "Stencil", "crate marking, sprayed on wood")}`),

  "2-seal": page(`
    <div style="position:absolute;left:120px;top:210px">${seal(440)}</div>
    <div style="position:absolute;right:120px;top:90px;width:560px;height:720px;background:#f4eee0;box-shadow:0 30px 60px rgba(0,0,0,.25);transform:rotate(2.5deg);padding:70px 64px;font-family:'UnifrakturCook';color:#2a2118">
      <div style="font-size:52px">The Warchest</div>
      <div style="font:500 17px/1.7 'JetBrains Mono';margin-top:28px;opacity:.75">Every trade fills the chest.<br>Every day held, one rank higher.<br>Ten ranks. No shortcuts.<br>No rank for sale.<br><br>Sealed for those who stay.</div>
      <div style="position:absolute;right:46px;bottom:40px">${seal(210)}</div>${grain(0.22)}
    </div>${grain(0.16)}${tag("02", "Seal", "wax seal, the pact of holders")}`, "#d9cfba"),

  "3-pixel": page(`
    <div style="position:absolute;left:110px;top:170px">${pixel(380)}
      <div style="font:400 70px Silkscreen;color:#f0c24a;margin-top:30px;letter-spacing:.04em">WARCHEST</div></div>
    <div style="position:absolute;right:110px;top:130px;width:620px;height:520px;background:#141018;border:6px solid #f0c24a;box-shadow:0 0 0 6px #141018,0 0 0 12px #6b4a1f;padding:36px;font-family:Silkscreen;color:#f4ecd8;image-rendering:pixelated">
      <div style="font-size:22px;color:#f0c24a">★ LOOT UNLOCKED ★</div>
      <div style="display:flex;gap:30px;align-items:center;margin-top:30px">${pixel(170)}<div><div style="font-size:30px">DAY 7</div><div style="font-size:18px;opacity:.7;margin-top:8px">RANK: COLONEL</div></div></div>
      <div style="margin-top:34px;font-size:18px">SHARE OF THE CHEST</div>
      <div style="margin-top:10px;height:34px;border:4px solid #f4ecd8;padding:4px"><div style="width:70%;height:100%;background:repeating-linear-gradient(90deg,#f0c24a 0 22px,transparent 22px 26px)"></div></div>
      <div style="display:flex;justify-content:space-between;margin-top:36px;font-size:20px"><span>► CLAIM</span><span style="opacity:.5">HOLD</span><span style="opacity:.5">MISSIONS</span></div>
    </div>${tag("03", "Pixel", "16-bit loot chest, the game side", "#f4ecd8")}`, "#241a2e"),
  "4-gothic": page(`
    <div style="position:absolute;left:50px;top:300px;width:720px">${gothic(INK)}</div>
    <div style="position:absolute;right:90px;top:70px;width:640px;height:760px">
      <svg viewBox="0 0 640 760" width="640" height="760"><path d="M200 40 Q320 90 440 40 L600 120 L640 330 L548 350 L540 740 L100 740 L92 350 L0 330 L40 120 Z" fill="#141414"/>
      <path d="M200 40 Q320 120 440 40" fill="none" stroke="#2a2a2a" stroke-width="16"/><path d="M92 350 L100 740 M548 350 L540 740" stroke="#000" stroke-width="3" opacity=".6"/></svg>
      <div style="position:absolute;left:150px;top:200px;width:340px">${gothic(BONE)}</div>
      ${grain(0.4)}
    </div>${tag("04", "Gothic", "streetwear wordmark, tee and merch")}`),

  "5-patch": page(`
    <div style="position:absolute;left:150px;top:120px">${patch(400)}</div>
    <div style="position:absolute;right:0;top:0;width:800px;height:900px;background:#4b513c;overflow:hidden">${grain(0.55, 0.6)}
      <div style="position:absolute;inset:0;background:repeating-linear-gradient(35deg,rgba(0,0,0,.08) 0 3px,transparent 3px 7px)"></div>
      <div style="position:absolute;left:250px;top:220px;transform:rotate(-6deg);filter:drop-shadow(0 14px 14px rgba(0,0,0,.45))">${patch(300)}</div>
      <div style="position:absolute;left:0;top:0;width:110px;height:900px;background:#3f4532;box-shadow:inset -6px 0 10px rgba(0,0,0,.3)"></div>
    </div>${grain(0.12)}${tag("05", "Patch", "rank insignia, sewn on a jacket")}`),

  "6-poster": page(`
    <div style="position:absolute;left:110px;top:200px;width:420px;height:420px">${mono()}</div>
    <div style="position:absolute;left:600px;top:70px;width:900px;height:760px;background:#2b2b2b">${grain(0.6, 0.02)}
      ${[0, 1].map((i) => `<div style="position:absolute;left:${50 + i * 420}px;top:${40 + i * 18}px;width:400px;height:640px;background:${i ? INK : SIGNAL};transform:rotate(${i ? 1.4 : -1.2}deg);padding:30px;overflow:hidden">
        <div style="width:100%;height:340px">${i ? mono(SIGNAL, INK) : mono(INK, SIGNAL)}</div>
        <div style="font:400 92px/0.92 Anton;color:${i ? BONE : INK};margin-top:20px;letter-spacing:.01em">${i ? "SELLERS<br>PAY." : "HOLD<br>THE LINE."}</div>
        <div style="position:absolute;bottom:26px;left:30px;font:700 16px 'JetBrains Mono';color:${i ? BONE : INK};letter-spacing:.2em">$WAR · SOON</div>${grain(0.5)}
        <div style="position:absolute;inset:0;background:linear-gradient(170deg,transparent 60%,rgba(255,255,255,.08) 61%,transparent 64%)"></div></div>`).join("")}
    </div>${tag("06", "Poster", "heavy monogram, street posters")}`),
};

mkdirSync("sheets", { recursive: true }); mkdirSync("svg", { recursive: true }); mkdirSync("png", { recursive: true });
writeFileSync("svg/stencil.svg", stencil()); writeFileSync("svg/seal.svg", seal()); writeFileSync("svg/pixel.svg", pixel());
writeFileSync("svg/gothic.svg", gothic(INK)); writeFileSync("svg/patch.svg", patch()); writeFileSync("svg/poster.svg", mono());

// Avatars: how each one reads as a round X profile picture.
const AV = [
  ["Stencil", `<div style="background:${BONE};width:100%;height:100%;display:flex;align-items:center;justify-content:center"><div style="width:86%">${stencil()}</div></div>`],
  ["Seal", `<div style="background:#d9cfba;width:100%;height:100%;display:flex;align-items:center;justify-content:center">${seal(250)}</div>`],
  ["Pixel", `<div style="background:#241a2e;width:100%;height:100%;display:flex;align-items:center;justify-content:center">${pixel(210)}</div>`],
  ["Gothic", `<div style="background:${INK};width:100%;height:100%;display:flex;align-items:center;justify-content:center;font:700 150px UnifrakturCook;color:${BONE};padding-bottom:14px">W</div>`],
  ["Patch", `<div style="background:#4b513c;width:100%;height:100%;display:flex;align-items:center;justify-content:center">${patch(160)}</div>`],
  ["Poster", `<div style="background:${SIGNAL};width:100%;height:100%;display:flex;align-items:center;justify-content:center"><div style="width:74%">${mono()}</div></div>`],
];
const avatars = page(`<div style="padding:70px 60px;color:#e7e9ea"><div style="font:800 36px Archivo">As an X profile picture</div>
  <div style="display:flex;gap:44px;margin-top:70px">${AV.map(([n, h]) => `<div style="text-align:center"><div style="width:210px;height:210px;border-radius:50%;overflow:hidden;box-shadow:0 0 0 1px #2f3336">${h.replace(/width="420" height="420"|width="400" height="457.14285714285717"/, "")}</div>
  <div style="font:700 15px 'JetBrains Mono';letter-spacing:.2em;margin-top:22px;opacity:.6;text-transform:uppercase">${n}</div></div>`).join("")}</div></div>`, "#000", 1600, 500);

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1600, height: 900 } });
for (const [id, html] of Object.entries({ ...sheets, avatars })) {
  writeFileSync(`sheets/${id}.html`, html);
  await p.setViewportSize({ width: 1600, height: id === "avatars" ? 500 : 900 });
  await p.goto(`file://${process.cwd()}/sheets/${id}.html`, { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `sheets/${id}.png` });
}
// 1024 px avatar PNGs
await p.setViewportSize({ width: 1024, height: 1024 });
for (const [n, h] of AV) {
  await p.setContent(page(`<div style="width:1024px;height:1024px;transform-origin:0 0;transform:scale(${1024 / 210})"><div style="width:210px;height:210px">${h}</div></div>`, "#000", 1024, 1024), { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: `png/${n.toLowerCase()}-avatar.png` });
}
await browser.close();
console.log("done");
