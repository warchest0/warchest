import { Globe } from './globe.js';
import { lotLevel, votingWeight } from './mechanics.js';
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
let motion=!reduced.matches;
const globes=[new Globe(document.querySelector('#hero-globe')),new Globe(document.querySelector('#network-globe'),{light:true})];
const revealObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('visible');revealObserver.unobserve(entry.target);}}),{threshold:.12});
if(motion)document.documentElement.classList.add('js-motion');
document.querySelectorAll('.reveal').forEach((el,i)=>{el.style.transitionDelay='0ms';revealObserver.observe(el);});
document.querySelectorAll('.bars-art i').forEach((el,i)=>el.style.setProperty('--i',i+1));
const bars=document.querySelector('.level-bars');for(let i=1;i<=10;i++){const bar=document.createElement('i');bar.style.setProperty('--i',i);bars.append(bar);}
const slider=document.querySelector('#days');
function updateWeight(){const level=lotLevel(Number(slider.value));document.querySelector('#multiplier').innerHTML=`${level}<span>×</span>`;document.querySelector('#day-output').textContent=`${level} ${level===1?'day':'days'}`;document.querySelector('#level-caption').textContent=`LEVEL ${String(level).padStart(2,'0')} / 10`;document.querySelector('#weight').textContent=votingWeight(1000n,level).toLocaleString('en-US');[...bars.children].forEach((el,i)=>el.classList.toggle('lit',i<level));}
slider.addEventListener('input',updateWeight);updateWeight();
const routeData=[['01 — ACCUMULATE','Every swap starts something.','The hook collects fees in ETH. The vault converts ETH to USDG with an on-chain price safeguard.','Uniswap v4','Warchest vault'],['02 — GOVERN','Your conviction sets the course.','Daily snapshots freeze each holder’s lot-weighted influence. Holders vote on the eligible asset and direction.','Holder snapshots','Community decision'],['03 — EXECUTE','Collective intent. Defined limits.','After a valid vote, capital bridges through Across. A trading-only keeper executes on Hyperliquid; withdrawals require the multisig.','Across bridge','Hyperliquid']];
document.querySelectorAll('[data-route]').forEach(btn=>btn.addEventListener('click',()=>{const index=Number(btn.dataset.route);document.querySelectorAll('[data-route]').forEach(b=>{b.classList.toggle('active',b===btn);b.setAttribute('aria-pressed',String(b===btn));});['route-kicker','route-title','route-description','route-from','route-to'].forEach((id,i)=>document.getElementById(id).textContent=routeData[index][i]);if(globes[1].selectRoute)globes[1].selectRoute(index);else{globes[1].route=index;globes[1].draw();}}));
const menu=document.querySelector('.menu-toggle'),nav=document.querySelector('#navigation');function closeMenu(){menu.setAttribute('aria-expanded','false');menu.setAttribute('aria-label','Open menu');nav.classList.remove('open');}
menu.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'Close menu':'Open menu');nav.classList.toggle('open',open);});nav.querySelectorAll('a').forEach(a=>a.addEventListener('click',closeMenu));document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu();});
const pause=document.querySelector('#rotate-toggle');pause.addEventListener('click',()=>{globes[0].setPaused(!globes[0].paused);pause.setAttribute('aria-pressed',String(globes[0].paused));pause.setAttribute('aria-label',globes[0].paused?'Resume globe rotation':'Pause globe rotation');pause.textContent=globes[0].paused?'▷':'Ⅱ';});
document.querySelector('#zoom-in').addEventListener('click',()=>globes[0].setZoom(.1));document.querySelector('#zoom-out').addEventListener('click',()=>globes[0].setZoom(-.1));
const motionButton=document.querySelector('#motion-toggle');function setMotion(value){motion=value;document.documentElement.classList.toggle('no-motion',!motion);motionButton.textContent=`Motion: ${motion?'on':'off'}`;motionButton.setAttribute('aria-pressed',String(!motion));globes.forEach(g=>g.setMotion(motion));}
motionButton.addEventListener('click',()=>setMotion(!motion));reduced.addEventListener('change',e=>setMotion(!e.matches));setMotion(motion);
document.querySelector('#year').textContent=new Date().getFullYear();
