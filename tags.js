/* Detune tag reader: ID3v2.2/2.3/2.4, ID3v1, WAV INFO/id3 chunks, then filename fallback ("Artist - Title [yt-id]"). No dependencies. */
(()=>{"use strict";
const T=(b,e)=>{try{let l="windows-1252";if(e===1)l=b[0]===254&&b[1]===255?"utf-16be":"utf-16le";else if(e===2)l="utf-16be";else if(e===3)l="utf-8";return new TextDecoder(l).decode(b)}catch{return""}};
const z=s=>s.replace(/\0+$/,"").replace(/\0/g,", ").trim(), ss=(b,o)=>(b[o]<<21)|(b[o+1]<<14)|(b[o+2]<<7)|b[o+3], S4=(b,o)=>((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
const term=(b,i,e)=>{if(e===1||e===2){for(;i+1<b.length;i+=2)if(!b[i]&&!b[i+1])return i+2;return b.length}while(i<b.length&&b[i])i++;return i+1};
const sniff=(d,f)=>d[0]===255&&d[1]===216?"image/jpeg":d[0]===137&&d[1]===80?"image/png":d[0]===71&&d[1]===73?"image/gif":/^image\//.test(f||"")?f:"image/jpeg";
function id3(b){const out={};if(b[0]!==73||b[1]!==68||b[2]!==51)return out;const v=b[3],fl=b[5];let end=Math.min(b.length,10+ss(b,6)),p=10;
 if(v<4&&fl&128){const u=new Uint8Array(end);u.set(b.subarray(0,10));let n=10;for(let i=10;i<end;i++){u[n++]=b[i];if(b[i]===255&&b[i+1]===0)i++}b=u;end=n}
 if(fl&64)p+=v===4?ss(b,10):4+S4(b,10);
 const hl=v===2?6:10,K={TIT2:"title",TT2:"title",TPE1:"artist",TP1:"artist",TALB:"album",TAL:"album",TPE2:"aart",TP2:"aart"};
 while(p+hl<=end){const id=String.fromCharCode(...b.subarray(p,p+(v===2?3:4)));if(!/^[A-Z0-9]{3,4}$/.test(id))break;
  const sz=v===2?(b[p+3]<<16|b[p+4]<<8|b[p+5]):v===4?ss(b,p+4):S4(b,p+4);let d=b.subarray(p+hl,p+hl+sz);p+=hl+sz;if(!sz)continue;if(v===4&&(b[p-sz-1]&1))d=d.subarray(4);
  const e=d[0],k=K[id];
  if(k&&!out[k]){const s=z(T(d.subarray(1),e));if(s)out[k]=s}
  else if((id==="APIC"||id==="PIC")&&!out.picture){let i,mime;if(id==="PIC"){mime="image/"+T(d.subarray(1,4),0).toLowerCase();i=4}else{let j=1;while(j<d.length&&d[j])j++;mime=T(d.subarray(1,j),0);i=j+1}i=term(d,i+1,e);const data=d.subarray(i);if(data.length>100)out.picture={data,format:sniff(data,mime)}}}
 if(!out.artist&&out.aart)out.artist=out.aart;return out}
function v1(b){if(b.length<128)return{};const o=b.length-128;if(b[o]!==84||b[o+1]!==65||b[o+2]!==71)return{};const g=(a,n)=>T(b.subarray(o+a,o+a+n),0).replace(/\0[\s\S]*$/,"").trim();return{title:g(3,30),artist:g(33,30),album:g(63,30)}}
async function wav(file){const out={};let pos=12;for(let n=0;n<64&&pos+8<=file.size;n++){const h=new Uint8Array(await file.slice(pos,pos+8).arrayBuffer()),id=String.fromCharCode(...h.subarray(0,4)),len=new DataView(h.buffer).getUint32(4,true);
  if(id==="LIST"||/^id3 $/i.test(id)){const d=new Uint8Array(await file.slice(pos+8,pos+8+Math.min(len,8e6)).arrayBuffer());
   if(id==="LIST"){if(String.fromCharCode(...d.subarray(0,4))==="INFO"){const dv=new DataView(d.buffer,d.byteOffset);let i=4;while(i+8<=d.length){const k=String.fromCharCode(...d.subarray(i,i+4)),l=dv.getUint32(i+4,true),s=z(T(d.subarray(i+8,i+8+l),3));if(k==="INAM"&&s)out.title=s;if(k==="IART"&&s)out.artist=s;if(k==="IPRD"&&s)out.album=s;i+=8+l+(l&1)}}}else Object.assign(out,id3(d))}
  pos+=8+len+(len&1)}return out}
const yt=/\s*[\[(]\s*([\w-]{11})\s*[\])]\s*$/;
function fromName(s){s=String(s||"").replace(/\.(mp3|wav)$/i,"");const m=s.match(yt);if(m&&(/[\d_-]/.test(m[1])||(/[a-z]/.test(m[1])&&/[A-Z]/.test(m[1]))))s=s.replace(yt,"");s=s.replace(/_/g," ");
 s=s.replace(/\s*[\[(](?:official|lyrics?|audio|video|music video|hd|hq|4k|visuali[sz]er)[^\])]*[\])]/gi,"").replace(/^\s*\d{1,3}[.)]\s+|^\s*\d{1,3}\s+-\s+/,"").replace(/\s{2,}/g," ").trim();
 const d=s.match(/^(.+?)\s+[-–—]\s+(.+)$/);return d?{artist:d[1].trim(),title:d[2].trim()}:{artist:"",title:s}}
async function read(file,name){name=name||file.name||"";let t={};
 try{const head=new Uint8Array(await file.slice(0,12).arrayBuffer());
  if(head[0]===73&&head[1]===68&&head[2]===51)t=id3(new Uint8Array(await file.slice(0,10+ss(head,6)).arrayBuffer()));
  else if(String.fromCharCode(...head.subarray(0,4))==="RIFF")t=await wav(file);
  if(!t.title&&!t.artist)t=Object.assign(v1(new Uint8Array(await file.slice(Math.max(0,file.size-128)).arrayBuffer())),t)}catch(e){console.warn("Tag read failed",e)}
 const b=fromName(t.title||name),artist=t.artist||b.artist;let title=t.artist?(t.title||b.title):b.title;
 if(artist)title=title.replace(new RegExp("^"+artist.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\s*[-–—]\\s+","i"),"")||title;
 return{title:title||name.replace(/\.[^.]+$/,""),artist,album:t.album||"",picture:t.picture||null}}
window.DetuneTags={read,fromName};
})();
