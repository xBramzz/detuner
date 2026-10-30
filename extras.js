/* Detune extras: album-cover colour theme + lyrics (LRC / plain text). Standalone; only reads the DOM and the <audio> element. */
(()=>{"use strict";
const $=id=>document.getElementById(id),R=document.documentElement,a=$("audio"),lite=R.classList.contains("lite");
const LS={get:k=>{try{return localStorage.getItem(k)}catch{return null}},set:k=>v=>{try{localStorage.setItem(k,v);return true}catch{return false}},del:k=>{try{localStorage.removeItem(k)}catch{}}};
function note(m){const t=$("toast");t.textContent=m;t.style.display="block";clearTimeout(note.t);note.t=setTimeout(()=>t.style.display="none",3000)}
/* ---------- cover theme ---------- */
const tb=$("themeBtn"),S=R.style;let on=LS.get("detune-cover-theme")==="1";
function dominant(img){const c=document.createElement("canvas");c.width=c.height=32;const x=c.getContext("2d",{willReadFrequently:true});x.drawImage(img,0,0,32,32);const d=x.getImageData(0,0,32,32).data,bins=new Float32Array(36);let tw=0,ts=0;
 for(let i=0;i<d.length;i+=4){const r=d[i]/255,g=d[i+1]/255,b=d[i+2]/255,mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=(mx+mn)/2,df=mx-mn;if(df<.08)continue;
  let h=mx===r?((g-b)/df)%6:mx===g?(b-r)/df+2:(r-g)/df+4;h=(h*60+360)%360;const w=df*(1-Math.abs(2*l-1))+.001;bins[(h/10)|0]+=w;tw+=w;ts+=w*df/(1-Math.abs(2*l-1)+.001)}
 if(tw<1)return null;let p=0;for(let i=1;i<36;i++)if(bins[i]>bins[p])p=i;return{h:p*10+5,s:Math.min(1,ts/tw)}}
const hsl=(h,s,l)=>`hsl(${((h%360)+360)%360|0} ${Math.round(Math.min(1,s)*100)}% ${Math.round(Math.min(1,l)*100)}%)`;
const POOL_KEYS=["--blood","--blood-hi","--blood-dk","--accent","--focus","--edge","--ink","--muted","--glass","--pool0","--pool1","--pool2","--moon","--fog","--grad-a","--grad-b","--thumb-a","--edge-soft","--tint-soft","--glow","--glow-hi"];
/* Retint via CSS custom properties instead of hue-rotating the DOM (which smeared text and
   forced the fixed blood pool to stay red). The pool reads --pool0/1/2 in index.html. */
function setTheme(h,s){
  S.setProperty("--blood",hsl(h,.78,.30));S.setProperty("--blood-hi",hsl(h,.92,.56));S.setProperty("--blood-dk",hsl(h,.82,.13));
  S.setProperty("--accent",hsl(h,.78,.26));S.setProperty("--focus",hsl(h,.88,.68));
  S.setProperty("--edge",hsl(h,.72,.62)+" / .2");S.setProperty("--ink",hsl(h,.28,.94));S.setProperty("--muted",hsl(h,.24,.64));
  S.setProperty("--glass",hsl(h,.55,.09)+" / .62");S.setProperty("--pool0",hsl(h,.72,.42));S.setProperty("--pool1",hsl(h,.78,.26));S.setProperty("--pool2",hsl(h,.7,.09));
  S.setProperty("--moon",hsl(h,.8,.5));S.setProperty("--fog",hsl(h,.75,.24));
  S.setProperty("--grad-a",hsl(h,.55,.95));S.setProperty("--grad-b",hsl(h,.9,.6));
  S.setProperty("--thumb-a",hsl(h,.85,.78));S.setProperty("--edge-soft",hsl(h,.7,.6)+" / .18");
  S.setProperty("--tint-soft",hsl(h,.8,.45)+" / .25");S.setProperty("--glow",hsl(h,.8,.5)+" / .4");S.setProperty("--glow-hi",hsl(h,.9,.6)+" / .8");
}
function clearTheme(){for(const k of POOL_KEYS)S.removeProperty(k)}
function sync(){tb.setAttribute("aria-pressed",on);if(!on){R.classList.remove("cover-theme");clearTheme();return}
 const img=$("cover").querySelector("img");if(!img){clearTheme();R.classList.remove("cover-theme");return}
 const go=()=>{try{const r=dominant(img);if(!r)setTheme(355,.15);else setTheme(r.h,Math.max(.35,Math.min(1.1,r.s/.7)));R.classList.add("cover-theme")}catch(e){console.warn("Cover colour failed",e)}};
 img.complete&&img.naturalWidth?go():img.addEventListener("load",go,{once:true})}
tb.onclick=()=>{on=!on;LS.set("detune-cover-theme")(on?"1":"0");sync();note(on?"Colours now follow the album cover.":"Classic blood-red theme.")};
new MutationObserver(sync).observe($("cover"),{childList:true});sync();
/* ---------- lyrics ---------- */
const P=$("lyrics"),B=$("lyrBody"),EB=$("lyrEditBox"),TX=$("lyrText");let lines=[],synced=false,idx=-1,raw="",hold=0;
const key=()=>"detune-lyr:"+$("title").textContent+"|"+$("artist").textContent,hasTrack=()=>$("title").textContent!=="Nothing playing";
function parse(txt){txt=String(txt).replace(/\r/g,"");const out=[],tre=/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;let off=0,any=false;
 for(const ln of txt.split("\n")){const om=ln.match(/^\[offset:\s*(-?\d+)\]/i);if(om){off=+om[1]/1000;continue}if(/^\[[a-z]{2,6}:[^\]]*\]\s*$/i.test(ln))continue;
  const times=[];let m;tre.lastIndex=0;while((m=tre.exec(ln)))times.push(+m[1]*60+ +m[2]+(m[3]?+("0."+m[3]):0));
  const s=ln.replace(tre,"").replace(/<\d+:\d+(?:\.\d+)?>/g,"").trim();if(times.length){any=true;for(const t of times)out.push({t:Math.max(0,t+off),s})}else out.push({t:null,s})}
 return any?{synced:true,lines:out.filter(l=>l.t!==null).sort((x,y)=>x.t-y.t)}:{synced:false,lines:out}}
function render(){B.replaceChildren();idx=-1;
 if(!lines.length){const e=document.createElement("div");e.className="lyrempty";e.innerHTML='<i class="fa-solid fa-microphone-lines"></i><p>No lyrics for this track yet.</p><span>Import a .lrc or .txt file, or use the pen to paste the text.</span>';B.append(e);return}
 const f=document.createDocumentFragment();lines.forEach((l,i)=>{const p=document.createElement("p");p.className="lyr"+(synced?" syn":"")+(l.s?"":" gap");p.textContent=l.s||"♪";if(synced){p.tabIndex=0;p.dataset.i=i}f.append(p)});B.append(f);tick(true)}
function load(){raw=LS.get(key())||"";const r=raw?parse(raw):{synced:false,lines:[]};lines=r.lines;synced=r.synced;$("lyrTitle").textContent=hasTrack()?$("title").textContent:"Lyrics";render()}
function tick(force){if(!synced||!lines.length)return;const t=a.currentTime+.15;let i=-1;for(let k=0;k<lines.length;k++){if(lines[k].t<=t)i=k;else break}
 if(i===idx&&!force)return;B.children[idx]?.classList.remove("on");idx=i;const el=B.children[i];if(!el)return;el.classList.add("on");
 if(!P.hidden&&Date.now()>hold)B.scrollTo({top:el.offsetTop-B.clientHeight/2+el.clientHeight/2,behavior:lite||force?"auto":"smooth"})}
a.addEventListener("timeupdate",()=>tick());a.addEventListener("seeked",()=>tick(true));
for(const ev of["wheel","touchmove"])B.addEventListener(ev,()=>hold=Date.now()+3500,{passive:true});
B.addEventListener("click",e=>{const p=e.target.closest(".syn");if(p){a.currentTime=lines[+p.dataset.i].t;hold=0}});
B.addEventListener("keydown",e=>{if(e.key==="Enter"&&e.target.classList.contains("syn"))e.target.click()});
let dt=0;new MutationObserver(()=>{clearTimeout(dt);dt=setTimeout(load,60)}).observe($("title"),{childList:true,characterData:true,subtree:true});
new MutationObserver(()=>{clearTimeout(dt);dt=setTimeout(load,60)}).observe($("artist"),{childList:true,characterData:true,subtree:true});
function save(txt){if(!hasTrack())return note("Pick a track first.");if(!txt.trim()){LS.del(key());load();return}if(!LS.set(key())(txt))return note("Browser storage is full. Could not save the lyrics.");load();note(synced?"Synced lyrics saved. Click a line to jump to it.":"Lyrics saved.")}
function open(v){P.hidden=!v;$("lyricsBtn").setAttribute("aria-expanded",v);if(v){load();setTimeout(()=>tick(true),30)}else edit(false)}
function edit(v){EB.hidden=!v;B.hidden=v;if(v){TX.value=raw;TX.focus()}}
$("lyricsBtn").onclick=()=>open(P.hidden);$("lyrClose").onclick=()=>open(false);$("lyrEdit").onclick=()=>{if(!hasTrack())return note("Pick a track first.");edit(EB.hidden)};
$("lyrCancel").onclick=()=>edit(false);$("lyrSave").onclick=()=>{save(TX.value);edit(false)};
$("lyrClear").onclick=()=>{if(raw&&confirm("Remove the lyrics for this track?"))save("")};
$("lyrImport").onclick=()=>hasTrack()?$("lyrFile").click():note("Pick a track first.");
$("lyrFile").onchange=async e=>{const f=e.target.files[0];e.target.value="";if(!f)return;if(f.size>1048576)return note("That file is too large for lyrics (max 1 MB).");try{save(await f.text())}catch{note("Could not read that file.")}};
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!P.hidden){open(false);return}if(e.target.matches("input,textarea,select")||e.ctrlKey||e.metaKey||e.altKey)return;if(e.key.toLowerCase()==="l")open(P.hidden)});
$("shortcuts").querySelector("ul").insertAdjacentHTML("beforeend","<li><b>L</b> — lyrics</li>");
load();
})();
