const fs=require('fs');global.sampleRate=48000;let P;
global.AudioWorkletProcessor=class{};global.registerProcessor=(n,c)=>{P=c};
eval(fs.readFileSync(__dirname+'/../pitch-worklet.js','utf8'));
function fftPeak(x,sr){const N=1<<15;const s=x.slice(x.length-N);const re=new Float64Array(N),im=new Float64Array(N);
 for(let i=0;i<N;i++)re[i]=s[i]*(0.5-0.5*Math.cos(2*Math.PI*i/N));
 for(let i=1,j=0;i<N;i++){let b=N>>1;for(;j&b;b>>=1)j^=b;j^=b;if(i<j){[re[i],re[j]]=[re[j],re[i]]}}
 for(let l=2;l<=N;l<<=1){const a=-2*Math.PI/l;for(let i=0;i<N;i+=l)for(let k=0;k<l/2;k++){const wr=Math.cos(a*k),wi=Math.sin(a*k);const u=i+k,v=i+k+l/2;const xr=re[v]*wr-im[v]*wi,xi=re[v]*wi+im[v]*wr;re[v]=re[u]-xr;im[v]=im[u]-xi;re[u]+=xr;im[u]+=xi}}
 let m=0,mi=0;for(let i=1;i<N/2;i++){const v=Math.hypot(re[i],im[i]);if(v>m){m=v;mi=i}}
 const y0=Math.hypot(re[mi-1],im[mi-1]),y1=m,y2=Math.hypot(re[mi+1],im[mi+1]);const d=0.5*(y0-y2)/(y0-2*y1+y2);return (mi+d)*sr/N}
function run(fL,fR,cents,secs=3,changes){const p=new P();const n=Math.floor(sampleRate*secs/128)*128;const L=new Float32Array(n),R=new Float32Array(n);let bad=0,exact=true;
 for(let o=0;o<n;o+=128){const il=new Float32Array(128),ir=new Float32Array(128);for(let i=0;i<128;i++){il[i]=0.5*Math.sin(2*Math.PI*fL*(o+i)/sampleRate);ir[i]=0.5*Math.sin(2*Math.PI*fR*(o+i)/sampleRate)}
  const c=changes?changes(o/sampleRate):cents;const ol=new Float32Array(128),or=new Float32Array(128);p.process([[il,ir]],[[ol,or]],{cents:[c]});
  for(let i=0;i<128;i++){L[o+i]=ol[i];R[o+i]=or[i];if(!isFinite(ol[i])||!isFinite(or[i])||Math.abs(ol[i])>1)bad++;if(cents===0&&!changes&&(ol[i]!==il[i]||or[i]!==ir[i]))exact=false}}
 return{L,R,bad,exact,n}}
const rows=[];
for(const [f,c] of [[440,0],[440,100],[440,-100],[440,1200],[440,-1200],[1000,100],[1000,-1200],[1000,1200]]){
 const r=run(f,f,c);const exp=f*Math.pow(2,c/1200);const got=fftPeak(r.L,sampleRate);
 rows.push(`${f}Hz ${String(c).padStart(5)}c  expect ${exp.toFixed(1)}  got ${got.toFixed(1)}  err ${(1200*Math.log2(got/exp)).toFixed(1)}c  samples out=${r.n} in=${r.n}  bad=${r.bad}${c===0?'  bit-exact='+r.exact:''}`)}
console.log(rows.join('\n'));
// stereo: L=440, R=1000, +300 cents
const s=run(440,1000,300);console.log('stereo +300c  L',fftPeak(s.L,sampleRate).toFixed(1),'(exp',(440*2**.25).toFixed(1)+')  R',fftPeak(s.R,sampleRate).toFixed(1),'(exp',(1000*2**.25).toFixed(1)+')');
// rapid changes
const rc=run(440,440,0,6,t=>Math.round(Math.sin(t*40)*1200));console.log('rapid changes bad samples:',rc.bad);
// return to 0
const rz=run(440,440,0,6,t=>t<2?500:0);console.log('after reset to 0: peak',fftPeak(rz.L,sampleRate).toFixed(2),'Hz (exp 440)');
