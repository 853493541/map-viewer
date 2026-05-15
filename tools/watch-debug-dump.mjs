#!/usr/bin/env node
// Watch the editor's debug-dump folders for newly fetched files.
//
// The editor's INI has `forceWriteFileToLocalForDebug=1`, so every
// HTTP-fetched file is decompressed and written under
//   <cwd-of-editor>/_HttpFileForDebug_/local/<logical/path>
//
// This watcher:
//   1. Snapshots existing files at startup.
//   2. Polls every 1 s for new/changed files and prints them with size,
//      mtime, and logical path (anything after "_HttpFileForDebug_/local/").
//   3. Optionally writes a JSON log of all new files into log/dump-watch.jsonl
//
// Usage:
//   node tools/watch-debug-dump.mjs
//   node tools/watch-debug-dump.mjs --root <dir>      (override search root)
//   node tools/watch-debug-dump.mjs --json log\\x.jsonl
//
// Default search roots (any that exist):
//   <installer>/_HttpFileForDebug_
//   <installer>/seasun/client/_HttpFileForDebug_
//   <installer>/seasun/editortool/qseasuneditor/seasunapp/_HttpFileForDebug_
//   <installer>/seasun/zscache/dat   (capture by-hash storage too)

import { readdirSync, statSync, existsSync, openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

const INSTALL_ROOT = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4';
const DEFAULT_ROOTS = [
  `${INSTALL_ROOT}/_HttpFileForDebug_`,
  `${INSTALL_ROOT}/seasun/client/_HttpFileForDebug_`,
  `${INSTALL_ROOT}/seasun/editortool/qseasuneditor/seasunapp/_HttpFileForDebug_`,
  `${INSTALL_ROOT}/seasun/zscache/dat`,
];

function parseArgs(argv) {
  const cfg = { roots: [], json: null, intervalMs: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') cfg.roots.push(resolve(argv[++i]));
    else if (a === '--json') cfg.json = resolve(argv[++i]);
    else if (a === '--interval') cfg.intervalMs = Number(argv[++i]) || 1000;
  }
  if (!cfg.roots.length) cfg.roots = DEFAULT_ROOTS.filter(existsSync);
  return cfg;
}

function walkSnapshot(root, out) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = `${root}${sep}${e.name}`;
    if (e.isDirectory()) walkSnapshot(full, out);
    else if (e.isFile()) {
      try {
        const st = statSync(full);
        out.set(full, { size: st.size, mtimeMs: st.mtimeMs });
      } catch {}
    }
  }
}

function logicalPath(full, root) {
  const rel = relative(root, full).replace(/\\/g, '/');
  // For _HttpFileForDebug_ trees the layout is .../local/<logical>
  const localIdx = rel.toLowerCase().indexOf('local/');
  if (localIdx >= 0) return rel.slice(localIdx + 'local/'.length);
  return rel;
}

function fmtTs() { return new Date().toISOString().slice(11, 23); }

function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (!cfg.roots.length) {
    console.error('No watch roots exist. Pass --root <dir>.');
    process.exit(2);
  }
  console.error(`[${fmtTs()}] watching ${cfg.roots.length} root(s):`);
  for (const r of cfg.roots) console.error('  -', r);

  let jsonFd = null;
  if (cfg.json) {
    mkdirSync(resolve(cfg.json, '..'), { recursive: true });
    jsonFd = openSync(cfg.json, 'a');
    console.error(`[${fmtTs()}] appending JSONL log to ${cfg.json}`);
  }

  const baseline = new Map();
  for (const r of cfg.roots) walkSnapshot(r, baseline);
  console.error(`[${fmtTs()}] baseline files: ${baseline.size}`);

  const seen = new Map(baseline);
  setInterval(() => {
    const current = new Map();
    for (const r of cfg.roots) walkSnapshot(r, current);
    const newFiles = [];
    const grew = [];
    for (const [path, st] of current) {
      const prev = seen.get(path);
      if (!prev) newFiles.push({ path, st });
      else if (prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) grew.push({ path, st, prev });
    }
    for (const { path, st } of newFiles) {
      const root = cfg.roots.find((r) => path.startsWith(r));
      const logical = logicalPath(path, root || '');
      const line = `[${fmtTs()}] NEW   ${st.size}\t${logical}`;
      console.log(line);
      if (jsonFd != null) {
        writeSync(jsonFd, JSON.stringify({ ts: Date.now(), kind: 'new', size: st.size, mtimeMs: st.mtimeMs, full: path, logical }) + '\n');
      }
    }
    for (const { path, st, prev } of grew) {
      const root = cfg.roots.find((r) => path.startsWith(r));
      const logical = logicalPath(path, root || '');
      const line = `[${fmtTs()}] GROW  ${prev.size}->${st.size}\t${logical}`;
      console.log(line);
      if (jsonFd != null) {
        writeSync(jsonFd, JSON.stringify({ ts: Date.now(), kind: 'grow', sizeBefore: prev.size, sizeAfter: st.size, mtimeMs: st.mtimeMs, full: path, logical }) + '\n');
      }
    }
    for (const [path, st] of current) seen.set(path, st);
  }, cfg.intervalMs);

  process.on('SIGINT', () => {
    if (jsonFd != null) try { closeSync(jsonFd); } catch {}
    console.error(`\n[${fmtTs()}] stopped`);
    process.exit(0);
  });
}

main();
