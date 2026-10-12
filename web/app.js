import { Globe } from './globe.js';
import { RANKS, lotLevel, rewardWeight } from './mechanics.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let motion = !reduced.matches;
if (motion) document.documentElement.classList.add('js-motion');
const globes = [new Globe(document.querySelector('#hero-globe')), new Globe(document.querySelector('#network-globe'), { light: true })];

// Scroll reveals.
const revealObserver = new IntersectionObserver((entries) => entries.forEach((entry) => {
  if (entry.isIntersecting) { entry.target.classList.add('visible'); revealObserver.unobserve(entry.target); }
}), { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el));

// Rank calculator.
const bars = document.querySelector('.level-bars');
for (let i = 1; i <= 10; i++) { const bar = document.createElement('i'); bar.style.setProperty('--i', i); bars.append(bar); }
const slider = document.querySelector('#days');
function update() {
  const days = Number(slider.value), level = lotLevel(days), padded = String(level).padStart(2, '0');
  document.querySelector('#day-output').textContent = days;
  document.querySelector('#multiplier').textContent = padded;
  document.querySelector('#rank-name').textContent = RANKS[level];
  document.querySelector('#level-caption').textContent = `RANK ${padded} / 10`;
  document.querySelector('#weight').textContent = rewardWeight(1000n, level).toLocaleString('en-US');
  [...bars.children].forEach((el, i) => el.classList.toggle('lit', i < level));
  bars.classList.toggle('top', level === 10);
}
slider.addEventListener('input', update);
update();

// Treasury journey: fill, siege, earn.
const routes = [
  ['01 — FILL', 'Every trade fills the chest.', 'The hook takes 10% of every buy and every sell through the official pool, always in ETH. Ordinary transfers pay nothing.', 'Uniswap v4', 'The chest'],
  ['02 — SIEGE', 'Under −30%, the chest fights back.', 'When the price falls more than 30% under its all-time high, the chest buys back half of every sell, with no daily cap. Everything it buys is burned.', 'Every sell', 'Buyback and burn'],
  ['03 — EARN', 'Idle funds go to work.', 'A 20% liquid reserve stays ready for Siege and refills itself when it falls to 5%. The rest earns yield in on-chain vaults, shared by tokens × rank.', 'Yield vaults', 'Holders, by rank'],
];
document.querySelectorAll('[data-route]').forEach((btn) => btn.addEventListener('click', () => {
  const index = Number(btn.dataset.route);
  document.querySelectorAll('[data-route]').forEach((b) => { b.classList.toggle('active', b === btn); b.setAttribute('aria-pressed', String(b === btn)); });
  ['route-kicker', 'route-title', 'route-description', 'route-from', 'route-to'].forEach((id, i) => { document.getElementById(id).textContent = routes[index][i]; });
  if (globes[1].selectRoute) globes[1].selectRoute(index); else { globes[1].route = index; globes[1].draw(); }
}));

// Mobile menu.
const menu = document.querySelector('.menu-toggle'), nav = document.querySelector('#navigation');
function closeMenu() { menu.setAttribute('aria-expanded', 'false'); menu.setAttribute('aria-label', 'Open menu'); nav.classList.remove('open'); }
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  nav.classList.toggle('open', open);
});
nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeMenu));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// Globe controls.
const pause = document.querySelector('#rotate-toggle');
pause.addEventListener('click', () => {
  globes[0].setPaused(!globes[0].paused);
  pause.setAttribute('aria-pressed', String(globes[0].paused));
  pause.setAttribute('aria-label', globes[0].paused ? 'Resume globe rotation' : 'Pause globe rotation');
  pause.textContent = globes[0].paused ? '▷' : 'Ⅱ';
});
document.querySelector('#zoom-in').addEventListener('click', () => globes[0].setZoom(0.1));
document.querySelector('#zoom-out').addEventListener('click', () => globes[0].setZoom(-0.1));

// Motion switch, also following the system setting.
const motionButton = document.querySelector('#motion-toggle');
function setMotion(value) {
  motion = value;
  document.documentElement.classList.toggle('no-motion', !motion);
  motionButton.textContent = `Motion: ${motion ? 'on' : 'off'}`;
  motionButton.setAttribute('aria-pressed', String(!motion));
  globes.forEach((g) => g.setMotion(motion));
}
motionButton.addEventListener('click', () => setMotion(!motion));
reduced.addEventListener('change', (e) => setMotion(!e.matches));
setMotion(motion);

document.querySelector('#year').textContent = new Date().getFullYear();
