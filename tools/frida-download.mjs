#!/usr/bin/env node
// Drive the editor's own download API via the running Frida agent.
//
// Usage:
//   node tools\frida-download.mjs <logical-path> [<localPath>]
//   node tools\frida-download.mjs --info <logical-path>
//   node tools\frida-download.mjs --writeLocal <logical-path> [<localPath>]
//   node tools\frida-download.mjs --resolve
//
// Prereq: tools\frida-attach.mjs is already running (started by start-capture.cmd)
// and has surfaced "control on http://127.0.0.1:39314/".

import { resolve as resolvePath, basename } from 'node:path';
import { mkdirSync } from 'node:fs';

const PORT = Number(process.env.FRIDA_CTL_PORT || 39314);
const URL  = `http://127.0.0.1:${PORT}/`;

const argv = process.argv.slice(2);
let mode = 'download';
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--info') mode = 'getInfo';
  else if (a === '--writeLocal') mode = 'writeLocal';
  else if (a === '--resolve') mode = 'resolveApis';
  else positional.push(a);
}

async function send(cmd) {
  const r = await fetch(URL, { method: 'POST', body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const logical = positional[0];
let localPath = positional[1];

if (mode === 'resolveApis') {
  console.log(JSON.stringify(await send({ cmd: 'resolveApis' }), null, 2));
  process.exit(0);
}
if (!logical) {
  console.error('logical path required');
  process.exit(2);
}
if (mode === 'getInfo') {
  console.log(JSON.stringify(await send({ cmd: 'getInfo', logical }), null, 2));
  process.exit(0);
}

if (!localPath) {
  localPath = resolvePath('cache-extraction/frida-downloads', basename(logical.replace(/[\\/]/g, '__')));
}
mkdirSync(resolvePath(localPath, '..'), { recursive: true });

const result = await send({ cmd: mode, logical, localPath });
console.log(JSON.stringify({ logical, localPath, result }, null, 2));
