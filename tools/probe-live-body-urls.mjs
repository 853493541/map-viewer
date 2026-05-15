#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import https from 'node:https';

const ROOT = 'https://jx3v5hw-editor-update.xoyocdn.com/pkgs_editor/trunk_editor/';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function nativeBase32(value) {
  if (value === 0n) return 'a';
  let current = value;
  let output = '';
  while (current > 0n) {
    output = ALPHABET[Number(current & 31n)] + output;
    current >>= 5n;
  }
  return output;
}

function head(relativePath, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = https.request(`${ROOT}${relativePath}`, { method: 'HEAD' }, (response) => {
      const contentLength = response.headers['content-length'] || '';
      response.resume();
      resolve({ path: relativePath, status: response.statusCode, contentLength });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ path: relativePath, status: 0, error: error.message }));
    request.end();
  });
}

function candidatePaths(record) {
  const paths = [];
  const prefixes = ['h', 'bf', 'f', 'p', ''];
  const fields = ['q1', 'q0'];
  const sizes = ['c', 'a'];

  for (const field of fields) {
    const value = BigInt(record[field]);
    const name = nativeBase32(value);
    const dir8 = Number((value >> 16n) & 0xffn);
    for (const sizeField of sizes) {
      const size = record[sizeField];
      for (const prefix of prefixes) {
        const base = prefix ? `${prefix}/${dir8}/${name}` : `${dir8}/${name}`;
        paths.push({ path: `${base}.${size}`, field, sizeField });
        paths.push({ path: `${base}.hpkg`, field, sizeField });
      }
    }
  }

  return paths;
}

const samplePath = process.argv[2] || 'cache-extraction/online-cdn/live-record-sample.json';
const limit = Number(process.argv[3] || 5);
const maxCandidates = Number(process.argv[4] || 0);
const sampleText = readFileSync(samplePath, 'utf8').replace(/^\uFEFF/, '');
const sample = JSON.parse(sampleText).samples.slice(0, limit);
const seen = new Set();
let checked = 0;
let hits = 0;
let capped = false;

for (const record of sample) {
  for (const candidate of candidatePaths(record)) {
    if (seen.has(candidate.path)) continue;
    if (maxCandidates && checked >= maxCandidates) {
      capped = true;
      break;
    }
    seen.add(candidate.path);
    checked += 1;
    const result = await head(candidate.path);
    if (result.status && result.status !== 404) {
      hits += 1;
      console.log(JSON.stringify({ ...result, candidate, record }));
    }
  }
  if (capped) break;
}

console.log(JSON.stringify({ checked, hits, capped }));