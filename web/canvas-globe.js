const TAU = Math.PI * 2;
const rad = Math.PI / 180;
let geography;
async function getGeography() {
  if (!geography) geography = fetch('assets/world.geojson').then(r => { if (!r.ok) throw new Error('Map unavailable'); return r.json(); }).then(data => {
    const rings = data.features.flatMap(f => f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map(p => p[0]));
    const points = [];
    const inside = (x,y,ring) => { let yes=false; for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes; };
    const bounds = rings.map(r => ({ring:r,minX:Math.min(...r.map(p=>p[0])),maxX:Math.max(...r.map(p=>p[0])),minY:Math.min(...r.map(p=>p[1])),maxY:Math.max(...r.map(p=>p[1]))}));
    for(let lat=-60;lat<82;lat+=1.65)for(let lon=-180;lon<180;lon+=1.65/Math.max(.3,Math.cos(lat*rad))){if(bounds.some(b=>lon>=b.minX&&lon<=b.maxX&&lat>=b.minY&&lat<=b.maxY&&inside(lon,lat,b.ring)))points.push([lon,lat]);}
    return {rings,points};
  }).catch(() => ({rings:[],points:[]}));
  return geography;
}
export class Globe {
  constructor(canvas,{light=false}={}) {
    this.canvas=canvas;this.ctx=canvas.getContext('2d');this.light=light;this.angle=-.25;this.zoom=1;this.paused=false;this.reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;this.visible=false;this.route=0;this.time=0;this.last=0;this.frame=0;
    this.observer=new IntersectionObserver(entries=>{this.visible=entries[0].isIntersecting;this.schedule();},{rootMargin:'60px'});this.observer.observe(canvas);
    this.resize=new ResizeObserver(()=>{this.size();this.draw();});this.resize.observe(canvas);
    this.visibility=()=>this.schedule();document.addEventListener('visibilitychange',this.visibility);
    this.size();getGeography().then(g=>{this.geo=g;this.draw();this.schedule();});
    if (!light) {
      let dragging=false, lastX=0;
      canvas.addEventListener('pointerdown',e=>{if(e.pointerType==='touch')return;dragging=true;lastX=e.clientX;canvas.setPointerCapture(e.pointerId);});
      canvas.addEventListener('pointermove',e=>{if(!dragging)return;this.angle+=(e.clientX-lastX)*.005;lastX=e.clientX;this.draw();});
      for (const event of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(event,()=>{dragging=false;});
    }
  }
  size(){const b=this.canvas.getBoundingClientRect();this.w=b.width;this.h=b.height;const dpr=Math.min(devicePixelRatio||1,2);this.canvas.width=Math.round(this.w*dpr);this.canvas.height=Math.round(this.h*dpr);this.ctx.setTransform(dpr,0,0,dpr,0,0);}
  schedule(){if(this.frame)return;if(this.visible&&!document.hidden&&!this.reduced&&!this.paused)this.frame=requestAnimationFrame(t=>this.tick(t));else this.draw();}
  tick(t){this.frame=0;const dt=this.last?Math.min(t-this.last,50):16;this.last=t;this.time+=dt*.001;this.angle+=dt*.000018;this.draw();this.schedule();}
  setPaused(v){this.paused=v;if(v){cancelAnimationFrame(this.frame);this.frame=0;}this.last=0;this.schedule();}
  setMotion(v){this.reduced=!v;if(!v){cancelAnimationFrame(this.frame);this.frame=0;}this.last=0;this.schedule();}
  setZoom(delta){this.zoom=Math.max(.8,Math.min(1.25,this.zoom+delta));this.draw();}
  project(lon,lat,scale=1){const a=lon*rad+this.angle,b=lat*rad;const x=Math.cos(b)*Math.sin(a),y=Math.sin(b),z=Math.cos(b)*Math.cos(a);const tilt=.18;return {x:this.cx+this.r*scale*x,y:this.cy-this.r*scale*(y*Math.cos(tilt)-z*Math.sin(tilt)),z:y*Math.sin(tilt)+z*Math.cos(tilt)};}
  line(points,color,width=1){const ctx=this.ctx;ctx.beginPath();let pen=false;for(const p of points){if(p.z>0){if(!pen)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);pen=true;}else pen=false;}ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}
  draw(){const ctx=this.ctx;if(!ctx||this.w<4||this.h<4)return;const {w,h,light}=this;ctx.clearRect(0,0,w,h);this.cx=w*.52;this.cy=h*.52;this.r=Math.min(w*.375,h*.375)*this.zoom;const {cx,cy,r}=this;
    if(!light){for(let i=0;i<110;i++){const x=((i*137.508+17)%1000)/1000*w,y=((i*273.12+91)%1000)/1000*h;ctx.fillStyle=`rgba(181,209,192,${.08+(i%4)*.05})`;ctx.fillRect(x,y,i%7===0?1.5:1,i%7===0?1.5:1);}}
    let glow=ctx.createRadialGradient(cx-r*.1,cy-r*.1,r*.5,cx,cy,r*1.45);glow.addColorStop(0,light?'#243bff00':'#a5c49a00');glow.addColorStop(.53,light?'#3c51ff14':'#a6c6a013');glow.addColorStop(1,light?'#243bff00':'#a5c49a00');ctx.fillStyle=glow;ctx.fillRect(0,0,w,h);
    // Orbital paths remain outside the geographical sphere.
    ctx.save();ctx.translate(cx,cy);ctx.rotate(-.37);ctx.beginPath();ctx.ellipse(0,0,r*1.19,r*.39,0,0,TAU);ctx.strokeStyle=light?'#6575ed28':'#9eb49b24';ctx.lineWidth=.7;ctx.stroke();ctx.restore();
    const surface=ctx.createRadialGradient(cx-r*.45,cy-r*.55,r*.05,cx+r*.3,cy+r*.2,r*1.45);surface.addColorStop(0,light?'#4a66ff':'#293b37');surface.addColorStop(.42,light?'#2043f4':'#152420');surface.addColorStop(.78,light?'#1530cd':'#09110f');surface.addColorStop(1,light?'#0e20a0':'#050b09');ctx.beginPath();ctx.arc(cx,cy,r,0,TAU);ctx.fillStyle=surface;ctx.fill();
    ctx.save();ctx.beginPath();ctx.arc(cx,cy,Math.max(0,r-.5),0,TAU);ctx.clip();
    // Fine latitude/longitude graticule gives the sphere a technical, spatial feel.
    for(let lat=-60;lat<=75;lat+=15){const pts=[];for(let lon=-180;lon<=180;lon+=3)pts.push(this.project(lon,lat));this.line(pts,light?'#d5ddff16':'#bacfaf12',.55);}
    for(let lon=-180;lon<180;lon+=20){const pts=[];for(let lat=-90;lat<=90;lat+=3)pts.push(this.project(lon,lat));this.line(pts,light?'#d5ddff16':'#bacfaf12',.55);}
    if(this.geo){for(const ring of this.geo.rings){if(ring.length<5)continue;this.line(ring.map(p=>this.project(...p)),light?'#c9d3ff90':'#b4c8a658',light?.65:.6);}for(const p of this.geo.points){const q=this.project(...p);if(q.z<0)continue;const alpha=(light?.52:.2)+q.z*(light?.26:.42);ctx.fillStyle=light?`rgba(220,230,255,${alpha})`:`rgba(181,203,163,${alpha})`;const dot=(light?.8:.85)*(r/260);ctx.fillRect(q.x,q.y,dot,dot);}}
    const shade=ctx.createLinearGradient(cx-r,cy-r,cx+r,cy+r);shade.addColorStop(0,'#00000000');shade.addColorStop(.65,'#00000000');shade.addColorStop(1,light?'#07157540':'#000000bb');ctx.fillStyle=shade;ctx.fillRect(cx-r,cy-r,r*2,r*2);ctx.restore();
    ctx.beginPath();ctx.arc(cx,cy,r,0,TAU);ctx.strokeStyle=light?'#8299ff70':'#c4dbb34d';ctx.lineWidth=.9;ctx.stroke();
    const routes=[ [[-74,40.7],[2.3,48.9]], [[2.3,48.9],[103.8,1.3]], [[-46,-23],[12.5,42]], [[-122,37],[139,35]], [[28,-26],[77,28]], [[-74,40],[28,-26]], [[2,49],[77,28]] ];
    routes.forEach(([a,b],i)=>{const points=[];for(let s=0;s<=70;s++){const f=s/70,lon=a[0]+(b[0]-a[0])*f,lat=a[1]+(b[1]-a[1])*f;points.push(this.project(lon,lat,1+Math.sin(f*Math.PI)*(.13+(i%3)*.06)));}this.line(points,light?'#dbe3ff7a':i%3===0?'#d8efaa99':'#8dbbb062',.8);const progress=(this.time*.11+i*.157+this.route*.12)%1;const p=points[Math.floor(progress*70)];if(p.z>.02){ctx.beginPath();ctx.arc(p.x,p.y,light?2.3:2,0,TAU);ctx.fillStyle=light?'#ffffff':'#e6ffc4';ctx.shadowColor=ctx.fillStyle;ctx.shadowBlur=12;ctx.fill();ctx.shadowBlur=0;}for(const coord of [a,b]){const p=this.project(...coord,1.007);if(p.z>.03){ctx.beginPath();ctx.arc(p.x,p.y,2,0,TAU);ctx.fillStyle=light?'#fff':'#d1eab5';ctx.fill();ctx.beginPath();ctx.arc(p.x,p.y,5+(Math.sin(this.time*1.7+i)+1)*2,0,TAU);ctx.strokeStyle=light?'#ffffff40':'#c5e7a440';ctx.lineWidth=.6;ctx.stroke();}}});
    // Broken outer instrument ring, with discreet ticks.
    if(!light){for(let i=0;i<90;i++){const a=i/90*TAU;ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*r*1.07,cy+Math.sin(a)*r*1.07);ctx.lineTo(cx+Math.cos(a)*r*(i%5===0?1.09:1.078),cy+Math.sin(a)*r*(i%5===0?1.09:1.078));ctx.strokeStyle=i%5===0?'#8ea18a50':'#8ea18a20';ctx.lineWidth=.7;ctx.stroke();}}
  }
}
