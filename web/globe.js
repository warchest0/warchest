import { Globe as CanvasGlobe } from './canvas-globe.js';
const vertex=`attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}`;
const fragment=`
precision highp float;
uniform vec2 resolution;
uniform vec2 center;
uniform float radius;
uniform float angle;
uniform float time;
uniform float lightMode;
uniform sampler2D earth;
uniform sampler2D land;
const float PI=3.14159265359;
vec3 rotate(vec3 p){float c=cos(angle),s=sin(angle);return vec3(p.x*c+p.z*s,p.y,-p.x*s+p.z*c);}
void main(){
 vec2 pos=vec2(gl_FragCoord.x,resolution.y-gl_FragCoord.y);
 vec2 q=(pos-center)/radius;float d=length(q);
 vec3 col=vec3(0.);float alpha=0.;
 if(d>1.){
   float halo=exp(-(d-1.)*48.)*.5+exp(-(d-1.)*10.)*.065;
   col=mix(vec3(.48,.65,.95),vec3(.31,.4,1.),lightMode);
   alpha=halo*(lightMode>.5?.34:.75);
 }else{
   vec3 n=vec3(q.x,-q.y,sqrt(max(0.,1.-dot(q,q))));
   vec3 world=rotate(n);
   vec2 uv=vec2(atan(world.z,world.x)/(2.*PI)+.5,asin(world.y)/PI+.5);
   vec3 tex=texture2D(earth,vec2(uv.x,1.-uv.y)).rgb;
   float day=max(0.,dot(n,normalize(vec3(-.55,.72,.5))));
   float rim=pow(1.-n.z,4.);
   if(lightMode<.5){
     float gray=dot(tex,vec3(.3,.59,.11));
     col=mix(tex,vec3(gray),.65)*vec3(.52,.68,.88)*(.09+day*.82);
     col+=vec3(.39,.58,.85)*rim*(.1+day*.75);
     col*=smoothstep(-.5,.75,n.y)*.8+.2;
   }else{
     float continents=texture2D(land,vec2(uv.x,1.-uv.y)).r;
     vec2 grid=fract(uv*vec2(290.,145.))-.5;
     float dots=1.-smoothstep(.12,.24,length(grid));
     col=mix(vec3(.065,.15,.89),vec3(.24,.38,1.),day);
     col+=vec3(.48,.55,.65)*continents*dots*(.4+.6*n.z);
     float lat=abs(sin(uv.y*PI*12.));float lon=abs(sin(uv.x*PI*24.));
     col+=vec3(.15,.22,.34)*(1.-smoothstep(.005,.022,min(lat,lon)))*.22;
     col+=vec3(.15,.23,.5)*rim;
     // Three inclined great-circle routes; moving pulses interpolate continuously.
     for(int i=0;i<3;i++){
       float fi=float(i);vec3 axis=normalize(vec3(.3+fi*.25,.8-fi*.3,.65));
       float dist=abs(dot(world,axis)-.15);
       float line=1.-smoothstep(.001,.004,dist);
       float travel=fract(uv.x+uv.y*.25-time*.025-fi*.31);
       float pulse=exp(-travel*65.)*line;
       col+=vec3(.6,.73,1.)*(line*.24+pulse*.8);
     }
   }
   alpha=1.;
 }
 gl_FragColor=vec4(col,alpha);
}`;
function shader(gl,type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
let landMap;
async function mapTexture(){
 if(!landMap)landMap=fetch('assets/world.geojson').then(r=>r.json()).then(data=>{
   const canvas=document.createElement('canvas');canvas.width=2048;canvas.height=1024;const ctx=canvas.getContext('2d');ctx.fillStyle='#000';ctx.fillRect(0,0,2048,1024);ctx.fillStyle='#fff';
   for(const f of data.features){const polygons=f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates;for(const poly of polygons){ctx.beginPath();for(const ring of poly){ring.forEach(([lon,lat],i)=>{const x=(lon+180)/360*2048,y=(90-lat)/180*1024;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.closePath();}ctx.fill('evenodd');}}
   return canvas;
 }).catch(()=>null);
 return landMap;
}
export class Globe {
 constructor(canvas,{light=false}={}){
  const gl=canvas.getContext('webgl',{alpha:true,antialias:false,premultipliedAlpha:false,powerPreference:'low-power'});
  if(!gl)return new CanvasGlobe(canvas,{light});
  this.canvas=canvas;this.gl=gl;this.light=light;this.angle=2.4;this.targetAngle=2.4;this.zoom=1;this.targetZoom=1;this.route=0;this.paused=false;this.reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;this.visible=false;this.frame=0;this.time=0;this.last=0;this.lost=false;
  const program=gl.createProgram();gl.attachShader(program,shader(gl,gl.VERTEX_SHADER,vertex));gl.attachShader(program,shader(gl,gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);this.program=program;
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
  this.uniforms=Object.fromEntries(['resolution','center','radius','angle','time','lightMode','earth','land'].map(k=>[k,gl.getUniformLocation(program,k)]));
  this.textures=[0,1].map(i=>{gl.activeTexture(gl.TEXTURE0+i);const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([30,40,60,255]));gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return t;});
  gl.uniform1i(this.uniforms.earth,0);gl.uniform1i(this.uniforms.land,1);gl.uniform1f(this.uniforms.lightMode,light?1:0);
  const photo=new Image();photo.onload=()=>this.upload(photo,0);photo.src='assets/earth.jpg';if(light)mapTexture().then(map=>{if(map)this.upload(map,1);});
  this.resize=new ResizeObserver(()=>{this.size();this.draw();});this.resize.observe(canvas);this.observer=new IntersectionObserver(([entry])=>{this.visible=entry.isIntersecting;this.sync();},{rootMargin:'30px'});this.observer.observe(canvas);document.addEventListener('visibilitychange',()=>this.sync());
  canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();this.lost=true;cancelAnimationFrame(this.frame);this.frame=0;canvas.style.opacity='0';canvas.parentElement.classList.add('scene-fallback');});
  // Keep a static scene if the browser loses its GPU context.
  let drag=false,x=0;canvas.addEventListener('pointerdown',e=>{if(e.pointerType==='touch')return;drag=true;x=e.clientX;canvas.setPointerCapture(e.pointerId);});canvas.addEventListener('pointermove',e=>{if(!drag)return;this.targetAngle+=(e.clientX-x)*.004;x=e.clientX;if(this.paused||this.reduced){this.angle=this.targetAngle;this.draw();}});for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,()=>drag=false);
  this.size();this.draw();
 }
 upload(source,i){const gl=this.gl;if(this.lost)return;gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,this.textures[i]);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);this.draw();}
 size(){const box=this.canvas.getBoundingClientRect();this.w=box.width;this.h=box.height;this.dpr=Math.min(devicePixelRatio||1,this.w<650?1.25:1.5);this.canvas.width=Math.max(1,Math.round(this.w*this.dpr));this.canvas.height=Math.max(1,Math.round(this.h*this.dpr));this.gl.viewport(0,0,this.canvas.width,this.canvas.height);}
 sync(){if(this.frame){cancelAnimationFrame(this.frame);this.frame=0;}this.last=0;if(this.visible&&!document.hidden&&!this.reduced&&!this.paused&&!this.lost)this.frame=requestAnimationFrame(t=>this.tick(t));else this.draw();}
 tick(t){this.frame=0;if(!this.visible||document.hidden||this.reduced||this.paused||this.lost)return;const dt=this.last?Math.min(t-this.last,50):16;this.last=t;this.time+=dt*.001;this.targetAngle+=dt*.000014;const ease=1-Math.exp(-dt*.006);this.angle+=(this.targetAngle-this.angle)*ease;this.zoom+=(this.targetZoom-this.zoom)*ease;this.draw();this.frame=requestAnimationFrame(t=>this.tick(t));}
 draw(){if(this.lost||this.w<4||this.h<4)return;const gl=this.gl,w=this.canvas.width,h=this.canvas.height;gl.useProgram(this.program);gl.uniform2f(this.uniforms.resolution,w,h);gl.uniform2f(this.uniforms.center,w*.5,h*(this.light?.51:(this.w<800?1.35:1.5)));gl.uniform1f(this.uniforms.radius,(this.light?Math.min(w*.46,h*.46):Math.max(w*.68,h*.9))*this.zoom);gl.uniform1f(this.uniforms.angle,this.angle);gl.uniform1f(this.uniforms.time,this.time);gl.drawArrays(gl.TRIANGLES,0,6);}
 setPaused(v){this.paused=v;this.sync();}
 setMotion(v){this.reduced=!v;this.sync();}
 setZoom(delta){this.targetZoom=Math.max(.85,Math.min(1.15,this.targetZoom+delta));if(this.paused||this.reduced){this.zoom=this.targetZoom;this.draw();}}
 selectRoute(index){this.route=index;this.targetAngle+=.4;if(this.reduced||this.paused){this.angle=this.targetAngle;this.draw();}}
}
