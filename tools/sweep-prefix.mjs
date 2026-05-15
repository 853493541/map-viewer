// Sweep candidate prefixes for unmatched-bucket parents.
const XXP1=0x9e3779b185ebca87n,XXP2=0xc2b2ae3d27d4eb4fn,XXP3=0x165667b19e3779f9n,XXP4=0x85ebca77c2b2ae63n,XXP5=0x27d4eb2f165667c5n;
const M=(1n<<64n)-1n;const u64=v=>v&M;const rol=(v,n)=>u64((v<<BigInt(n))|(v>>(64n-BigInt(n))));
function rd(a,l){let v=u64(a+l*XXP2);v=rol(v,31);return u64(v*XXP1);}
function mg(a,v){let m=u64(a^rd(0n,v));return u64(m*XXP1+XXP4);}
function xx(b){const len=b.length;let off=0,h;if(len>=32){let v1=u64(XXP1+XXP2),v2=XXP2,v3=0n,v4=u64(0n-XXP1);const lim=len-32;while(off<=lim){v1=rd(v1,b.readBigUInt64LE(off));off+=8;v2=rd(v2,b.readBigUInt64LE(off));off+=8;v3=rd(v3,b.readBigUInt64LE(off));off+=8;v4=rd(v4,b.readBigUInt64LE(off));off+=8;}h=u64(rol(v1,1)+rol(v2,7)+rol(v3,12)+rol(v4,18));h=mg(h,v1);h=mg(h,v2);h=mg(h,v3);h=mg(h,v4);}else h=XXP5;h=u64(h+BigInt(len));while(off<=len-8){const l=rd(0n,b.readBigUInt64LE(off));h=u64(h^l);h=u64(rol(h,27)*XXP1+XXP4);off+=8;}if(off<=len-4){h=u64(h^(BigInt(b.readUInt32LE(off))*XXP1));h=u64(rol(h,23)*XXP2+XXP3);off+=4;}while(off<len){h=u64(h^(BigInt(b[off])*XXP5));h=u64(rol(h,11)*XXP1);off+=1;}h=u64(h^(h>>33n));h=u64(h*XXP2);h=u64(h^(h>>29n));h=u64(h*XXP3);h=u64(h^(h>>32n));return h;}
function djb(s){const b=Buffer.from(s,'utf8');let h=5381;for(const x of b) h=((h*33)+x)&0x3fffff; return h>>>0;}

const target40 = 0x17e2ac62f3n;
const fnames=['kgpk5_filesystemx64.dll','KGPK5_FileSystemX64.dll'];
const prefixes=['','./','/','SeasunDownloaderV2.4/','seasundownloaderv2.4/','installer/','SeasunDownloader/','seasundownloader/','seasundownloaderv2/','seasun/','./SeasunDownloaderV2.4/','jx3/','jx3/bin/zhcn_hd/seasundownloaderv2.4/','bin/zhcn_hd/seasundownloaderv2.4/','main/','installer\\','SeasunDownloaderV2.4\\','seasundownloaderv2.4\\','clientupdate/','client_update/','clientupdater/','launcher/','SeasunLauncher/','seasunlauncher/','sl/','dl/','downloader/','PakV5/','pakv5/','SeasunDownloaderV2/','seasundownloaderv2/','launcher/SeasunDownloaderV2.4/','launcher/seasundownloaderv2.4/'];
for (const fn of fnames) for (const p of prefixes) {
  const path = p + fn;
  const h = xx(Buffer.from(path,'utf8'));
  const lo40 = h & ((1n<<40n)-1n);
  const slash = path.lastIndexOf('/'); const back = path.lastIndexOf('\\');
  const sep = Math.max(slash, back);
  const par = sep>=0 ? path.slice(0,sep) : '';
  const dh = djb(par);
  if (lo40 === target40) console.log('XX-MATCH path=', JSON.stringify(path), 'xx=0x'+h.toString(16), 'parent=', JSON.stringify(par), 'djb=0x'+dh.toString(16));
  if (dh === 0xf51b7) console.log('DJB-MATCH path=', JSON.stringify(path), 'parent=', JSON.stringify(par));
}
console.log('done');
