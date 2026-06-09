#!/usr/bin/env node
// Probe CDN for the per-bucket-index endpoint using the manifest's u64 hash
// + u32 size for the active main bucket that contains our target record.

import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

const CDN_ROOT = 'https://jx3v5hw-editor-update.xoyocdn.com/pkgs_editor/trunk_editor/';
const NATIVE_BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const MANIFEST_PATH = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/seasun/zscache/ver/trunk/2';
const TARGET_BUCKETS = [51470, 0, 1];

function toNativeBase32(value) {
  if (value === 0n) return 'a';
  let current = value;
  let out = '';
  while (current > 0n) {
    out = NATIVE_BASE32_ALPHABET[Number(current & 31n)] + out;
    current >>= 5n;
  }
  return out;
}

function head(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = httpsRequest({ method: 'HEAD', hostname: u.hostname, path: u.pathname, port: 443 }, (res) => {
      resolve({ status: res.statusCode, len: res.headers['content-length'] });
      res.resume();
    });
    req.on('error', (err) => resolve({ status: 0, err: err.message }));
    req.end();
  });
}

async function main() {
  const buf = readFileSync(MANIFEST_PATH);
  for (const bucketIdx of TARGET_BUCKETS) {
    const off = bucketIdx * 12;
    const hash = buf.readBigUInt64LE(off);
    const size = buf.readUInt32LE(off + 8);
    if (hash === 0n && size === 0) {
      console.log(`bucket ${bucketIdx}: empty`);
      continue;
    }
    const b32 = toNativeBase32(hash);
    const dir = Number((hash >> 16n) & 0xffn);
    const candidates = [
      `${CDN_ROOT}h/${dir}/${b32}.${size}`,
      `${CDN_ROOT}hs/${dir}/${b32}.${size}`,
      `${CDN_ROOT}b/${dir}/${b32}.${size}`,
      `${CDN_ROOT}p/${dir}/${b32}.${size}`,
      `${CDN_ROOT}h/${b32[0]}/${b32[1]}/${b32.slice(2)}.${size}`,
    ];
    console.log(`\nbucket=${bucketIdx} hash=0x${hash.toString(16)} size=${size}`);
    for (const url of candidates) {
      const r = await head(url);
      console.log(`  [${r.status === 200 ? 'HIT' : '   '}] ${r.status}\t${url}${r.len ? ' len=' + r.len : ''}`);
    }
  }
}

main();
