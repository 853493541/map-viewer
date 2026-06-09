import { resolveWwiseEvent, decodeWemToOgg, getWemBuffer } from './wwise-audio-resolver.mjs';
const r = resolveWwiseEvent('Play_BeHit_Flesh_QiXiu');
const wid = r.wems.inMemory[0];
const buf = getWemBuffer(wid);
console.log('wem ok', !!buf, 'len=', buf?.length);
const out = decodeWemToOgg(wid);
console.log('decode result:', JSON.stringify({ wid, err: out.error || null, oggLen: out.oggBuffer?.length || 0, head: out.oggBuffer?.slice(0,4).toString('ascii') || '' }));
