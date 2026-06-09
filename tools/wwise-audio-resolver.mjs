/**
 * Wwise audio resolver.
 *
 * Loads `log/wwise-soundbank-index.json` (built by tools/index-wwise-soundbanks.mjs)
 * and provides:
 *
 *   - `getWwiseIndex()` — cached parsed index
 *   - `resolveWwiseEvent(name)` — returns { event, wemIds: number[], banks: string[] }
 *   - `getWemBuffer(wemId)` — Buffer of raw .wem (from streamed file or extracted from .bnk)
 *   - `decodeWemToOgg(wemId)` — Buffer of decoded ogg, cached on disk
 *
 * Decoding shells out to `tools/bin/ww2ogg/ww2ogg.exe` with the aoTuV codebooks.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const INDEX_PATH = join(REPO_ROOT, 'log', 'wwise-soundbank-index.json');
const WW2OGG_EXE = join(REPO_ROOT, 'tools', 'bin', 'ww2ogg', 'ww2ogg.exe');
const WW2OGG_CODEBOOKS = join(REPO_ROOT, 'tools', 'bin', 'ww2ogg', 'packed_codebooks_aoTuV_603.bin');
const OGG_CACHE_DIR = join(REPO_ROOT, 'tools', 'audio-cache');

let cachedIndex = null;
let cachedIndexMtime = 0;

export function getWwiseIndex() {
  if (!existsSync(INDEX_PATH)) return null;
  const m = statSync(INDEX_PATH).mtimeMs;
  if (cachedIndex && m === cachedIndexMtime) return cachedIndex;
  cachedIndex = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  cachedIndexMtime = m;
  return cachedIndex;
}

// Wwise FNV-1 (32-bit) of lowercase event name.
export function wwiseHash(name) {
  let h = 0x811C9DC5n;
  const M = 0xFFFFFFFFn;
  const P = 0x01000193n;
  for (const c of Buffer.from(String(name).toLowerCase(), 'utf8')) {
    h = (h * P) & M;
    h = h ^ BigInt(c);
  }
  return Number(h & M);
}

export function cleanWwiseEventQuery(rawName) {
  const text = String(rawName || '').replace(/\0/g, '').trim();
  if (!text) return '';
  const prefix = text.match(/^[A-Za-z][A-Za-z0-9_./:-]{2,}/);
  if (prefix) return prefix[0].replace(/[./:-]+$/g, '');
  const candidates = text.match(/[A-Za-z][A-Za-z0-9_./:-]{3,}/g) || [];
  const preferred = candidates
    .filter((candidate) => /[_/\\]/.test(candidate) || /^Play_/i.test(candidate))
    .sort((left, right) => right.length - left.length)[0];
  return preferred || text;
}

export function resolveWwiseEvent(rawName) {
  const idx = getWwiseIndex();
  if (!idx) return { error: 'wwise-index-missing', event: null };
  const trimmed = String(rawName || '').trim();
  const cleaned = cleanWwiseEventQuery(trimmed);
  if (!trimmed && !cleaned) return { error: 'empty-name', event: null };

  const tryNames = new Set();
  for (const name of [trimmed, cleaned]) {
    if (!name) continue;
    tryNames.add(name);
    tryNames.add(name.replace(/^Play_/i, ''));
    const parts = name.split(/[/\\]/);
    if (parts.length > 1) tryNames.add(parts[parts.length - 1]);
  }

  // Direct name match
  for (const candidate of tryNames) {
    if (idx.events[candidate]) {
      return { match: 'name', event: candidate, ...idx.events[candidate] };
    }
  }

  // FNV hash match against byHash table (engine stores 32-bit IDs).
  for (const candidate of tryNames) {
    const h = wwiseHash(candidate);
    const evName = idx.byHash?.[String(h)] || idx.byHash?.[h];
    if (evName && idx.events[evName]) {
      return { match: 'hash', queryHash: h, event: evName, ...idx.events[evName] };
    }
  }

  // Numeric ID match (caller passed an integer event id).
  if (/^\d+$/.test(trimmed)) {
    const evName = idx.byHash?.[trimmed] || idx.byHash?.[Number(trimmed)];
    if (evName && idx.events[evName]) {
      return { match: 'id', event: evName, ...idx.events[evName] };
    }
  }

  return { error: 'not-found', event: null, tried: [...tryNames] };
}

// Parse a .bnk file's DIDX/DATA chunks and return a Map<wemId, {offset,size}>.
function parseBankIndex(bnkPath) {
  const buf = readFileSync(bnkPath);
  let off = 0;
  let didxStart = -1;
  let didxSize = 0;
  let dataStart = -1;
  while (off < buf.length - 8) {
    const tag = buf.subarray(off, off + 4).toString('ascii');
    const sz = buf.readUInt32LE(off + 4);
    if (tag === 'DIDX') { didxStart = off + 8; didxSize = sz; }
    else if (tag === 'DATA') { dataStart = off + 8; break; }
    off += 8 + sz;
  }
  if (didxStart < 0 || dataStart < 0) return { buf, entries: new Map(), dataStart: -1 };
  const entries = new Map();
  const n = didxSize / 12;
  for (let i = 0; i < n; i++) {
    const id = buf.readUInt32LE(didxStart + i * 12);
    const ofs = buf.readUInt32LE(didxStart + i * 12 + 4);
    const len = buf.readUInt32LE(didxStart + i * 12 + 8);
    entries.set(id, { offset: ofs, size: len });
  }
  return { buf, entries, dataStart };
}

export function getWemBuffer(wemId) {
  const idx = getWwiseIndex();
  if (!idx) return null;
  const entry = idx.wems?.[String(wemId)] || idx.wems?.[wemId];
  if (!entry) return null;
  if (entry.streamed && entry.file) {
    if (!existsSync(entry.file)) return null;
    return readFileSync(entry.file);
  }
  // In-memory: extract from the bank file.
  const bank = idx.banks?.[entry.bank];
  if (!bank) return null;
  // banks[*].bnk in the v2 index is an absolute path; legacy v1 index stores a basename.
  const bankAbs = bank.bnk ? (isAbsolute(bank.bnk) ? bank.bnk : join(bank.root || idx.root, bank.bnk)) : null;
  if (!bankAbs || !existsSync(bankAbs)) return null;
  const { buf, entries, dataStart } = parseBankIndex(bankAbs);
  const e = entries.get(Number(wemId));
  if (!e || dataStart < 0) return null;
  return buf.subarray(dataStart + e.offset, dataStart + e.offset + e.size);
}

export function decodeWemToOgg(wemId) {
  if (!existsSync(WW2OGG_EXE)) {
    return { error: 'ww2ogg-exe-missing', path: WW2OGG_EXE };
  }
  if (!existsSync(OGG_CACHE_DIR)) mkdirSync(OGG_CACHE_DIR, { recursive: true });
  const oggPath = join(OGG_CACHE_DIR, `${wemId}.ogg`);
  if (existsSync(oggPath) && statSync(oggPath).size > 0) {
    return { oggPath, oggBuffer: readFileSync(oggPath), cached: true };
  }
  const wemBuf = getWemBuffer(wemId);
  if (!wemBuf) return { error: 'wem-not-found', wemId };
  const tmpWem = join(os.tmpdir(), `wwise-${wemId}-${process.pid}.wem`);
  writeFileSync(tmpWem, wemBuf);
  try {
    execFileSync(WW2OGG_EXE, [tmpWem, '-o', oggPath, '--pcb', WW2OGG_CODEBOOKS], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    return { error: 'ww2ogg-failed', detail: err?.stderr?.toString() || err?.message || String(err) };
  } finally {
    try { unlinkSync(tmpWem); } catch {}
  }
  if (!existsSync(oggPath) || statSync(oggPath).size === 0) {
    return { error: 'ww2ogg-no-output' };
  }
  return { oggPath, oggBuffer: readFileSync(oggPath), cached: false };
}
