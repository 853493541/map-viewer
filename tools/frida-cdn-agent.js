// Frida agent that runs INSIDE the editor process.
//
//  Capabilities:
//    1. Hooks WinHttp / WinINet / libcurl request entry points -> captures
//       every URL the editor builds.
//    2. Hooks PakV5 stream-URL sprintf format string -> reports each
//       resulting `<root>h/<dir>/<hash>.<size>` body URL.
//    3. Watches local file opens/reads for the Resource Browser list bundle
//       (`data_list`, `MakePackages.bin`, `_all_sidx_filename_list`) so we can
//       identify the app-side decoder path instead of blind disk archaeology.
//    3. EXPOSES the editor's own download API to the outside controller via
//       `recv()`:
//          { cmd: 'download',  logical, localPath }
//          { cmd: 'writeLocal',logical, localPath }
//          { cmd: 'getInfo',   logical }
//          { cmd: 'getFileListState', fileListId }
//          { cmd: 'httpFileCommand', command, structSize, layout, dir, subdir, maxPath }
//          { cmd: 'httpShellCommand', message }
//          { cmd: 'readProcessFile', path, maxBytes }
//          { cmd: 'resolveApis' }
//          { cmd: 'getApiState' }
//
// Loaded by tools/frida-attach.mjs.

'use strict';

function logSend(payload) { try { send(payload); } catch (_) {} }
function readAnsi(p) { try { return p.isNull() ? null : p.readAnsiString(); } catch (_) { return null; } }
function readUtf16(p) { try { return p.isNull() ? null : p.readUtf16String(); } catch (_) { return null; } }
function isValidHandle(p) {
  if (!p || p.isNull()) return false;
  const v = p.toString();
  return v !== '0xffffffffffffffff' && v !== '0xffffffff';
}
function readHex(p, size) {
  try {
    const bytes = p.readByteArray(size);
    if (!bytes) return null;
    return Array.from(new Uint8Array(bytes)).map((value) => value.toString(16).padStart(2, '0')).join(' ');
  } catch (_) {
    return null;
  }
}
function readAsciiPreview(p, size) {
  try {
    const bytes = p.readByteArray(size);
    if (!bytes) return null;
    return Array.from(new Uint8Array(bytes)).map((value) => {
      if (value === 0) return '\0';
      if (value === 10) return '\n';
      if (value === 13) return '\r';
      return value >= 32 && value <= 126 ? String.fromCharCode(value) : '.';
    }).join('');
  } catch (_) {
    return null;
  }
}
function bytesToHex(bytes, maxBytes) {
  try {
    return Array.from(bytes.slice(0, Math.min(bytes.length, maxBytes || bytes.length))).map((value) => value.toString(16).padStart(2, '0')).join(' ');
  } catch (_) {
    return null;
  }
}
function bytesToAscii(bytes, maxBytes) {
  try {
    return Array.from(bytes.slice(0, Math.min(bytes.length, maxBytes || bytes.length))).map((value) => {
      if (value === 0) return '\0';
      if (value === 10) return '\n';
      if (value === 13) return '\r';
      return value >= 32 && value <= 126 ? String.fromCharCode(value) : '.';
    }).join('');
  } catch (_) {
    return null;
  }
}
function writeAnsiField(basePtr, offset, value, maxBytes) {
  try {
    const size = Math.max(1, Number(maxBytes) || 0);
    const text = String(value || '');
    const bytes = new Uint8Array(size);
    const limit = Math.max(0, size - 1);
    for (let i = 0; i < text.length && i < limit; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
    basePtr.add(offset).writeByteArray(bytes);
    return true;
  } catch (_) {
    return false;
  }
}
function readAnsiField(basePtr, offset, maxBytes) {
  try {
    return basePtr.add(offset).readAnsiString(Math.max(1, Number(maxBytes) || 0));
  } catch (_) {
    return null;
  }
}
function splitListPreview(text) {
  if (!text) return [];
  const seen = Object.create(null);
  const items = [];
  String(text).split(/\0|\r?\n/).forEach((raw) => {
    const value = String(raw || '').trim();
    if (!value || /^[.]+$/.test(value) || seen[value]) return;
    seen[value] = true;
    items.push(value);
  });
  return items;
}
function readPointerSlots(p, size, limit) {
  const slots = [];
  const step = Process.pointerSize;
  const maxSlots = Math.min(Math.floor(size / step), limit || 8);
  for (let i = 0; i < maxSlots; i += 1) {
    const offset = i * step;
    try {
      slots.push({
        offset,
        u32: p.add(offset).readU32(),
        pointer: p.add(offset).readPointer().toString(),
      });
    } catch (_) {
      break;
    }
  }
  return slots;
}
let k32CreateFileW = null, k32ReadFile = null, k32CloseHandle = null;
function resolveWinFileApis() {
  if (!k32CreateFileW) {
    const createFileAddr = findExportSafe('kernel32.dll', 'CreateFileW');
    if (createFileAddr) k32CreateFileW = new NativeFunction(createFileAddr, 'pointer', ['pointer', 'uint32', 'uint32', 'pointer', 'uint32', 'uint32', 'pointer']);
  }
  if (!k32ReadFile) {
    const readFileAddr = findExportSafe('kernel32.dll', 'ReadFile');
    if (readFileAddr) k32ReadFile = new NativeFunction(readFileAddr, 'int', ['pointer', 'pointer', 'uint32', 'pointer', 'pointer']);
  }
  if (!k32CloseHandle) {
    const closeHandleAddr = findExportSafe('kernel32.dll', 'CloseHandle');
    if (closeHandleAddr) k32CloseHandle = new NativeFunction(closeHandleAddr, 'int', ['pointer']);
  }
  return {
    createFile: !!k32CreateFileW,
    readFile: !!k32ReadFile,
    closeHandle: !!k32CloseHandle,
  };
}
function safeReadU32(p) {
  try {
    return !p || p.isNull() ? null : p.readU32();
  } catch (_) {
    return null;
  }
}
function safeReadPointer(p) {
  try {
    return !p || p.isNull() ? null : p.readPointer();
  } catch (_) {
    return null;
  }
}
function shortBacktrace(ctx, limit) {
  try {
    return Thread.backtrace(ctx, Backtracer.ACCURATE)
      .slice(0, limit || 8)
      .map((address) => DebugSymbol.fromAddress(address).toString());
  } catch (_) {
    return [];
  }
}
function readUnicodeStringStruct(ptr) {
  try {
    if (!ptr || ptr.isNull()) return null;
    const len = ptr.readU16();
    const bufferPtr = ptr.add(Process.pointerSize === 8 ? 8 : 4).readPointer();
    if (bufferPtr.isNull() || len <= 0) return '';
    return bufferPtr.readUtf16String(Math.floor(len / 2));
  } catch (_) {
    return null;
  }
}
function readObjectAttributesPath(ptr) {
  try {
    if (!ptr || ptr.isNull()) return null;
    const objectNamePtr = ptr.add(Process.pointerSize === 8 ? 16 : 8).readPointer();
    return readUnicodeStringStruct(objectNamePtr);
  } catch (_) {
    return null;
  }
}
function readIoStatusInformation(ptr) {
  try {
    if (!ptr || ptr.isNull()) return 0;
    if (Process.pointerSize === 8) return Number(ptr.add(8).readU64());
    return ptr.add(4).readU32();
  } catch (_) {
    return 0;
  }
}

// ---- Resource Browser bundle-file watch -----------------------------------
const watchedBundleNames = ['data_list', 'makepackages.bin', '_all_sidx_filename_list'];
const trackedBundleHandles = {};
const bundleDumpSeen = {};

function normalizePathForMatch(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}

function matchWatchedBundlePath(value) {
  const normalized = normalizePathForMatch(value);
  if (!normalized) return null;
  return watchedBundleNames.find((name) => normalized.endsWith('/' + name) || normalized === name) || null;
}

function shouldDumpBundleRead(state, actual) {
  if (!state || !state.path || actual < 4096) return false;
  const key = normalizePathForMatch(state.path);
  if (!key) return false;
  if (bundleDumpSeen[key]) return false;
  bundleDumpSeen[key] = true;
  return true;
}

function maybeDumpBundleRead(state, buffer, actual, api, readIndex) {
  if (!shouldDumpBundleRead(state, actual)) return;
  const dumpSize = Math.min(actual, 8 * 1024 * 1024);
  try {
    const bytes = Memory.readByteArray(buffer, dumpSize);
    if (!bytes) return;
    send({
      type: 'bundle-dump',
      name: state.name,
      path: state.path,
      handle: state.key,
      api: api || null,
      readIndex,
      actual,
      dumpSize,
    }, bytes);
  } catch (e) {
    logSend({ type: 'err', where: 'bundle-dump', msg: String(e) });
  }
}

function rememberBundleHandle(handle, path, ctx) {
  if (!isValidHandle(handle)) return;
  const key = handle.toString();
  trackedBundleHandles[key] = {
    key,
    name: matchWatchedBundlePath(path),
    path,
    reads: 0,
  };
  logSend({
    type: 'bundle-file-open',
    handle: key,
    path,
    name: trackedBundleHandles[key].name,
    backtrace: shortBacktrace(ctx, 10),
  });
}

function forgetBundleHandle(handle) {
  if (!handle) return;
  const key = handle.toString();
  if (!trackedBundleHandles[key]) return;
  const state = trackedBundleHandles[key];
  delete trackedBundleHandles[key];
  logSend({ type: 'bundle-file-close', handle: key, path: state.path, reads: state.reads });
}

hookExport('kernel32.dll', 'CreateFileW', function (args) {
  this.bundlePath = readUtf16(args[0]);
  this.bundleName = matchWatchedBundlePath(this.bundlePath);
}, function (retval) {
  if (this.bundleName) rememberBundleHandle(retval, this.bundlePath, this.context);
});
hookExport('kernel32.dll', 'CreateFileA', function (args) {
  this.bundlePath = readAnsi(args[0]);
  this.bundleName = matchWatchedBundlePath(this.bundlePath);
}, function (retval) {
  if (this.bundleName) rememberBundleHandle(retval, this.bundlePath, this.context);
});
hookExport('kernel32.dll', 'ReadFile', function (args) {
  const key = args[0].toString();
  if (!trackedBundleHandles[key]) return;
  this.bundleState = trackedBundleHandles[key];
  this.handle = key;
  this.buffer = args[1];
  this.requested = args[2].toInt32();
  this.bytesReadPtr = args[3];
}, function () {
  if (!this.bundleState) return;
  let actual = 0;
  try {
    if (this.bytesReadPtr && !this.bytesReadPtr.isNull()) actual = this.bytesReadPtr.readU32();
  } catch (_) {}
  this.bundleState.reads += 1;
  const readIndex = this.bundleState.reads;
  const shouldSample = this.bundleState.reads <= 4 && actual > 0;
  logSend({
    type: 'bundle-file-read',
    handle: this.handle,
    path: this.bundleState.path,
    readIndex,
    requested: this.requested,
    actual,
    headHex: shouldSample ? readHex(this.buffer, Math.min(actual, 32)) : null,
  });
  maybeDumpBundleRead(this.bundleState, this.buffer, actual, 'ReadFile', readIndex);
});
hookExport('kernel32.dll', 'CloseHandle', function (args) {
  this.bundleHandle = args[0];
}, function () {
  forgetBundleHandle(this.bundleHandle);
});
hookExport('ntdll.dll', 'NtCreateFile', function (args) {
  this.bundlePath = readObjectAttributesPath(args[2]);
  this.bundleName = matchWatchedBundlePath(this.bundlePath);
  this.fileHandleOut = args[0];
}, function (retval) {
  if (!this.bundleName || retval.toInt32() < 0) return;
  try {
    rememberBundleHandle(this.fileHandleOut.readPointer(), this.bundlePath, this.context);
  } catch (_) {}
});
hookExport('ntdll.dll', 'NtOpenFile', function (args) {
  this.bundlePath = readObjectAttributesPath(args[2]);
  this.bundleName = matchWatchedBundlePath(this.bundlePath);
  this.fileHandleOut = args[0];
}, function (retval) {
  if (!this.bundleName || retval.toInt32() < 0) return;
  try {
    rememberBundleHandle(this.fileHandleOut.readPointer(), this.bundlePath, this.context);
  } catch (_) {}
});
hookExport('ntdll.dll', 'NtReadFile', function (args) {
  const key = args[0].toString();
  if (!trackedBundleHandles[key]) return;
  this.bundleState = trackedBundleHandles[key];
  this.handle = key;
  this.buffer = args[5];
  this.requested = args[6].toInt32();
  this.ioStatusBlock = args[4];
}, function (retval) {
  if (!this.bundleState || retval.toInt32() < 0) return;
  const actual = readIoStatusInformation(this.ioStatusBlock);
  this.bundleState.reads += 1;
  const readIndex = this.bundleState.reads;
  const shouldSample = this.bundleState.reads <= 4 && actual > 0;
  logSend({
    type: 'bundle-file-read',
    api: 'NtReadFile',
    handle: this.handle,
    path: this.bundleState.path,
    readIndex,
    requested: this.requested,
    actual,
    headHex: shouldSample ? readHex(this.buffer, Math.min(actual, 32)) : null,
  });
  maybeDumpBundleRead(this.bundleState, this.buffer, actual, 'NtReadFile', readIndex);
});

function findExportSafe(modName, expName) {
  // Frida API surface differs across versions; try every form we know.
  try {
    if (typeof Module.findExportByName === 'function') {
      const a = Module.findExportByName(modName, expName);
      if (a) return a;
    }
  } catch (_) {}
  try {
    if (typeof Module.getExportByName === 'function') {
      const a = Module.getExportByName(modName, expName);
      if (a) return a;
    }
  } catch (_) {}
  try {
    const m = modName ? Process.findModuleByName(modName) : null;
    if (m && typeof m.findExportByName === 'function') {
      const a = m.findExportByName(expName);
      if (a) return a;
    }
  } catch (_) {}
  try {
    for (const mod of Process.enumerateModules()) {
      if (modName && mod.name.toLowerCase() !== modName.toLowerCase()) continue;
      try {
        const exps = mod.enumerateExports();
        const e = exps.find((x) => x.name === expName);
        if (e) return e.address;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

function hookExport(modName, expName, onEnter, onLeave) {
  const addr = findExportSafe(modName, expName);
  if (!addr) return null;
  try {
    Interceptor.attach(addr, {
      onEnter(args) { try { onEnter && onEnter.call(this, args); } catch (e) { logSend({ type: 'err', where: expName, msg: String(e) }); } },
      onLeave(retval) { try { onLeave && onLeave.call(this, retval); } catch (e) { logSend({ type: 'err', where: expName, msg: String(e) }); } },
    });
  } catch (e) {
    logSend({ type: 'err', where: 'attach ' + expName, msg: String(e) });
    return null;
  }
  return addr;
}
function hookModuleOffset(modName, offsetHex, label, onEnter, onLeave) {
  const mod = Process.findModuleByName(modName);
  if (!mod) return null;
  const addr = mod.base.add(ptr(offsetHex));
  try {
    Interceptor.attach(addr, {
      onEnter(args) { try { onEnter && onEnter.call(this, args, addr, mod); } catch (e) { logSend({ type: 'err', where: label, msg: String(e) }); } },
      onLeave(retval) { try { onLeave && onLeave.call(this, retval, addr, mod); } catch (e) { logSend({ type: 'err', where: label + ' leave', msg: String(e) }); } },
    });
  } catch (e) {
    logSend({ type: 'err', where: 'attach ' + label, msg: String(e) });
    return null;
  }
  return addr;
}
function describePointerValue(arg) {
  return {
    raw: arg.toString(),
    ansi: readAnsi(arg),
    utf16: readUtf16(arg),
    unicode: readUnicodeStringStruct(arg),
  };
}

// ---- HTTP URL capture ------------------------------------------------------
const winhttpHostByHandle = {};
hookExport('winhttp.dll', 'WinHttpConnect', function (args) {
  this.host = readUtf16(args[1]); this.port = args[2].toInt32();
}, function (retval) {
  if (this.host) winhttpHostByHandle[retval.toString()] = { host: this.host, port: this.port };
});
hookExport('winhttp.dll', 'WinHttpOpenRequest', function (args) {
  const verb = readUtf16(args[1]); const obj = readUtf16(args[2]);
  const flags = args[6].toInt32(); const tls = (flags & 0x00800000) ? 'https' : 'http';
  const conn = winhttpHostByHandle[args[0].toString()] || {};
  logSend({ type: 'winhttp', verb, scheme: tls, host: conn.host || null, port: conn.port || null, path: obj });
});
hookExport('wininet.dll', 'InternetOpenUrlA', function (args) { logSend({ type: 'wininet-A', url: readAnsi(args[1]) }); });
hookExport('wininet.dll', 'InternetOpenUrlW', function (args) { logSend({ type: 'wininet-W', url: readUtf16(args[1]) }); });
const curlSetopt = findExportSafe(null, 'curl_easy_setopt');
if (curlSetopt) {
  try {
    Interceptor.attach(curlSetopt, {
      onEnter(args) {
        if (args[1].toInt32() === 10002) { const url = readAnsi(args[2]); if (url) logSend({ type: 'curl', url }); }
      },
    });
  } catch (e) { logSend({ type: 'err', where: 'curl_easy_setopt attach', msg: String(e) }); }
}

// ---- PakV5 stream-URL anchor ----------------------------------------------
function tryHookPakV5StreamUrl() {
  const mod = Process.findModuleByName('KGPK5_FileSystemX64.dll');
  if (!mod) { logSend({ type: 'note', msg: 'KGPK5_FileSystemX64.dll not loaded yet' }); return; }
  const ranges = mod.enumerateRanges('r--');
  const patterns = [
    { label: 'stream-body', hex: '25 73 68 2f 25 64 2f 25 73 2e 25 75 00' },
    { label: 'index-repo', hex: '25 73 2f 25 63 2f 25 63 2f 25 73 25 73 00' },
    { label: 'subpkg', hex: '25 73 2f 25 63 2f 25 63 2f 25 73 2e 25 64 25 73 00' },
  ];
  const found = [];
  for (const pattern of patterns) {
    for (const r of ranges) {
      try {
        const hits = Memory.scanSync(r.base, r.size, pattern.hex);
        if (hits.length) { found.push({ label: pattern.label, address: hits[0].address }); break; }
      } catch (_) {}
    }
  }
  if (!found.length) { logSend({ type: 'note', msg: 'pakv5 URL/path format strings not found' }); return; }
  const byAddress = {};
  for (const item of found) byAddress[item.address.toString()] = item.label;
  logSend({ type: 'note', msg: 'pakv5 fmt hooks at ' + found.map((item) => item.label + ':' + item.address).join(', ') });
  for (const fn of ['_snprintf', '_vsnprintf', 'sprintf_s', '_snprintf_s', 'sprintf', 'snprintf', 'vsnprintf', 'wsprintfA']) {
    const a = findExportSafe(null, fn);
    if (!a) continue;
    try {
      Interceptor.attach(a, {
        onEnter(args) {
          for (let i = 0; i < 8; i += 1) {
            const label = byAddress[args[i].toString()];
            if (!label) continue;
            this.matched = label;
            this.dest = args[0];
            this.fn = fn;
            break;
          }
        },
        onLeave() {
          if (this.matched && this.dest && !this.dest.isNull()) {
            const r = readAnsi(this.dest);
            if (r) logSend({ type: 'pakv5-streamurl', label: this.matched, fn: this.fn, value: r });
          }
        },
      });
    } catch (_) {}
  }
}
tryHookPakV5StreamUrl();

// ---- PakV5 bundle upgrade path ---------------------------------------------
const bundleFunctionSeen = {};
function shouldLogBundleFunction(label) {
  const next = (bundleFunctionSeen[label] || 0) + 1;
  bundleFunctionSeen[label] = next;
  return next <= 40;
}
const listPathHookSeen = {};
function shouldLogListPath(label) {
  const next = (listPathHookSeen[label] || 0) + 1;
  listPathHookSeen[label] = next;
  return next <= 24;
}
function capturePakV5FunctionArgs(args, count) {
  const argInfo = [];
  for (let i = 0; i < count; i += 1) argInfo.push(describePointerValue(args[i]));
  return argInfo;
}
function hookPakV5FunctionTarget(target) {
  const stateKey = `__pakv5_${String(target.label || 'target').replace(/[^A-Za-z0-9_]/g, '_')}_${String(target.offset || target.exportName || 'slot').replace(/[^A-Za-z0-9_]/g, '_')}`;
  const getStateStack = (ctx) => {
    if (!ctx[stateKey]) ctx[stateKey] = [];
    return ctx[stateKey];
  };
  const onEnter = function (args, addr, mod) {
    const state = {
      shouldLog: shouldLogBundleFunction(target.label),
      addrString: addr.toString(),
      modName: mod && mod.name ? mod.name : 'KGPK5_FileSystemX64.dll',
      moduleOffset: target.offset || null,
      threadIdValue: this.threadId,
      argInfo: null,
      bt: null,
    };
    getStateStack(this).push(state);
    if (!state.shouldLog) return;
    state.argInfo = capturePakV5FunctionArgs(args, target.argCount || 4);
    state.bt = shortBacktrace(this.context, 10);
    logSend({
      type: 'pakv5-bundle-fn-enter',
      fn: target.label,
      address: state.addrString,
      module: state.modName,
      moduleOffset: state.moduleOffset,
      threadId: state.threadIdValue,
      args: state.argInfo,
      backtrace: state.bt,
    });
  };
  const onLeave = function (retval, addr, mod) {
    const stack = this[stateKey];
    const state = stack && stack.length ? stack.pop() : null;
    if (stack && !stack.length) delete this[stateKey];
    if (!state || !state.shouldLog) return;
    logSend({
      type: 'pakv5-bundle-fn-leave',
      fn: target.label,
      address: state.addrString || addr.toString(),
      module: state.modName || (mod && mod.name ? mod.name : 'KGPK5_FileSystemX64.dll'),
      moduleOffset: state.moduleOffset,
      threadId: state.threadIdValue,
      retval: retval.toString(),
      args: state.argInfo,
      backtrace: state.bt,
    });
  };
  if (target.exportName) {
    const attached = hookExport('KGPK5_FileSystemX64.dll', target.exportName, function (args) {
      onEnter.call(this, args, findExportSafe('KGPK5_FileSystemX64.dll', target.exportName), { name: 'KGPK5_FileSystemX64.dll' });
    }, function (retval) {
      onLeave.call(this, retval, findExportSafe('KGPK5_FileSystemX64.dll', target.exportName), { name: 'KGPK5_FileSystemX64.dll' });
    });
    if (attached) logSend({ type: 'note', msg: `${target.label} hook at ${attached}` });
    return attached;
  }
  const attached = hookModuleOffset('KGPK5_FileSystemX64.dll', target.offset, target.label, onEnter, onLeave);
  if (attached) logSend({ type: 'note', msg: `${target.label} hook at ${attached}` });
  return attached;
}
function tryHookPakV5BundleFunctions() {
  const targets = [
    { label: 'g_UpgradeFileListPriority', exportName: 'g_UpgradeFileListPriority', argCount: 4 },
    { label: 'g_UpgradeFileListPriority', offset: '0x96715', argCount: 4 },
    { label: 'OpenPakV5StreamFile', offset: '0xc7caf', argCount: 4 },
    { label: 'OpenPakV5StreamFile_inner', offset: '0xc58cf', argCount: 4 },
    { label: 'g_PakV5WriteFileToLocal', exportName: 'g_PakV5WriteFileToLocal', argCount: 4 },
    { label: 'g_DownloadHttpFile', exportName: 'g_DownloadHttpFile', argCount: 4 },
    { label: 'g_GetFileListState', exportName: 'g_GetFileListState', argCount: 4 },
  ];
  for (const target of targets) {
    hookPakV5FunctionTarget(target);
  }
}
tryHookPakV5BundleFunctions();
function tryHookPakV5ListPath() {
  const modName = 'KGPK5_FileSystemX64.dll';
  const httpFileCommandHook = hookExport(modName, 'g_HttpFileCommand', function (args) {
    this.shouldLog = shouldLogListPath('g_HttpFileCommand');
    if (!this.shouldLog) return;
    this.command = readAnsi(args[0]);
    this.data = args[1];
    this.structSize = safeReadU32(args[1]);
    const slotBytes = Math.min(Math.max(this.structSize || 0, 32), 64);
    this.beforeSlots = readPointerSlots(args[1], slotBytes, 6);
    this.beforeAscii = readAsciiPreview(args[1], Math.min(slotBytes, 64));
    this.bt = shortBacktrace(this.context, 8);
    this.tid = this.threadId;
  }, function (retval) {
    if (!this.shouldLog) return;
    const slotBytes = Math.min(Math.max(this.structSize || 0, 32), 64);
    logSend({
      type: 'pakv5-list-path',
      fn: 'g_HttpFileCommand',
      command: this.command,
      threadId: this.tid,
      retval: retval.toString(),
      structSize: this.structSize,
      beforeSlots: this.beforeSlots,
      afterSlots: readPointerSlots(this.data, slotBytes, 6),
      beforeAscii: this.beforeAscii,
      afterAscii: readAsciiPreview(this.data, Math.min(slotBytes, 64)),
      backtrace: this.bt,
    });
  });
  if (httpFileCommandHook) logSend({ type: 'note', msg: `g_HttpFileCommand hook at ${httpFileCommandHook}` });

  const getAllFileListHook = hookExport(modName, 'g_GetPakV5AllFileList', function (args) {
    this.shouldLog = shouldLogListPath('g_GetPakV5AllFileList');
    if (!this.shouldLog) return;
    this.outDataPtr = args[0];
    this.outLenPtr = args[1];
    this.outVersionPtr = args[2];
    this.outDataBefore = safeReadPointer(args[0]);
    this.outLenBefore = safeReadU32(args[1]);
    this.outVersionBefore = safeReadU32(args[2]);
    this.bt = shortBacktrace(this.context, 8);
    this.tid = this.threadId;
    logSend({
      type: 'pakv5-list-path',
      fn: 'g_GetPakV5AllFileList:enter',
      threadId: this.tid,
      outDataBefore: this.outDataBefore ? this.outDataBefore.toString() : null,
      outLenBefore: this.outLenBefore,
      outVersionBefore: this.outVersionBefore,
      backtrace: this.bt,
    });
  }, function (retval) {
    if (!this.shouldLog) return;
    const listBase = safeReadPointer(this.outDataPtr);
    const outLen = safeReadU32(this.outLenPtr);
    const previewBytes = outLen && outLen > 0 && outLen < 4096 ? Math.min(outLen, 64) : 0;
    const canPreview = !!(listBase && isValidHandle(listBase) && previewBytes > 0);
    logSend({
      type: 'pakv5-list-path',
      fn: 'g_GetPakV5AllFileList',
      threadId: this.tid,
      retval: retval.toString(),
      outDataBefore: this.outDataBefore ? this.outDataBefore.toString() : null,
      outDataAfter: listBase ? listBase.toString() : null,
      outLenBefore: this.outLenBefore,
      outLenAfter: outLen,
      outVersionBefore: this.outVersionBefore,
      outVersionAfter: safeReadU32(this.outVersionPtr),
      previewHex: canPreview ? readHex(listBase, previewBytes) : null,
      previewAscii: canPreview ? readAsciiPreview(listBase, previewBytes) : null,
      backtrace: this.bt,
    });
  });
  if (getAllFileListHook) logSend({ type: 'note', msg: `g_GetPakV5AllFileList hook at ${getAllFileListHook}` });
}
tryHookPakV5ListPath();

// ---- EXPOSE DOWNLOAD API ---------------------------------------------------
let g_DownloadHttpFile = null, g_GetHttpFileInfo = null, g_PakV5WriteFileToLocal = null, g_GetPakV5AllFileList = null, g_GetFileListState = null, g_HashNumber2String = null, g_EnableHttpFile = null, g_GetPakV5Version = null, g_HttpFileCommand = null, g_HttpShellCommand = null, g_HttpMemoryFree = null, g_HttpGetBuffer3 = null, g_HttpGetBuffer4 = null;
let apiState = {
  ok: false,
  module: null,
  g_DownloadHttpFile: false,
  g_GetHttpFileInfo: false,
  g_PakV5WriteFileToLocal: false,
  g_GetPakV5AllFileList: false,
  g_GetFileListState: false,
  g_HashNumber2String: false,
  g_EnableHttpFile: false,
  g_GetPakV5Version: false,
  g_HttpFileCommand: false,
  g_HttpShellCommand: false,
  g_HttpMemoryFree: false,
  g_HttpGetBuffer: false,
};

function resolvePakV5Apis(options) {
  const silent = !!(options && options.silent);
  const m = Process.findModuleByName('KGPK5_FileSystemX64.dll');
  const dl = findExportSafe('KGPK5_FileSystemX64.dll', 'g_DownloadHttpFile');
  const gi = findExportSafe('KGPK5_FileSystemX64.dll', 'g_GetHttpFileInfo');
  const wl = findExportSafe('KGPK5_FileSystemX64.dll', 'g_PakV5WriteFileToLocal');
  const fl = findExportSafe('KGPK5_FileSystemX64.dll', 'g_GetPakV5AllFileList');
  const gs = findExportSafe('KGPK5_FileSystemX64.dll', 'g_GetFileListState');
  const hs = findExportSafe('KGPK5_FileSystemX64.dll', 'g_HashNumber2String');
  const eh = findExportSafe('KGPK5_FileSystemX64.dll', 'g_EnableHttpFile');
  const gv = findExportSafe('KGPK5_FileSystemX64.dll', 'g_GetPakV5Version');
  const hfc = findExportSafe('KGPK5_FileSystemX64.dll', 'g_HttpFileCommand');
  const hsc = findExportSafe('KGPK5_FileSystemX64.dll', 'g_HttpShellCommand');
  const hmf = findExportSafe('KGPK5_FileSystemX64.dll', 'g_HttpMemoryFree');
  const hgb = findExportSafe('KGPK5_FileSystemX64.dll', 'g_HttpGetBuffer');
  if (dl) g_DownloadHttpFile = new NativeFunction(dl, 'int', ['pointer', 'pointer']);
  if (gi) g_GetHttpFileInfo  = new NativeFunction(gi, 'int', ['pointer', 'pointer', 'pointer', 'pointer']);
  if (wl) g_PakV5WriteFileToLocal = new NativeFunction(wl, 'int', ['pointer', 'pointer']);
  if (fl) g_GetPakV5AllFileList = new NativeFunction(fl, 'int', ['pointer', 'pointer', 'pointer']);
  if (gs) g_GetFileListState = new NativeFunction(gs, 'int', ['uint32', 'pointer', 'pointer', 'pointer']);
  if (hs) g_HashNumber2String = new NativeFunction(hs, 'int', ['uint64', 'pointer', 'int']);
  if (eh) g_EnableHttpFile = new NativeFunction(eh, 'int', ['int']);
  if (gv) g_GetPakV5Version = new NativeFunction(gv, 'int', []);
  if (hfc) g_HttpFileCommand = new NativeFunction(hfc, 'int', ['pointer', 'pointer']);
  if (hsc) g_HttpShellCommand = new NativeFunction(hsc, 'int', ['pointer', 'pointer']);
  if (hmf) g_HttpMemoryFree = new NativeFunction(hmf, 'void', ['pointer']);
  if (hgb) {
    g_HttpGetBuffer3 = new NativeFunction(hgb, 'int', ['pointer', 'pointer', 'pointer']);
    g_HttpGetBuffer4 = new NativeFunction(hgb, 'int', ['pointer', 'pointer', 'pointer', 'pointer']);
  }
  apiState = {
    ok: !!(dl || wl || fl || gs || hs || eh || gv || hfc || hsc || hmf || hgb),
    module: m ? m.name : null,
    g_DownloadHttpFile: !!dl,
    g_GetHttpFileInfo: !!gi,
    g_PakV5WriteFileToLocal: !!wl,
    g_GetPakV5AllFileList: !!fl,
    g_GetFileListState: !!gs,
    g_HashNumber2String: !!hs,
    g_EnableHttpFile: !!eh,
    g_GetPakV5Version: !!gv,
    g_HttpFileCommand: !!hfc,
    g_HttpShellCommand: !!hsc,
    g_HttpMemoryFree: !!hmf,
    g_HttpGetBuffer: !!hgb,
  };
  if (!silent) logSend({ type: 'apis', ...apiState });
  return { ...apiState };
}
resolvePakV5Apis();

function ansi(s) { return Memory.allocAnsiString(String(s)); }
function toUInt64(value) {
  try { return new UInt64(String(value)); } catch (_) { return null; }
}
function withNativeTruthy(result) {
  return { ok: true, nativeTruthy: !!result.rc, ...result };
}

function callDownload(logical, localPath) {
  if (!g_DownloadHttpFile) {
    resolvePakV5Apis({ silent: true });
  }
  if (!g_DownloadHttpFile) return { ok: false, error: 'g_DownloadHttpFile not resolved' };
  try { return withNativeTruthy({ rc: g_DownloadHttpFile(ansi(logical), ansi(localPath)) }); }
  catch (e) { return { ok: false, error: String(e) }; }
}
function callWriteLocal(logical, localPath) {
  if (!g_PakV5WriteFileToLocal) {
    resolvePakV5Apis({ silent: true });
  }
  if (!g_PakV5WriteFileToLocal) return { ok: false, error: 'g_PakV5WriteFileToLocal not resolved' };
  try { return withNativeTruthy({ rc: g_PakV5WriteFileToLocal(ansi(logical), ansi(localPath)) }); }
  catch (e) { return { ok: false, error: String(e) }; }
}
function callGetInfo(logical) {
  if (!g_GetHttpFileInfo) {
    resolvePakV5Apis({ silent: true });
  }
  if (!g_GetHttpFileInfo) return { ok: false, error: 'g_GetHttpFileInfo not resolved' };
  try {
    const out = Memory.alloc(2048);
    const cap = Memory.alloc(8); cap.writeU64(2048);
    const actual = Memory.alloc(8); actual.writeU64(0);
    const rc = g_GetHttpFileInfo(ansi(logical), out, cap, actual);
    const used = actual.readU64().toNumber();
    return withNativeTruthy({ rc, used, asAnsi: readAnsi(out) });
  } catch (e) { return { ok: false, error: String(e) }; }
}
function callGetFileListState(fileListId) {
  if (!g_GetFileListState) {
    resolvePakV5Apis({ silent: true });
  }
  if (!g_GetFileListState) return { ok: false, error: 'g_GetFileListState not resolved' };
  try {
    const state = Memory.alloc(8);
    const downloadedSize = Memory.alloc(8);
    const totalSize = Memory.alloc(8);
    state.writeU64(0);
    downloadedSize.writeU64(0);
    totalSize.writeU64(0);
    const id = Math.max(0, Number(fileListId) || 0) >>> 0;
    const rc = g_GetFileListState(id, state, downloadedSize, totalSize);
    return withNativeTruthy({
      fileListId: id,
      rc,
      stateU32: state.readU32(),
      stateU64: state.readU64().toString(),
      downloadedSize: downloadedSize.readU64().toString(),
      totalSize: totalSize.readU64().toString(),
    });
  } catch (e) { return { ok: false, error: String(e) }; }
}
function describeHttpBufferObject(objectPtr, maxBytes) {
  if (!objectPtr || objectPtr.isNull()) return null;
  const sizeA = safeReadU32(objectPtr.add(20));
  const sizeB = safeReadU32(objectPtr.add(24));
  const dataPtr = safeReadPointer(objectPtr.add(32));
  const previewLimit = Math.min(Math.max(0, Number(maxBytes) || 8192), 1024 * 1024);
  const dataBytes = sizeA && sizeA < 256 * 1024 * 1024 ? Math.min(sizeA, previewLimit) : previewLimit;
  const previewText = dataPtr && !dataPtr.isNull() ? readAsciiPreview(dataPtr, dataBytes) : null;
  return {
    ptr: objectPtr.toString(),
    headerHex: readHex(objectPtr, 64),
    sizeA,
    sizeB,
    dataPtr: dataPtr ? dataPtr.toString() : null,
    dataPreviewBytes: dataPtr && !dataPtr.isNull() ? dataBytes : 0,
    dataPreviewHex: dataPtr && !dataPtr.isNull() ? readHex(dataPtr, Math.min(dataBytes, 512)) : null,
    dataPreviewText: previewText,
    dataPreviewItems: previewText ? splitListPreview(previewText).slice(0, 200) : [],
  };
}
function createHttpBufferObject(urlText) {
  if (!g_HttpGetBuffer3 || !g_HttpGetBuffer4) {
    resolvePakV5Apis({ silent: true });
  }
  if (!g_HttpGetBuffer3 || !g_HttpGetBuffer4) return { ok: false, error: 'g_HttpGetBuffer not resolved' };
  const outPtr = Memory.alloc(Process.pointerSize);
  const outLen = Memory.alloc(8);
  outPtr.writePointer(NULL);
  outLen.writeU64(0);
  const rc = g_HttpGetBuffer4(ansi(urlText), outPtr, outLen, NULL);
  const objectPtr = outPtr.readPointer();
  return { ok: !!rc, rc, objectPtr, outLenU32: outLen.readU32(), outLenU64: outLen.readU64().toString() };
}
function buildHttpFileCommandBuffer(commandText, requestedSize, options) {
  const settings = options || {};
  const layout = String(settings.layout || 'raw');
  const dirText = String(settings.dir || '');
  const subdirText = String(settings.subdir || '');
  const wantsGetHttpFileListShape = commandText === 'GetHttpFileList' && (layout !== 'raw' || dirText || subdirText);
  let size = Number(requestedSize) || 0;
  const wantsFileListObject = layout === 'fileListData' || layout === 'fileListDataHttpBufferObject';
  if (wantsGetHttpFileListShape && (layout === 'maxPathAnsi' || wantsFileListObject)) {
    const maxPath = Math.max(16, Math.min(1024, Number(settings.maxPath) || 260));
    const pointerOffset = wantsFileListObject
      ? Math.max(4 + (maxPath * 2), Number(settings.pointerOffset) || (4 + (maxPath * 2)))
      : 4 + (maxPath * 2);
    const payloadSize = pointerOffset + Process.pointerSize;
    const alignedPayloadSize = Process.pointerSize > 4 ? ((payloadSize + 7) & ~7) : payloadSize;
    if (!size) size = alignedPayloadSize;
    size = Math.max(size, alignedPayloadSize);
  } else if (wantsGetHttpFileListShape && layout === 'pointerAnsi') {
    const headerSize = Process.pointerSize > 4 ? 8 : 4;
    const payloadSize = headerSize + (Process.pointerSize * 3);
    if (!size) size = payloadSize;
    size = Math.max(size, payloadSize);
  }
  size = Math.max(16, Math.min(4096, size || 32));
  const data = Memory.alloc(size);
  data.writeByteArray(new Uint8Array(size));
  data.writeU32(size);
  const layoutInfo = { layout };
  let outputBuffer = null;
  let outputObject = null;
  if (wantsGetHttpFileListShape && (layout === 'maxPathAnsi' || wantsFileListObject)) {
    const maxPath = Math.max(16, Math.min(1024, Number(settings.maxPath) || 260));
    writeAnsiField(data, 4, dirText, maxPath);
    writeAnsiField(data, 4 + maxPath, subdirText, maxPath);
    layoutInfo.dir = dirText;
    layoutInfo.subdir = subdirText;
    layoutInfo.maxPath = maxPath;
    layoutInfo.dirOffset = 4;
    layoutInfo.subdirOffset = 4 + maxPath;
    layoutInfo.dirEcho = readAnsiField(data, 4, maxPath);
    layoutInfo.subdirEcho = readAnsiField(data, 4 + maxPath, maxPath);
    if (wantsFileListObject) {
      const naturalOffset = 4 + (maxPath * 2);
      const pointerOffset = Math.max(naturalOffset, Number(settings.pointerOffset) || naturalOffset);
      const alignedPointerOffset = Process.pointerSize > 4 ? ((pointerOffset + 7) & ~7) : pointerOffset;
      layoutInfo.pointerOffset = alignedPointerOffset;
      if (layout === 'fileListDataHttpBufferObject') {
        const objectUrl = String(settings.objectUrl || 'https://jx3v5hw-editor-update.xoyocdn.com/pkgs_editor/trunk_editor/v/2/_all_sidx_filename_list');
        const objectResult = createHttpBufferObject(objectUrl);
        outputObject = objectResult.objectPtr || NULL;
        data.add(alignedPointerOffset).writePointer(outputObject);
        layoutInfo.objectUrl = objectUrl;
        layoutInfo.objectCreateRc = objectResult.rc;
        layoutInfo.objectOutLenU32 = objectResult.outLenU32;
        layoutInfo.objectPtr = outputObject.toString();
        layoutInfo.objectBefore = describeHttpBufferObject(outputObject, Number(settings.previewBytes) || 512);
      } else {
        const outSize = Math.min(64 * 1024 * 1024, Math.max(4096, Number(settings.outBufferSize) || (8 * 1024 * 1024)));
        outputBuffer = Memory.alloc(outSize);
        outputBuffer.writeByteArray(new Uint8Array(Math.min(outSize, 1024 * 1024)));
        data.add(alignedPointerOffset).writePointer(outputBuffer);
        layoutInfo.outBufferPtr = outputBuffer.toString();
        layoutInfo.outBufferSize = outSize;
      }
    }
  } else if (wantsGetHttpFileListShape && layout === 'pointerAnsi') {
    const headerSize = Process.pointerSize > 4 ? 8 : 4;
    const dirPtr = Memory.allocAnsiString(dirText);
    const subdirPtr = Memory.allocAnsiString(subdirText);
    data.add(headerSize).writePointer(dirPtr);
    data.add(headerSize + Process.pointerSize).writePointer(subdirPtr);
    layoutInfo.dir = dirText;
    layoutInfo.subdir = subdirText;
    layoutInfo.headerSize = headerSize;
    layoutInfo.dirPtr = dirPtr.toString();
    layoutInfo.subdirPtr = subdirPtr.toString();
  }
  return { data, size, layoutInfo, outputBuffer, outputObject };
}
function callHttpFileCommand(command, structSize, options) {
  if (!g_HttpFileCommand) {
    resolvePakV5Apis({ silent: true });
  }
  if (!g_HttpFileCommand) return { ok: false, error: 'g_HttpFileCommand not resolved' };
  try {
    const commandText = String(command || '');
    const built = buildHttpFileCommandBuffer(commandText, structSize, options);
    const data = built.data;
    const size = built.size;
    const rc = g_HttpFileCommand(ansi(commandText), data);
    return withNativeTruthy({
      rc,
      command: commandText,
      structSize: size,
      layout: built.layoutInfo,
      headHex: readHex(data, Math.min(size, 256)),
      headAscii: readAsciiPreview(data, Math.min(size, 128)),
      slots: readPointerSlots(data, size, 8),
      outputBuffer: built.outputBuffer ? {
        ptr: built.outputBuffer.toString(),
        previewHex: readHex(built.outputBuffer, Math.min(Number(options && options.previewBytes) || 512, 8192)),
        previewAscii: readAsciiPreview(built.outputBuffer, Math.min(Number(options && options.previewBytes) || 512, 8192)),
        previewItems: splitListPreview(readAsciiPreview(built.outputBuffer, Math.min(Number(options && options.previewBytes) || 8192, 65536))).slice(0, 200),
      } : null,
      outputObject: built.outputObject ? describeHttpBufferObject(built.outputObject, Number(options && options.previewBytes) || 8192) : null,
    });
  } catch (e) { return { ok: false, error: String(e) }; }
}
function callHttpGetBuffer(urlValue, variant, maxBytes) {
  if (!g_HttpGetBuffer3 || !g_HttpGetBuffer4) {
    resolvePakV5Apis({ silent: true });
  }
  if (!g_HttpGetBuffer3 || !g_HttpGetBuffer4) return { ok: false, error: 'g_HttpGetBuffer not resolved' };
  const urlText = String(urlValue || '').trim();
  if (!urlText) return { ok: false, error: 'url is required' };
  const mode = String(variant || 'urlOutLenNull');
  try {
    const outPtr = Memory.alloc(Process.pointerSize);
    const outLen = Memory.alloc(8);
    outPtr.writePointer(NULL);
    outLen.writeU64(0);
    const urlPtr = ansi(urlText);
    let rc;
    if (mode === 'urlNullOutLen') {
      rc = g_HttpGetBuffer4(urlPtr, NULL, outPtr, outLen);
    } else if (mode === 'urlOutLen') {
      rc = g_HttpGetBuffer3(urlPtr, outPtr, outLen);
    } else {
      rc = g_HttpGetBuffer4(urlPtr, outPtr, outLen, NULL);
    }
    const resultPtr = outPtr.readPointer();
    const len64 = outLen.readU64();
    let totalBytes = 0;
    try { totalBytes = len64.toNumber(); } catch (_) { totalBytes = 0; }
    const byteLimit = Math.min(Math.max(0, Number(maxBytes) || 8192), 1024 * 1024);
    const canPreview = resultPtr && !resultPtr.isNull() && (totalBytes === 0 || (totalBytes > 0 && totalBytes < 256 * 1024 * 1024));
    const previewBytes = canPreview ? (totalBytes > 0 ? Math.min(totalBytes, byteLimit) : byteLimit) : 0;
    const previewText = canPreview ? readAsciiPreview(resultPtr, previewBytes) : null;
    const result = withNativeTruthy({
      rc,
      url: urlText,
      variant: mode,
      resultPtr: resultPtr.toString(),
      totalBytes,
      outLenU32: outLen.readU32(),
      previewBytes,
      previewHex: canPreview ? readHex(resultPtr, Math.min(previewBytes, 512)) : null,
      previewText,
      totalPreviewItems: previewText ? splitListPreview(previewText).length : 0,
      items: previewText ? splitListPreview(previewText).slice(0, 200) : [],
    });
    if (g_HttpMemoryFree && resultPtr && !resultPtr.isNull()) {
      try { g_HttpMemoryFree(resultPtr); } catch (_) {}
    }
    return result;
  } catch (e) { return { ok: false, error: String(e), url: urlText, variant: mode }; }
}
function callHttpShellCommand(message) {
  if (!g_HttpShellCommand) {
    resolvePakV5Apis({ silent: true });
  }
  if (!g_HttpShellCommand) return { ok: false, error: 'g_HttpShellCommand not resolved' };
  try {
    const resultPtrOut = Memory.alloc(Process.pointerSize);
    resultPtrOut.writePointer(NULL);
    const messageText = String(message || '');
    const rc = g_HttpShellCommand(ansi(messageText), resultPtrOut);
    const resultPtr = resultPtrOut.readPointer();
    const result = withNativeTruthy({
      rc,
      message: messageText,
      resultPtr: resultPtr.toString(),
      resultAnsi: readAnsi(resultPtr),
      resultUtf16: readUtf16(resultPtr),
      resultHex: resultPtr.isNull() ? null : readHex(resultPtr, 128),
      resultAscii: resultPtr.isNull() ? null : readAsciiPreview(resultPtr, 128),
    });
    if (g_HttpMemoryFree && resultPtr && !resultPtr.isNull()) {
      try { g_HttpMemoryFree(resultPtr); } catch (_) {}
    }
    return result;
  } catch (e) { return { ok: false, error: String(e) }; }
}
function callReadProcessFile(pathValue, maxBytes) {
  const apiState = resolveWinFileApis();
  if (!apiState.createFile || !apiState.readFile || !apiState.closeHandle) {
    return { ok: false, error: 'kernel32 file apis not resolved', apiState };
  }
  const targetPath = String(pathValue || '').trim();
  if (!targetPath) return { ok: false, error: 'path is required' };
  const byteLimit = Math.min(8 * 1024 * 1024, Math.max(4096, Number(maxBytes) || 256 * 1024));
  const GENERIC_READ = 0x80000000;
  const FILE_SHARE_READ = 0x00000001;
  const FILE_SHARE_WRITE = 0x00000002;
  const FILE_SHARE_DELETE = 0x00000004;
  const OPEN_EXISTING = 3;
  const FILE_ATTRIBUTE_NORMAL = 0x00000080;
  const handle = k32CreateFileW(Memory.allocUtf16String(targetPath), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (!isValidHandle(handle)) {
    return { ok: false, error: 'CreateFileW failed', path: targetPath, handle: handle.toString() };
  }
  const chunks = [];
  let totalRead = 0;
  try {
    while (totalRead < byteLimit) {
      const want = Math.min(64 * 1024, byteLimit - totalRead);
      const buffer = Memory.alloc(want);
      const bytesReadPtr = Memory.alloc(4);
      bytesReadPtr.writeU32(0);
      const success = k32ReadFile(handle, buffer, want, bytesReadPtr, NULL);
      const actual = bytesReadPtr.readU32();
      if (!success || actual <= 0) break;
      const data = Memory.readByteArray(buffer, actual);
      if (!data) break;
      const chunk = new Uint8Array(data);
      chunks.push(chunk);
      totalRead += actual;
      if (actual < want) break;
    }
    const joined = new Uint8Array(totalRead);
    let offset = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      joined.set(chunks[index], offset);
      offset += chunks[index].length;
    }
    const previewText = bytesToAscii(joined, 8192);
    const previewItems = splitListPreview(previewText || '');
    return {
      ok: true,
      path: targetPath,
      byteLimit,
      bytesRead: totalRead,
      previewHex: bytesToHex(joined, 256),
      previewText,
      totalPreviewItems: previewItems.length,
      items: previewItems.slice(0, 200),
    };
  } catch (e) {
    return { ok: false, error: String(e), path: targetPath, bytesRead: totalRead };
  } finally {
    try { k32CloseHandle(handle); } catch (_) {}
  }
}
function callGetAllFileList(offset, limit) {
  if (!g_GetPakV5AllFileList) {
    resolvePakV5Apis({ silent: true });
  }
  if (!g_GetPakV5AllFileList) return { ok: false, error: 'g_GetPakV5AllFileList not resolved' };
  try {
    const enableHttpRc = g_EnableHttpFile ? g_EnableHttpFile(1) : null;
    const versionBefore = g_GetPakV5Version ? g_GetPakV5Version() : null;
    const outData = Memory.alloc(Process.pointerSize);
    outData.writePointer(NULL);
    const outLen = Memory.alloc(4);
    outLen.writeU32(0);
    const outVersion = Memory.alloc(4);
    outVersion.writeU32(0);
    const rc = g_GetPakV5AllFileList(outData, outLen, outVersion);
    const totalBytes = outLen.readU32();
    const version = outVersion.readU32();
    const versionAfter = g_GetPakV5Version ? g_GetPakV5Version() : null;
    const listBase = outData.readPointer();
    const listBaseHex = listBase.toString();
    const start = Math.max(0, Number(offset) || 0);
    const pageSize = Math.min(2000, Math.max(0, Number(limit) || 200));
    const previewBytes = Math.min(totalBytes, 8192);
    const canReadPreview = totalBytes > 0 && totalBytes < 100_000_000 && !listBase.isNull() && listBaseHex !== '0xffffffffffffffff';
    const previewText = canReadPreview ? readAsciiPreview(listBase, previewBytes) : null;
    const previewItems = splitListPreview(previewText || '');
    const end = Math.min(previewItems.length, start + pageSize);
    const items = previewItems.slice(start, end);
    return withNativeTruthy({
      rc,
      enableHttpRc,
      versionBefore,
      totalBytes,
      version,
      versionAfter,
      listBase: listBaseHex,
      offset: start,
      limit: pageSize,
      previewBytes,
      previewHex: canReadPreview ? readHex(listBase, Math.min(previewBytes, 256)) : null,
      previewText,
      totalItems: previewItems.length,
      items,
    });
  } catch (e) { return { ok: false, error: String(e) }; }
}
function callHashToString(hash) {
  if (!g_HashNumber2String) {
    resolvePakV5Apis({ silent: true });
  }
  if (!g_HashNumber2String) return { ok: false, error: 'g_HashNumber2String not resolved' };
  const value = toUInt64(hash);
  if (!value) return { ok: false, error: 'invalid uint64 hash' };
  try {
    const out = Memory.alloc(4096);
    out.writeByteArray(new Uint8Array(4096));
    const rc = g_HashNumber2String(value, out, 4096);
    return withNativeTruthy({
      rc,
      hash: value.toString(),
      value: readAnsi(out),
    });
  } catch (e) { return { ok: false, error: String(e) }; }
}
function callResolveAddress(addressValue) {
  try {
    const address = ptr(String(addressValue));
    const mod = Process.findModuleByAddress(address);
    const symbol = DebugSymbol.fromAddress(address);
    return {
      ok: true,
      address: address.toString(),
      symbol: symbol ? symbol.toString() : null,
      module: mod ? mod.name : null,
      modulePath: mod ? mod.path : null,
      moduleBase: mod ? mod.base.toString() : null,
      moduleOffset: mod ? '0x' + address.sub(mod.base).toString(16) : null,
    };
  } catch (e) {
    return { ok: false, error: String(e), address: String(addressValue) };
  }
}

function setupRecv() {
  recv('cmd', function onCmd(msg) {
    setupRecv(); // re-arm
    const c = msg.payload || {}; let result;
    if (c.cmd === 'download')      result = callDownload(c.logical, c.localPath);
    else if (c.cmd === 'writeLocal') result = callWriteLocal(c.logical, c.localPath);
    else if (c.cmd === 'getInfo')    result = callGetInfo(c.logical);
    else if (c.cmd === 'getFileListState') result = callGetFileListState(c.fileListId);
    else if (c.cmd === 'httpFileCommand') result = callHttpFileCommand(c.command, c.structSize, c);
    else if (c.cmd === 'httpGetBuffer') result = callHttpGetBuffer(c.url, c.variant, c.maxBytes);
    else if (c.cmd === 'httpShellCommand') result = callHttpShellCommand(c.message);
    else if (c.cmd === 'readProcessFile') result = callReadProcessFile(c.path, c.maxBytes);
    else if (c.cmd === 'getAllFileList') result = callGetAllFileList(c.offset, c.limit);
    else if (c.cmd === 'hashToString') result = callHashToString(c.hash);
    else if (c.cmd === 'resolveAddress') result = callResolveAddress(c.address);
    else if (c.cmd === 'resolveApis') result = resolvePakV5Apis();
    else if (c.cmd === 'getApiState') result = resolvePakV5Apis({ silent: true });
    else result = { ok: false, error: 'unknown cmd ' + c.cmd };
    logSend({ type: 'cmdResult', id: c.id, cmd: c.cmd, result });
  });
}
setupRecv();

logSend({ type: 'ready', pid: Process.id });
