// Dump MIN2 chunk structure
import fs from 'fs';
const f=process.argv[2];
const b=fs.readFileSync(f);
console.log('size',b.length,'magic',b.toString('ascii',0,4));
let p=4;
const ver=b.readUInt32LE(p); p+=4;
const flag=b.readUInt32LE(p); p+=4;
const numChunks=b.readUInt32LE(p); p+=4;
console.log({ver,flag,numChunks});
// find printable strings near tag chunks
const minLen=4;
let cur=[];
for (let i=0;i<b.length;i++){
  const c=b[i];
  if (c>=0x20 && c<=0x7e){ cur.push(c); }
  else {
    if (cur.length>=minLen){
      const s=Buffer.from(cur).toString('ascii');
      if (/sound|sfx|wav|wem|fmod|wwise|event|effect|skill|attack|hit|cast|kg3d_|tag|track|key/i.test(s)){
        console.log('@'+(i-cur.length).toString(16), s);
      }
    }
    cur=[];
  }
}
