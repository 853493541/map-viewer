#!/usr/bin/env node
// Try to construct the body-file URL `<root>h/<dir>/<base32(hash)>.<size>`
// using each candidate hash field from a record (q0, q1, t0|t1 combined,
// bucketHeader|t0, etc.) and HEAD-test against the editor CDN root.

import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

const CDN_ROOT = 'https://jx3v5hw-editor-update.xoyocdn.com/pkgs_editor/trunk_editor/';
const NATIVE_BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

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
    const req = httpsRequest({
      method: 'HEAD',
      hostname: u.hostname,
      path: u.pathname + u.search,
      port: 443,
      headers: {
        'User-Agent': 'jx3-pakv5-probe',
      },
    }, (res) => {
      resolve({ status: res.statusCode, len: res.headers['content-length'] });
      res.resume();
    });
    req.on('error', (err) => resolve({ status: 0, err: err.message }));
    req.end();
  });
}

// Records harvested earlier from probe-pakv5-record-paths.mjs:
// 六合独尊.ogg → bucket=51470 q0=0x0ec96eb7cb06cce2 q1=0x00290880176daba5 a=63451 c=63467 t0=1063816435 t1=2970339562 header=304705945
// 飞镖.ogg     → bucket=51470 q0=0x0ec96e8d1e11e8e1 q1=0x024603c9f315d488 a=14832 c=14848 t0=1063816435 t1=2970339562 header=304705945

const records = [
  {
    name: '六合独尊.ogg',
    q0: 0x0ec96eb7cb06cce2n,
    q1: 0x00290880176daba5n,
    a: 63451,
    c: 63467,
    t0: 1063816435,
    t1: 2970339562,
    header: 304705945,
    bucket: 51470,
  },
  {
    name: '飞镖.ogg',
    q0: 0x0ec96e8d1e11e8e1n,
    q1: 0x024603c9f315d488n,
    a: 14832,
    c: 14848,
    t0: 1063816435,
    t1: 2970339562,
    header: 304705945,
    bucket: 51470,
  },
];

function combine(lo, hi) {
  return BigInt.asUintN(64, (BigInt(hi) << 32n) | BigInt(lo));
}

function deriveHashCandidates(rec) {
  const tComboLEhi = combine(rec.t0, rec.t1);   // [t0 lo][t1 hi]
  const tComboHEhi = combine(rec.t1, rec.t0);   // [t1 lo][t0 hi]
  const headerComboT0 = combine(rec.header, rec.t0);
  const headerComboT1 = combine(rec.header, rec.t1);
  return [
    { name: 'q0', value: rec.q0 },
    { name: 'q1', value: rec.q1 },
    { name: 't[lo=t0,hi=t1]', value: tComboLEhi },
    { name: 't[lo=t1,hi=t0]', value: tComboHEhi },
    { name: 't0', value: BigInt(rec.t0) },
    { name: 't1', value: BigInt(rec.t1) },
    { name: 'header', value: BigInt(rec.header) },
    { name: 'header|t0', value: headerComboT0 },
    { name: 'header|t1', value: headerComboT1 },
  ];
}

function buildUrls(rec) {
  const urls = [];
  const sizes = [
    { tag: 'c', value: rec.c },
    { tag: 'a', value: rec.a },
    { tag: 'hdr', value: rec.header },
  ];
  // Patterns derived from DLL format strings:
  //   KG_HttpFileDownloader::GetStreamUrl     %sh/%d/%s.%u            (1 decimal dir)
  //   KG_SubIndexPackage::_GetSubPkgName      %s/%c/%c/%s.%d%s        (2 char dirs)
  //   KG_SubIndexPackage::_GetSubPkgName      cszHashName[3]%s/%c/%c/%s%s  (uses chars[0..2] of hashName)
  const layouts = [
    { tag: 'h-decdir', build: (b32, hashU64, size) => `h/${Number((hashU64 >> 16n) & 0xffn)}/${b32}.${size}` },
    { tag: 'h-2char',  build: (b32, _hashU64, size) => `h/${b32[0]}/${b32[1]}/${b32.slice(2)}.${size}` },
    { tag: 'h-1char',  build: (b32, _hashU64, size) => `h/${b32[0]}/${b32.slice(1)}.${size}` },
    { tag: 'h-decdir-low8', build: (b32, hashU64, size) => `h/${Number(hashU64 & 0xffn)}/${b32}.${size}` },
    { tag: 'h-2char-hpkg',  build: (b32, _hashU64, size) => `h/${b32[0]}/${b32[1]}/${b32.slice(2)}.${size}.hpkg` },
    { tag: 'h-decdir-hpkg', build: (b32, hashU64, size) => `h/${Number((hashU64 >> 16n) & 0xffn)}/${b32}.${size}.hpkg` },
    { tag: 'p-2char-hpkg',  build: (b32, _hashU64, size) => `p/${b32[0]}/${b32[1]}/${b32.slice(2)}.${size}.hpkg` },
  ];
  for (const h of deriveHashCandidates(rec)) {
    const base32 = toNativeBase32(h.value);
    for (const s of sizes) {
      for (const lay of layouts) {
        urls.push({
          hashLabel: h.name,
          sizeLabel: s.tag,
          layoutLabel: lay.tag,
          url: `${CDN_ROOT}${lay.build(base32, h.value, s.value)}`,
          hashHex: `0x${h.value.toString(16)}`,
        });
      }
    }
  }
  return urls;
}

async function main() {
  for (const rec of records) {
    console.log(`\n=== ${rec.name} bucket=${rec.bucket} ===`);
    const urls = buildUrls(rec);
    for (const u of urls) {
      const r = await head(u.url);
      const flag = r.status === 200 ? 'HIT' : ' ';
      console.log(`[${flag}] ${r.status}\t${u.hashLabel}/${u.sizeLabel}/${u.layoutLabel}\t${u.url}`);
      if (r.status === 200) {
        console.log(`     -> content-length=${r.len} hash=${u.hashHex}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
