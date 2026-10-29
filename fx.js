/* Detune FX: music-reactive engine. Analyses the audio, publishes --bass/--mid/--treb/--beat to CSS, draws the waveform + embers. */
(()=>{"use strict";
const R=document.documentElement,$=id=>document.getElementById(id),reduce=matchMedia("(prefers-reduced-motion: reduce)").matches,lite=R.classList.contains("lite");
const FX=window.DetuneFX={analyser:null},S={bass:0,mid:0,treb:0,beat:0,avg:0,last:0},N=lite?48:96,sm=new Float32Array(N),pk=new Float32Array(N);
let fd,td,raf=0;
const em=document.createElement("canvas");em.className="embers";em.setAttribute("aria-hidden","true");document.body.prepend(em);
const ec=em.getContext("2d"),P=[],fit=()=>{em.width=lite?1:innerWidth;em.height=lite?1:innerHeight};fit();addEventListener("resize",fit);
const spawn=n=>{if(lite)return;for(let i=0;i<n&&P.length<160;i++)P.push({x:Math.random()*em.width,y:em.height+8,vx:(Math.random()-.5)*.7,vy:-(.5+Math.random()*1.5)*(1+S.bass*1.5),r:1+Math.random()*2.4,a:1,ph:Math.random()*6.28})};
const norm=x=>Math.min(1,Math.max(0,(x-.28)/.55)),env=(k,v)=>S[k]=v>S[k]?v:S[k]*.88+v*.12,ranges=[...document.querySelectorAll(".range,.progress")];
function tick(t){raf=0;if(document.hidden)return;raf=requestAnimationFrame(tick);if(lite&&t-(tick.l||0)<32)return;tick.l=t;
 const an=FX.analyser,playing=R.classList.contains("is-playing");let b=0,m=0,h=0,hz=1;
 if(an){const n=an.frequencyBinCount;if(!fd||fd.length!==n){fd=new Uint8Array(n);td=new Uint8Array(an.fftSize)}an.getByteFrequencyData(fd);an.getByteTimeDomainData(td);hz=an.context.sampleRate/an.fftSize;
  const band=(lo,hi)=>{let s=0,c=0;for(let i=Math.max(1,lo/hz|0),e=Math.min(n-1,hi/hz|0);i<=e;i++){s+=fd[i];c++}return c?s/c/255:0};b=band(30,150);m=band(300,2500);h=band(4000,14000)}
 b=norm(b);m=norm(m);h=norm(h);env("bass",b);env("mid",m);env("treb",h);
 S.avg=S.avg*.93+b*.07;if(b>.35&&b>S.avg*1.2&&t-S.last>240){S.beat=1;S.last=t;if(!reduce)spawn(10)}S.beat*=.9;
 if(!reduce&&!lite)for(const k of["bass","mid","treb","beat"])R.style.setProperty("--"+k,S[k].toFixed(3));
 /* waveform: log-spaced mirrored spectrum + live oscilloscope line + falling peak caps */
 const cv=$("visual"),r=cv.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,lite?1.5:2),w=Math.max(1,r.width*dpr|0),H=Math.max(1,r.height*dpr|0);
 if(cv.width!==w||cv.height!==H){cv.width=w;cv.height=H}
 const c=cv.getContext("2d"),mid=H/2,amp=H*.46,idle=S.bass+S.mid+S.treb<.03&&!playing;c.clearRect(0,0,w,H);
 for(let i=0;i<N;i++){let v=0;if(fd){const f=x=>Math.floor(40*Math.pow(400,x/N)/hz),lo=f(i),hi=Math.max(lo+1,f(i+1));let s=0,k=0;for(let j=lo;j<hi&&j<fd.length;j++){s+=fd[j];k++}v=k?Math.pow(s/k/255,1.4)*(1+i/N*.7):0}
  if(idle)v=.05+.04*Math.sin(i*.3+t/400)*Math.sin(t/1700+i*.05);sm[i]+=(v-sm[i])*(v>sm[i]?.55:.18);pk[i]=Math.max(sm[i],pk[i]-.006)}
 const X=i=>i*w/(N-1),Y=(i,sg)=>mid-sg*Math.min(1,sm[i])*amp;
 for(const sg of[1,-1]){c.beginPath();c.moveTo(0,mid);for(let i=0;i<N;i++){const x=X(i),y=Y(i,sg);if(!i)c.lineTo(x,y);else c.quadraticCurveTo(X(i-1),Y(i-1,sg),(X(i-1)+x)/2,(Y(i-1,sg)+y)/2)}c.lineTo(w,mid);c.closePath();
  const g=c.createLinearGradient(0,mid,0,mid-sg*amp);g.addColorStop(0,"rgba(120,8,20,.85)");g.addColorStop(.6,"rgba(220,30,48,.9)");g.addColorStop(1,"rgba(255,170,160,.95)");
  c.globalAlpha=sg>0?1:.38;c.fillStyle=g;c.shadowColor="rgba(255,40,60,.9)";c.shadowBlur=lite?0:(6+S.beat*22)*dpr;c.fill()}
 c.globalAlpha=1;c.shadowBlur=0;c.fillStyle="rgba(255,225,220,.9)";
 for(let i=0;i<N;i+=2){const y=Math.min(1,pk[i])*amp;c.fillRect(X(i)-dpr,mid-y-2*dpr,2*dpr,1.6*dpr);c.globalAlpha=.35;c.fillRect(X(i)-dpr,mid+y+.5*dpr,2*dpr,1.6*dpr);c.globalAlpha=1}
 c.beginPath();const M=Math.min(180,w/3|0);for(let k=0;k<M;k++){const y=mid+(td?(td[(k/(M-1)*(td.length-1))|0]-128)/128:0)*amp*.55;k?c.lineTo(k/(M-1)*w,y):c.moveTo(0,y)}
 c.lineWidth=1.4*dpr;c.strokeStyle="rgba(255,235,232,.8)";c.shadowColor="#ff2a40";c.shadowBlur=lite?0:8*dpr;c.stroke();c.shadowBlur=0;
 /* embers */
 ec.clearRect(0,0,em.width,em.height);ec.globalCompositeOperation="lighter";if(!reduce&&Math.random()<(playing?.2+S.bass*.8:.04))spawn(1);
 for(let i=P.length-1;i>=0;i--){const p=P[i];p.ph+=.03;p.x+=p.vx+Math.sin(p.ph)*.4;p.y+=p.vy;p.a-=.0035;if(p.a<=0||p.y<-10){P.splice(i,1);continue}ec.fillStyle=`rgba(255,${70+p.a*90|0},70,${p.a*.75})`;ec.beginPath();ec.arc(p.x,p.y,p.r*(1+S.treb),0,6.283);ec.fill()}
 for(const g of ranges){const p=((g.value-g.min)/(g.max-g.min)*100).toFixed(1);if(g._p!==p){g._p=p;g.style.setProperty("--p",p+"%")}}}
const go=()=>{if(!raf&&!document.hidden)raf=requestAnimationFrame(tick)};document.addEventListener("visibilitychange",go);go();

/* ---- UX layer ---- */
const a=$("audio"),list=$("trackList"),pl=document.querySelector(".player");
a.addEventListener("play",()=>R.classList.add("is-playing"));a.addEventListener("pause",()=>R.classList.remove("is-playing"));
new MutationObserver(()=>{const t=$("title").textContent,ar=$("artist").textContent;document.title=a.paused&&t==="Nothing playing"?"Detune — a quieter kind of listening":`${t} · ${ar} — Detune`}).observe($("title"),{childList:true,characterData:true,subtree:true});
new MutationObserver(()=>{[...list.children].forEach((li,i)=>li.style.setProperty("--i",Math.min(i,14)));const act=list.querySelector(".active");if(act){const lr=list.getBoundingClientRect(),ar=act.getBoundingClientRect();if(ar.top<lr.top||ar.bottom>lr.bottom)list.scrollTop+=ar.top-lr.top-(lr.height-ar.height)/2}}).observe(list,{childList:true});
document.addEventListener("pointermove",e=>{if(lite)return;const g=e.target.closest&&e.target.closest(".glass");if(g){const r=g.getBoundingClientRect();g.style.setProperty("--mx",e.clientX-r.left+"px");g.style.setProperty("--my",e.clientY-r.top+"px")}},{passive:true});
document.addEventListener("pointerdown",e=>{if(lite)return;const b=e.target.closest&&e.target.closest("button");if(!b||b.disabled)return;const r=b.getBoundingClientRect(),s=Math.max(r.width,r.height)*2.2,d=document.createElement("span");d.className="rip";d.style.cssText=`left:${e.clientX-r.left}px;top:${e.clientY-r.top}px;width:${s}px;height:${s}px`;b.append(d);setTimeout(()=>d.remove(),650)});
if(!reduce&&!lite){pl.addEventListener("pointermove",e=>{const r=pl.getBoundingClientRect();pl.style.setProperty("--ry",((e.clientX-r.left)/r.width-.5)*6+"deg");pl.style.setProperty("--rx",(.5-(e.clientY-r.top)/r.height)*5+"deg")});pl.addEventListener("pointerleave",()=>{pl.style.setProperty("--rx","0deg");pl.style.setProperty("--ry","0deg")})}
/* drop files anywhere */
const veil=document.createElement("div");veil.className="veil";veil.innerHTML="<span>Release to add songs</span>";document.body.append(veil);let dc=0;const hasF=e=>e.dataTransfer&&[...e.dataTransfer.types].includes("Files");
addEventListener("dragenter",e=>{if(hasF(e)){dc++;veil.classList.add("on")}});addEventListener("dragleave",e=>{if(hasF(e)&&--dc<=0){dc=0;veil.classList.remove("on")}});addEventListener("dragover",e=>{if(hasF(e))e.preventDefault()});
addEventListener("drop",e=>{if(!hasF(e))return;e.preventDefault();dc=0;veil.classList.remove("on");if(e.target.closest&&e.target.closest("#drop"))return;const dt=new DataTransfer();[...e.dataTransfer.files].forEach(f=>dt.items.add(f));$("files").files=dt.files;$("files").dispatchEvent(new Event("change"))});
/* volume keys + visible shortcuts button */
document.addEventListener("keydown",e=>{if(e.target.matches("input,textarea,select")||e.ctrlKey||e.metaKey||e.altKey)return;if(e.key==="ArrowUp"||e.key==="ArrowDown"){e.preventDefault();const v=$("volume");v.value=Math.min(1,Math.max(0,+v.value+(e.key==="ArrowUp"?.05:-.05)));v.dispatchEvent(new Event("input"))}else if(e.key==="Escape")$("closeShortcuts").click()});
$("shortcuts").querySelector("ul").insertAdjacentHTML("beforeend","<li><b>↑ / ↓</b> — volume</li><li><b>?</b> — this help</li>");
const hb=document.createElement("button");hb.className="helpbtn";hb.textContent="?";hb.title="Keyboard shortcuts (?)";hb.setAttribute("aria-label","Keyboard shortcuts");hb.onclick=()=>$("shortcuts").classList.add("open");document.body.append(hb);
})();
