// Probe LibPak5 native API to extract the full file list / resolve q0 hashes.
import koffi from 'koffi';

const DLL = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4/KGPK5_FileSystemX64.dll';
// load some sibling DLLs first so dependencies resolve
process.chdir('C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4');
const argv = new Set(process.argv.slice(2));

const lib = koffi.load(DLL);

// Helper: try to bind a symbol with several candidate signatures and return first that resolves.
function tryBind(name, sigs) {
  for (const sig of sigs) {
    try {
      const fn = lib.func(sig);
      console.log(`bind OK: ${sig}`);
      return fn;
    } catch (e) {
      console.log(`bind FAIL ${sig}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error(`could not bind ${name}`);
}

// 1. Set root path
const setRoot = tryBind('g_SetPakV5RootPath', [
  'int g_SetPakV5RootPath(const char *path)',
  'void g_SetPakV5RootPath(const char *path)',
  'int g_SetPakV5RootPath(const char16_t *path)',
]);

const enablePakV5 = tryBind('g_EnablePakV5', [
  'int g_EnablePakV5(int enable)',
  'void g_EnablePakV5(int enable)',
  'int g_EnablePakV5()',
]);

const getVersion = tryBind('g_GetPakV5Version', [
  'int g_GetPakV5Version()',
  'long long g_GetPakV5Version()',
  'unsigned long long g_GetPakV5Version()',
]);

console.log('--- calling g_SetPakV5RootPath ---');
const rootPath = 'C:\\SeasunGame\\Game\\JX3\\bin\\zhcn_hd\\SeasunDownloaderV2.4\\';
console.log('setRoot ->', setRoot(rootPath));

const initOther = tryBind('g_InitPakV5OtherMoudle', [
  'int g_InitPakV5OtherMoudle()',
  'int g_InitPakV5OtherMoudle(int x)',
  'void g_InitPakV5OtherMoudle()',
]);
const initRecord = tryBind('g_PakV5InitRecord', [
  'int g_PakV5InitRecord()',
  'void g_PakV5InitRecord()',
]);
const createAdapter = tryBind('g_CreatePakV5Adapter', [
  'int g_CreatePakV5Adapter()',
  'void *g_CreatePakV5Adapter()',
  'int g_CreatePakV5Adapter(const char *path)',
]);
const initHttp = tryBind('g_InitHttpFile', [
  'int g_InitHttpFile()',
  'void g_InitHttpFile()',
  'int g_InitHttpFile(const char *path)',
]);
const disableHttp = tryBind('g_DisableHttpFile', [
  'int g_DisableHttpFile()',
  'void g_DisableHttpFile()',
]);
const getIndexHashTable = tryBind('g_GetIndexPackageHashTable', [
  'void *g_GetIndexPackageHashTable()',
  'long long g_GetIndexPackageHashTable()',
  'int g_GetIndexPackageHashTable()',
]);

console.log('--- calling g_EnablePakV5 ---');
try { console.log('enable ->', enablePakV5(1)); } catch (e) { console.log('enable failed', e.message); }

console.log('--- g_DisableHttpFile ---');
try { console.log('disableHttp ->', disableHttp()); } catch (e) { console.log('disableHttp failed', e.message); }

if (argv.has('--unsafe-index-hash-table')) {
  console.log('--- g_GetIndexPackageHashTable BEFORE init ---');
  try { console.log('hashTable ->', getIndexHashTable()); } catch (e) { console.log('failed', e.message); }
} else {
  console.log('--- skipping g_GetIndexPackageHashTable BEFORE init (use --unsafe-index-hash-table to probe it) ---');
}

console.log('--- skip g_InitPakV5OtherMoudle (hangs) ---');
if (false) console.log('--- calling g_InitPakV5OtherMoudle ---');
// skipped

if (argv.has('--unsafe-create-adapter')) {
  console.log('--- calling g_CreatePakV5Adapter ---');
  try { console.log('createAdapter ->', createAdapter()); } catch (e) { try { console.log('createAdapter(root) ->', createAdapter(rootPath)); } catch (e2) { console.log('createAdapter failed', e.message, '|', e2.message); } }
} else {
  console.log('--- skipping g_CreatePakV5Adapter (use --unsafe-create-adapter to probe it) ---');
}

if (argv.has('--unsafe-init-record')) {
  console.log('--- calling g_PakV5InitRecord ---');
  try { console.log('initRecord ->', initRecord()); } catch (e) { console.log('initRecord failed', e.message); }
} else {
  console.log('--- skipping g_PakV5InitRecord (use --unsafe-init-record to probe it) ---');
}

if (argv.has('--init-http')) {
  console.log('--- calling g_InitHttpFile ---');
  try {
    console.log('initHttp(root) ->', initHttp(rootPath));
  } catch (e) {
    try {
      console.log('initHttp() ->', initHttp());
    } catch (e2) {
      console.log('initHttp failed', e.message, '|', e2.message);
    }
  }
} else {
  console.log('--- skipping g_InitHttpFile (use --init-http to probe it) ---');
}

console.log('--- calling g_GetPakV5Version ---');
console.log('version ->', getVersion());

// 2. Try g_HashNumber2String on a known q0 from the parsed manifest
const hashNumber2String = tryBind('g_HashNumber2String', [
  'const char *g_HashNumber2String(uint64_t hash)',
  'char *g_HashNumber2String(uint64_t hash)',
  'int g_HashNumber2String(uint64_t hash, char *out, int outLen)',
]);

const KNOWN_Q0S = [
  0x0300171554348690n,
  0x0300_1728d029fdc3n,
  0x0600_5405b5ea5d74n,
  0x0b00_200a5028a22dn,
  0x0d00_177e7c2e1ceen,
  0x0d00_ee566f5610d7n,
];

for (const q of KNOWN_Q0S) {
  try {
    let out = hashNumber2String(q);
    if (typeof out === 'function' /* binding had buf */) continue;
    console.log(`q0=0x${q.toString(16).padStart(16,'0')} -> ${JSON.stringify(out)}`);
  } catch (e) {
    // fall back to buffer signature
    try {
      const buf = Buffer.alloc(1024);
      const r = hashNumber2String(q, buf, 1024);
      console.log(`q0=0x${q.toString(16).padStart(16,'0')} -> r=${r} str=${JSON.stringify(buf.toString('utf8').replace(/\0.*/,''))}`);
    } catch (e2) {
      console.log(`q0=0x${q.toString(16).padStart(16,'0')} ERROR ${e.message} | ${e2.message}`);
    }
  }
}

// 3. Try g_GetPakV5AllFileList
const getAllFileList = tryBind('g_GetPakV5AllFileList', [
  'int g_GetPakV5AllFileList(_Out_ char ***outList, _Out_ int *outCount)',
  'int g_GetPakV5AllFileList(char ***outList, int *outCount)',
  'int g_GetPakV5AllFileList(void **outList, int *outCount)',
  'int g_GetPakV5AllFileList(char **outBuf, int *outLen)',
  'const char *g_GetPakV5AllFileList()',
  'int g_GetPakV5AllFileList()',
]);

try {
  const outList = [null];
  const outCount = [0];
  const r = getAllFileList(outList, outCount);
  console.log(`AllFileList -> rc=${r} count=${outCount[0]}`);
  if (outList[0] && outCount[0] > 0) {
    const sampleCount = Math.min(outCount[0], 50);
    const sample = koffi.decode(outList[0], 'char *', sampleCount);
    console.log(`AllFileList sample (${sampleCount}/${outCount[0]}):`);
    for (const entry of sample) {
      console.log(`  ${JSON.stringify(entry)}`);
    }
  }
} catch (e) { console.log('AllFileList call failed', e.message); }
