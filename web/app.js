import { RANKS, lotLevel, rewardWeight } from './mechanics.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let motion = !reduced.matches;
if (motion) document.documentElement.classList.add('js-motion');

// Scroll reveals.
const revealObserver = new IntersectionObserver((entries) => entries.forEach((entry) => {
  if (entry.isIntersecting) { entry.target.classList.add('visible'); revealObserver.unobserve(entry.target); }
}), { threshold: 0.15 });
document.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el));

// Rank calculator.
const pips = document.querySelector('.pips');
for (let i = 0; i < 10; i++) pips.append(document.createElement('i'));
const list = document.querySelector('#rank-list');
RANKS.forEach((name, i) => { const li = document.createElement('li'); li.innerHTML = `<span>${name}</span><span>${String(i).padStart(2, '0')}</span>`; list.append(li); });
const slider = document.querySelector('#days');
function update() {
  const days = Number(slider.value), level = lotLevel(days), top = level === 10;
  document.querySelector('#day-output').textContent = `${days} ${days === 1 ? 'day' : 'days'}`;
  const rank = document.querySelector('#rank-name');
  rank.textContent = RANKS[level];
  rank.classList.toggle('top', top);
  document.querySelector('#level-caption').textContent = `RANK ${String(level).padStart(2, '0')} / 10`;
  document.querySelector('#weight').textContent = rewardWeight(1000n, level).toLocaleString('en-US');
  pips.classList.toggle('top', top);
  [...pips.children].forEach((el, i) => el.classList.toggle('lit', i < level));
  [...list.children].forEach((el, i) => { el.classList.toggle('on', i <= level); el.classList.toggle('current', i === level); });
}
slider.addEventListener('input', update);
update();

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

// Motion switch, also following the system setting.
const motionButton = document.querySelector('#motion-toggle');
function setMotion(value) {
  motion = value;
  document.documentElement.classList.toggle('no-motion', !motion);
  motionButton.textContent = `Motion: ${motion ? 'on' : 'off'}`;
  motionButton.setAttribute('aria-pressed', String(!motion));
}
motionButton.addEventListener('click', () => setMotion(!motion));
reduced.addEventListener('change', (e) => setMotion(!e.matches));
setMotion(motion);

document.querySelector('#year').textContent = new Date().getFullYear();
