// Frida agent for runtime audio and animation-resource tracing in the JX3 client.
// It logs Wwise/FMOD calls plus animation/effect file opens with stack traces.

const hooked = new Set();
const idToName = Object.create(null);
const soundNames = Object.create(null);
const eventNames = Object.create(null);

const wwiseModules = [
  'KG3D_WwiseX64.dll',
  'KG3D_WwiseProfileX64.dll',
];

const animationResourceExtRe = /\.(?:ani|tani|pss|sfx|mesh|mdl|dds|tga|jsondef|track|mtl|wav|wem|bnk)(?:$|[\s?#])/i;
const animationResourceTokenRe = /^(.*?\.(?:ani|tani|pss|sfx|mesh|mdl|dds|tga|jsondef|track|mtl|wav|wem|bnk))(?:$|[^A-Za-z0-9_.\\/-].*)/i;

function trimRuntimeResourceToken(value) {
  const text = String(value || '').replace(/\0/g, '').trim();
  const match = text.match(animationResourceTokenRe);
  return match ? match[1] : text;
}

function normalizeRuntimeResourcePath(value) {
  return trimRuntimeResourceToken(value)
    .replace(/\//g, '\\')
    .slice(0, 260);
}

function classifyRuntimeResourcePath(value) {
  const path = normalizeRuntimeResourcePath(value);
  const lower = path.toLowerCase();
  if (/\.tani$/i.test(lower)) return 'timeline';
  if (/\.ani$/i.test(lower)) return 'action';
  if (/\.pss$/i.test(lower)) return 'effect';
  if (/\.sfx$/i.test(lower)) return 'legacy-effect';
  if (/\.(?:mesh|mdl)$/i.test(lower)) return 'mesh';
  if (/\.(?:dds|tga|jsondef|mtl)$/i.test(lower)) return 'material';
  if (/\.track$/i.test(lower)) return 'track';
  if (/\.(?:wem|wav|bnk)$/i.test(lower)) return 'audio';
  return 'other';
}

function isRuntimeAnimationResourcePath(value) {
  const path = normalizeRuntimeResourcePath(value);
  if (!path || !animationResourceExtRe.test(path)) return false;
  if (/\\windows\\|\\program files\\|\\appdata\\|\\system32\\/i.test(path)) return false;
  return /data\\|source\\|wwiseaudio|generatedsoundbanks|movieeditor|seasun|jx3/i.test(path);
}

function collectAnimationResourceStrings(value, out) {
  const text = String(value || '');
  if (!text) return;
  const patterns = [
    /[A-Za-z]:[\\/][^|<>"'\r\n\0]{1,240}?\.(?:ani|tani|pss|sfx|mesh|mdl|dds|tga|jsondef|track|mtl|wav|wem|bnk)\b/gi,
    /data[\\/][^|<>"'\r\n\0]{1,220}?\.(?:ani|tani|pss|sfx|mesh|mdl|dds|tga|jsondef|track|mtl|wav|wem|bnk)\b/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) && out.length < 24) {
      const path = normalizeRuntimeResourcePath(match[0]);
      if (isRuntimeAnimationResourcePath(path) && out.indexOf(path) < 0) out.push(path);
    }
  }
}

function collectProbeAnimationResources(probe, out) {
  if (!probe || typeof probe !== 'object' || out.length >= 24) return;
  collectAnimationResourceStrings(probe.ansi, out);
  collectAnimationResourceStrings(probe.utf16, out);
  for (const value of probe.asciiStrings || []) collectAnimationResourceStrings(value, out);
  for (const value of probe.utf16Strings || []) collectAnimationResourceStrings(value, out);
  for (const nested of probe.pointers || []) collectProbeAnimationResources(nested, out);
}

const exportsToHook = {
  wwisePostEventId: '?PostEvent@SoundEngine@AK@@YAII_KIP6AXW4AkCallbackType@@PEAUAkCallbackInfo@@@ZPEAXIPEAUAkExternalSourceInfo@@I@Z',
  wwisePostEventAnsi: '?PostEvent@SoundEngine@AK@@YAIPEBD_KIP6AXW4AkCallbackType@@PEAUAkCallbackInfo@@@ZPEAXIPEAUAkExternalSourceInfo@@I@Z',
  wwisePostEventWide: '?PostEvent@SoundEngine@AK@@YAIPEB_W_KIP6AXW4AkCallbackType@@PEAUAkCallbackInfo@@@ZPEAXIPEAUAkExternalSourceInfo@@I@Z',
  wwiseGetIdAnsi: '?GetIDFromString@SoundEngine@AK@@YAIPEBD@Z',
  wwiseGetIdWide: '?GetIDFromString@SoundEngine@AK@@YAIPEB_W@Z',
  wwiseLoadBankId: '?LoadBank@SoundEngine@AK@@YA?AW4AKRESULT@@I@Z',
  wwiseLoadBankAnsi: '?LoadBank@SoundEngine@AK@@YA?AW4AKRESULT@@PEBDAEAI@Z',
  wwiseLoadBankWide: '?LoadBank@SoundEngine@AK@@YA?AW4AKRESULT@@PEB_WAEAI@Z',
  wwiseRegisterGameObj: '?RegisterGameObj@SoundEngine@AK@@YA?AW4AKRESULT@@_K@Z',
  wwiseRegisterGameObjName: '?RegisterGameObj@SoundEngine@AK@@YA?AW4AKRESULT@@_KPEBD@Z',
  wwiseSetSwitchId: '?SetSwitch@SoundEngine@AK@@YA?AW4AKRESULT@@II_K@Z',
  wwiseSetSwitchAnsi: '?SetSwitch@SoundEngine@AK@@YA?AW4AKRESULT@@PEBD0_K@Z',
  wwiseSetSwitchWide: '?SetSwitch@SoundEngine@AK@@YA?AW4AKRESULT@@PEB_W0_K@Z',
  wwiseSetStateId: '?SetState@SoundEngine@AK@@YA?AW4AKRESULT@@II@Z',
  wwiseSetStateAnsi: '?SetState@SoundEngine@AK@@YA?AW4AKRESULT@@PEBD0@Z',
  wwiseSetStateWide: '?SetState@SoundEngine@AK@@YA?AW4AKRESULT@@PEB_W0@Z',
  wwisePostTriggerId: '?PostTrigger@SoundEngine@AK@@YA?AW4AKRESULT@@I_K@Z',
  wwisePostTriggerAnsi: '?PostTrigger@SoundEngine@AK@@YA?AW4AKRESULT@@PEBD_K@Z',
  wwisePostTriggerWide: '?PostTrigger@SoundEngine@AK@@YA?AW4AKRESULT@@PEB_W_K@Z',
  wwiseSetRtpcId: '?SetRTPCValue@SoundEngine@AK@@YA?AW4AKRESULT@@IM_KHW4AkCurveInterpolation@@_N@Z',
  wwiseSetRtpcAnsi: '?SetRTPCValue@SoundEngine@AK@@YA?AW4AKRESULT@@PEBDM_KHW4AkCurveInterpolation@@_N@Z',
  wwiseSetRtpcWide: '?SetRTPCValue@SoundEngine@AK@@YA?AW4AKRESULT@@PEB_WM_KHW4AkCurveInterpolation@@_N@Z',
  wwiseActionEventId: '?ExecuteActionOnEvent@SoundEngine@AK@@YA?AW4AKRESULT@@IW4AkActionOnEventType@12@_KHW4AkCurveInterpolation@@I@Z',
  wwiseActionEventAnsi: '?ExecuteActionOnEvent@SoundEngine@AK@@YA?AW4AKRESULT@@PEBDW4AkActionOnEventType@12@_KHW4AkCurveInterpolation@@I@Z',
  wwiseActionEventWide: '?ExecuteActionOnEvent@SoundEngine@AK@@YA?AW4AKRESULT@@PEB_WW4AkActionOnEventType@12@_KHW4AkCurveInterpolation@@I@Z',
  wwiseStopPlayingId: '?StopPlayingID@SoundEngine@AK@@YAXIHW4AkCurveInterpolation@@@Z',
};

function sendLog(payload) {
  try {
    send({ t: Date.now(), ...payload });
  } catch (_) {}
}

function readAnsi(ptrValue) {
  try {
    if (!ptrValue || ptrValue.isNull()) return '';
    if (typeof ptrValue.readCString === 'function') return ptrValue.readCString() || '';
  } catch (_) {}
  try { return Memory.readCString(ptrValue) || ''; } catch (_) { return ''; }
}

function readUtf16(ptrValue) {
  try {
    if (!ptrValue || ptrValue.isNull()) return '';
    if (typeof ptrValue.readUtf16String === 'function') return ptrValue.readUtf16String() || '';
  } catch (_) {}
  try { return Memory.readUtf16String(ptrValue) || ''; } catch (_) { return ''; }
}

function cleanProbeText(value) {
  const text = String(value || '').replace(/\0/g, '').trim();
  if (!text) return '';
  let printable = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 32 && code !== 127) printable++;
  }
  if (printable / Math.max(1, text.length) < 0.75) return '';
  return text.slice(0, 180);
}

function readAnsiBounded(ptrValue, maxLen) {
  try {
    if (!ptrValue || ptrValue.isNull()) return '';
    if (typeof ptrValue.readCString === 'function') return cleanProbeText(ptrValue.readCString(maxLen || 180) || '');
  } catch (_) {}
  try { return cleanProbeText(Memory.readCString(ptrValue, maxLen || 180) || ''); } catch (_) { return ''; }
}

function readUtf16Bounded(ptrValue, maxLen) {
  try {
    if (!ptrValue || ptrValue.isNull()) return '';
    if (typeof ptrValue.readUtf16String === 'function') return cleanProbeText(ptrValue.readUtf16String(maxLen || 180) || '');
  } catch (_) {}
  try { return cleanProbeText(Memory.readUtf16String(ptrValue, maxLen || 180) || ''); } catch (_) { return ''; }
}

function u32(value) {
  try {
    return value.toInt32() >>> 0;
  } catch (_) {
    return null;
  }
}

function u64(value) {
  try {
    return value.toString();
  } catch (_) {
    return null;
  }
}

function keyOf(value) {
  try {
    if (!value || value.isNull()) return '';
    return value.toString();
  } catch (_) {
    return '';
  }
}

function rawArgs(args, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(keyOf(args[i]));
  return out;
}

function readBytes(ptrValue, count) {
  try {
    if (!ptrValue || ptrValue.isNull()) return '';
    const data = typeof ptrValue.readByteArray === 'function' ? ptrValue.readByteArray(count) : Memory.readByteArray(ptrValue, count);
    if (data) return new Uint8Array(data);
  } catch (_) {
    try {
      if (typeof Memory.readVolatile === 'function') {
        const data = Memory.readVolatile(ptrValue, count);
        if (data) return new Uint8Array(data);
      }
    } catch (__) {}
  }
  return null;
}

function readHex(ptrValue, count) {
  const bytes = readBytes(ptrValue, count);
  if (!bytes) return '';
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

function bytesToHex(bytes) {
  if (!bytes) return '';
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readNullTerminatedBytes(ptrValue, maxLen) {
  const bytes = readBytes(ptrValue, maxLen || 260);
  if (!bytes) return null;
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  return bytes.slice(0, end);
}

function readAnsiPathWithBytes(ptrValue, maxLen) {
  const bytes = readNullTerminatedBytes(ptrValue, maxLen || 260);
  const rawPath = readAnsiBounded(ptrValue, maxLen || 260);
  return {
    rawPath,
    pathBytesHex: bytesToHex(bytes),
    pathByteLength: bytes ? bytes.length : 0,
    pathEncoding: 'ansi',
  };
}

function readUtf16Path(ptrValue, maxLen) {
  return {
    rawPath: readUtf16Bounded(ptrValue, maxLen || 260),
    pathEncoding: 'utf16',
  };
}

function readAsciiStrings(ptrValue, count) {
  const bytes = readBytes(ptrValue, count);
  if (!bytes) return [];
  const strings = [];
  let run = '';
  for (const byte of bytes) {
    if (byte >= 32 && byte <= 126) {
      run += String.fromCharCode(byte);
    } else {
      if (run.length >= 4) strings.push(run.slice(0, 180));
      run = '';
    }
  }
  if (run.length >= 4) strings.push(run.slice(0, 180));
  return strings.slice(0, 12);
}

function readUtf16Strings(ptrValue, count) {
  const bytes = readBytes(ptrValue, count);
  if (!bytes) return [];
  const strings = [];
  let run = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (code >= 32 && code <= 126) {
      run += String.fromCharCode(code);
    } else {
      if (run.length >= 4) strings.push(run.slice(0, 180));
      run = '';
    }
  }
  if (run.length >= 4) strings.push(run.slice(0, 180));
  return strings.slice(0, 12);
}

function readPointerSafe(ptrValue, offset) {
  try {
    if (!ptrValue || ptrValue.isNull()) return null;
    const address = ptrValue.add(offset || 0);
    if (typeof address.readPointer === 'function') return address.readPointer();
  } catch (_) {}
  try { return Memory.readPointer(ptrValue.add(offset || 0)); } catch (_) { return null; }
}

function readU32At(ptrValue, offset) {
  try {
    if (!ptrValue || ptrValue.isNull()) return null;
    const address = ptrValue.add(offset || 0);
    if (typeof address.readU32 === 'function') return address.readU32() >>> 0;
  } catch (_) {}
  try { return Memory.readU32(ptrValue.add(offset || 0)) >>> 0; } catch (_) { return null; }
}

function probePointer(ptrValue, count) {
  if (!ptrValue || ptrValue.isNull()) return null;
  const span = Math.min(Math.max(Number(count) || 128, 32), 512);
  const probe = {
    address: keyOf(ptrValue),
    u32: u32(ptrValue),
    ansi: readAnsiBounded(ptrValue),
    utf16: readUtf16Bounded(ptrValue),
    bytes: readHex(ptrValue, Math.min(span, 160)),
    asciiStrings: readAsciiStrings(ptrValue, span),
    utf16Strings: readUtf16Strings(ptrValue, span),
    u32Fields: [],
    pointers: [],
  };
  for (let offset = 0; offset < Math.min(span, 96); offset += 4) {
    const value = readU32At(ptrValue, offset);
    if (value != null) probe.u32Fields.push({ offset: `0x${offset.toString(16)}`, value });
  }
  for (let offset = 0; offset < Math.min(span, 96); offset += Process.pointerSize) {
    const pointed = readPointerSafe(ptrValue, offset);
    if (!pointed || pointed.isNull()) continue;
    const entry = {
      offset: `0x${offset.toString(16)}`,
      ptr: keyOf(pointed),
      u32: u32(pointed),
      ansi: readAnsiBounded(pointed),
      utf16: readUtf16Bounded(pointed),
      bytes: readHex(pointed, 48),
      asciiStrings: readAsciiStrings(pointed, 96).slice(0, 4),
      utf16Strings: readUtf16Strings(pointed, 96).slice(0, 4),
    };
    if (entry.ansi || entry.utf16 || entry.bytes || entry.asciiStrings.length || entry.utf16Strings.length) probe.pointers.push(entry);
  }
  return probe;
}

function captureCallContext(context) {
  const registers = {};
  for (const name of ['rcx', 'rdx', 'r8', 'r9', 'rsp', 'rax', 'rbx', 'rbp', 'rsi', 'rdi']) {
    try { if (context && context[name]) registers[name] = keyOf(context[name]); } catch (_) {}
  }
  const stack = [];
  try {
    if (context && context.rsp) {
      for (let i = 0; i < 12; i++) {
        const offset = i * Process.pointerSize;
        stack.push({ offset: `0x${offset.toString(16)}`, value: keyOf(readPointerSafe(context.rsp, offset)) });
      }
    }
  } catch (_) {}
  return { registers, stack };
}

function stackTrace(context) {
  let frames = [];
  try {
    frames = Thread.backtrace(context, Backtracer.ACCURATE);
  } catch (_) {
    try { frames = Thread.backtrace(context, Backtracer.FUZZY); } catch (__) { frames = []; }
  }
  return frames.slice(0, 20).map((addr) => {
    try { return DebugSymbol.fromAddress(addr).toString(); }
    catch (_) { return addr.toString(); }
  });
}

function findExportSafe(modName, expName) {
  try {
    if (typeof Module.findExportByName === 'function') {
      const found = Module.findExportByName(modName, expName);
      if (found) return found;
    }
  } catch (_) {}
  try {
    if (typeof Module.getExportByName === 'function') {
      const found = Module.getExportByName(modName, expName);
      if (found) return found;
    }
  } catch (_) {}
  try {
    const mod = modName ? Process.findModuleByName(modName) : null;
    if (mod && typeof mod.findExportByName === 'function') {
      const found = mod.findExportByName(expName);
      if (found) return found;
    }
  } catch (_) {}
  try {
    for (const mod of Process.enumerateModules()) {
      if (modName && mod.name.toLowerCase() !== modName.toLowerCase()) continue;
      try {
        const found = mod.enumerateExports().find((entry) => entry.name === expName);
        if (found) return found.address;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

function hookExport(modName, expName, label, onEnter, onLeave) {
  const key = `${modName || '*'}!${expName}`;
  if (hooked.has(key)) return false;
  const addr = findExportSafe(modName, expName);
  if (!addr) return false;
  try {
    Interceptor.attach(addr, {
      onEnter(args) {
        try { if (onEnter) onEnter.call(this, args, addr); }
        catch (error) { sendLog({ type: 'agent-error', where: label, message: String(error) }); }
      },
      onLeave(retval) {
        try { if (onLeave) onLeave.call(this, retval, addr); }
        catch (error) { sendLog({ type: 'agent-error', where: `${label}:leave`, message: String(error) }); }
      },
    });
    hooked.add(key);
    sendLog({ type: 'hooked', label, module: modName, export: expName, address: addr.toString() });
    return true;
  } catch (error) {
    sendLog({ type: 'agent-error', where: `attach:${label}`, message: String(error) });
    return false;
  }
}

function hookAddress(addr, label, onEnter, onLeave) {
  const key = `${label}@${addr}`;
  if (!addr || hooked.has(key)) return false;
  try {
    Interceptor.attach(addr, {
      onEnter(args) {
        try { if (onEnter) onEnter.call(this, args, addr); }
        catch (error) { sendLog({ type: 'agent-error', where: label, message: String(error) }); }
      },
      onLeave(retval) {
        try { if (onLeave) onLeave.call(this, retval, addr); }
        catch (error) { sendLog({ type: 'agent-error', where: `${label}:leave`, message: String(error) }); }
      },
    });
    hooked.add(key);
    sendLog({ type: 'hooked', label, address: addr.toString(), module: moduleForAddress(addr.toString()) });
    return true;
  } catch (error) {
    sendLog({ type: 'agent-error', where: `attach:${label}`, message: String(error) });
    return false;
  }
}

function installAnimationTagHooks() {
  let mod = null;
  try { mod = Process.findModuleByName('KG3D_AnimationTagX64.dll'); } catch (_) {}
  if (!mod) return;
  hookAddress(mod.base.add(0x132a7), 'animtag-audio-virtual-call-132a7', function () {
    const context = this.context;
    const rcx = context.rcx;
    const rdx = context.rdx;
    const r8 = context.r8;
    const vtable = readPointerSafe(rcx, 0);
    const target = vtable ? readPointerSafe(vtable, 0xa8) : null;
    const stackStringPtr = readPointerSafe(context.rsp, 0x58);
    const rbpStringLocal = context.rbp ? context.rbp.sub(0x60) : ptr(0);
    const rbpEventLocal = context.rbp ? context.rbp.sub(0x20) : ptr(0);
    const stackProbe = probePointer(context.rsp, 192);
    const wrapperProbe = probePointer(rcx, 160);
    const eventArgProbe = probePointer(rdx, 256);
    const extraArgProbe = probePointer(r8, 256);
    const localStringProbe = probePointer(rbpStringLocal, 256);
    const localEventProbe = probePointer(rbpEventLocal, 256);
    const animationPaths = [];
    collectAnimationResourceStrings(readAnsiBounded(stackStringPtr), animationPaths);
    collectAnimationResourceStrings(readUtf16Bounded(stackStringPtr), animationPaths);
    collectProbeAnimationResources(stackProbe, animationPaths);
    collectProbeAnimationResources(wrapperProbe, animationPaths);
    collectProbeAnimationResources(eventArgProbe, animationPaths);
    collectProbeAnimationResources(extraArgProbe, animationPaths);
    collectProbeAnimationResources(localStringProbe, animationPaths);
    collectProbeAnimationResources(localEventProbe, animationPaths);
    sendLog({
      type: 'animtag-audio-callsite',
      callsite: mod.base.add(0x132a7).toString(),
      target: keyOf(target),
      targetModule: target ? moduleForAddress(target.toString()) : null,
      gameObjectCandidate: keyOf(readPointerSafe(rdx, 0)),
      stackStringPtr: keyOf(stackStringPtr),
      stackString: readAnsiBounded(stackStringPtr),
      stackStringUtf16: readUtf16Bounded(stackStringPtr),
      stackProbe,
      wrapperProbe,
      eventArgProbe,
      extraArgProbe,
      localStringProbe,
      localEventProbe,
      animationPaths,
      callContext: captureCallContext(context),
      stack: stackTrace(context),
    });
  });
}

function hookRuntimeFileOpen(modName, expName, label, reader) {
  hookExport(modName, expName, label, function (args) {
    const readResult = reader(args[0]) || '';
    const rawPath = typeof readResult === 'object' ? (readResult.rawPath || readResult.path || '') : readResult;
    const path = normalizeRuntimeResourcePath(rawPath);
    if (!isRuntimeAnimationResourcePath(path)) return;
    this.animationPath = path;
    this.animationKind = classifyRuntimeResourcePath(path);
    this.pathBytesHex = typeof readResult === 'object' ? (readResult.pathBytesHex || '') : '';
    this.pathByteLength = typeof readResult === 'object' ? (readResult.pathByteLength || 0) : 0;
    this.pathEncoding = typeof readResult === 'object' ? (readResult.pathEncoding || '') : '';
    this.rawPathHadReplacement = /\uFFFD/.test(rawPath);
    this.argsRaw = rawArgs(args, 4);
    this.stack = stackTrace(this.context);
  }, function (retval) {
    if (!this.animationPath) return;
    const payload = {
      type: 'client-animation-file',
      api: label,
      path: this.animationPath,
      kind: this.animationKind,
      result: keyOf(retval),
      argsRaw: this.argsRaw,
      stack: this.stack,
    };
    if (this.pathBytesHex) payload.pathBytesHex = this.pathBytesHex;
    if (this.pathByteLength) payload.pathByteLength = this.pathByteLength;
    if (this.pathEncoding) payload.pathEncoding = this.pathEncoding;
    if (this.rawPathHadReplacement) payload.rawPathHadReplacement = true;
    sendLog(payload);
  });
}

function installAnimationFileHooks() {
  hookRuntimeFileOpen('KernelBase.dll', 'CreateFileW', 'createfile-wide', readUtf16Path);
  hookRuntimeFileOpen('KernelBase.dll', 'CreateFileA', 'createfile-ansi', readAnsiPathWithBytes);
  hookRuntimeFileOpen('kernel32.dll', 'CreateFileW', 'createfile-wide-k32', readUtf16Path);
  hookRuntimeFileOpen('kernel32.dll', 'CreateFileA', 'createfile-ansi-k32', readAnsiPathWithBytes);
  hookRuntimeFileOpen(null, 'g_OpenFile', 'g-open-file', function (arg0) {
    const ansi = readAnsiPathWithBytes(arg0, 260);
    if (ansi.rawPath) return ansi;
    return readUtf16Path(arg0, 260);
  });
}

function installWwiseHooks() {
  for (const modName of wwiseModules) {
    hookExport(modName, exportsToHook.wwiseGetIdAnsi, 'wwise-get-id-ansi', function (args) {
      this.name = readAnsi(args[0]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      const id = u32(retval);
      if (id != null && this.name) idToName[id] = this.name;
      sendLog({ type: 'wwise-get-id', encoding: 'ansi', id, name: this.name, stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseGetIdWide, 'wwise-get-id-wide', function (args) {
      this.name = readUtf16(args[0]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      const id = u32(retval);
      if (id != null && this.name) idToName[id] = this.name;
      sendLog({ type: 'wwise-get-id', encoding: 'wide', id, name: this.name, stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwisePostEventId, 'wwise-post-event-id', function (args) {
      this.eventId = u32(args[0]);
      this.gameObject = u64(args[1]);
      this.flags = u32(args[2]);
      this.externalCount = u32(args[5]);
      this.playingIdIn = u32(args[7]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({
        type: 'wwise-post-event',
        form: 'id',
        eventId: this.eventId,
        eventName: idToName[this.eventId] || '',
        gameObject: this.gameObject,
        flags: this.flags,
        externalCount: this.externalCount,
        playingIdIn: this.playingIdIn,
        playingId: u32(retval),
        stack: this.stack,
      });
    });

    hookExport(modName, exportsToHook.wwisePostEventAnsi, 'wwise-post-event-ansi', function (args) {
      this.eventName = readAnsi(args[0]);
      this.eventNameWide = this.eventName ? '' : readUtf16(args[0]);
      this.eventIdLike = u32(args[0]);
      this.arg0 = keyOf(args[0]);
      this.arg0Bytes = this.eventName ? '' : readHex(args[0], 32);
      this.arg0Probe = this.eventName ? null : probePointer(args[0], 192);
      this.callContext = this.eventName ? null : captureCallContext(this.context);
      this.argsRaw = this.eventName ? [] : rawArgs(args, 8);
      this.gameObject = u64(args[1]);
      this.flags = u32(args[2]);
      this.externalCount = u32(args[5]);
      this.playingIdIn = u32(args[7]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({
        type: 'wwise-post-event',
        form: 'ansi',
        eventName: this.eventName,
        eventNameWide: this.eventNameWide,
        eventIdLike: this.eventIdLike,
        arg0: this.arg0,
        arg0Bytes: this.arg0Bytes,
        arg0Probe: this.arg0Probe,
        callContext: this.callContext,
        argsRaw: this.argsRaw,
        gameObject: this.gameObject,
        flags: this.flags,
        externalCount: this.externalCount,
        playingIdIn: this.playingIdIn,
        playingId: u32(retval),
        stack: this.stack,
      });
    });

    hookExport(modName, exportsToHook.wwisePostEventWide, 'wwise-post-event-wide', function (args) {
      this.eventName = readUtf16(args[0]);
      this.eventNameAnsi = this.eventName ? '' : readAnsi(args[0]);
      this.eventIdLike = u32(args[0]);
      this.arg0 = keyOf(args[0]);
      this.arg0Bytes = this.eventName ? '' : readHex(args[0], 32);
      this.arg0Probe = this.eventName ? null : probePointer(args[0], 192);
      this.callContext = this.eventName ? null : captureCallContext(this.context);
      this.argsRaw = this.eventName ? [] : rawArgs(args, 8);
      this.gameObject = u64(args[1]);
      this.flags = u32(args[2]);
      this.externalCount = u32(args[5]);
      this.playingIdIn = u32(args[7]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({
        type: 'wwise-post-event',
        form: 'wide',
        eventName: this.eventName,
        eventNameAnsi: this.eventNameAnsi,
        eventIdLike: this.eventIdLike,
        arg0: this.arg0,
        arg0Bytes: this.arg0Bytes,
        arg0Probe: this.arg0Probe,
        callContext: this.callContext,
        argsRaw: this.argsRaw,
        gameObject: this.gameObject,
        flags: this.flags,
        externalCount: this.externalCount,
        playingIdIn: this.playingIdIn,
        playingId: u32(retval),
        stack: this.stack,
      });
    });

    hookExport(modName, exportsToHook.wwiseLoadBankId, 'wwise-load-bank-id', function (args) {
      this.bankId = u32(args[0]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-load-bank', form: 'id', bankId: this.bankId, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseLoadBankAnsi, 'wwise-load-bank-ansi', function (args) {
      this.bankName = readAnsi(args[0]);
      this.outBankId = args[1];
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-load-bank', form: 'ansi', bankName: this.bankName, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseLoadBankWide, 'wwise-load-bank-wide', function (args) {
      this.bankName = readUtf16(args[0]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-load-bank', form: 'wide', bankName: this.bankName, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseRegisterGameObj, 'wwise-register-gameobj', function (args) {
      this.gameObject = u64(args[0]);
      this.stack = this.gameObject === '0x1' ? stackTrace(this.context) : [];
    }, function (retval) {
      if (this.gameObject === '0x1') sendLog({ type: 'wwise-register-gameobj', gameObject: this.gameObject, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseRegisterGameObjName, 'wwise-register-gameobj-name', function (args) {
      this.gameObject = u64(args[0]);
      this.name = readAnsi(args[1]);
      this.stack = this.name ? stackTrace(this.context) : [];
    }, function (retval) {
      if (this.name) sendLog({ type: 'wwise-register-gameobj', gameObject: this.gameObject, name: this.name, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseSetSwitchId, 'wwise-set-switch-id', function (args) {
      this.switchGroupId = u32(args[0]);
      this.switchId = u32(args[1]);
      this.gameObject = u64(args[2]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-set-switch', form: 'id', switchGroupId: this.switchGroupId, switchGroupName: idToName[this.switchGroupId] || '', switchId: this.switchId, switchName: idToName[this.switchId] || '', gameObject: this.gameObject, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseSetSwitchAnsi, 'wwise-set-switch-ansi', function (args) {
      this.switchGroupName = readAnsi(args[0]);
      this.switchName = readAnsi(args[1]);
      this.gameObject = u64(args[2]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-set-switch', form: 'ansi', switchGroupName: this.switchGroupName, switchName: this.switchName, gameObject: this.gameObject, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseSetSwitchWide, 'wwise-set-switch-wide', function (args) {
      this.switchGroupName = readUtf16(args[0]);
      this.switchName = readUtf16(args[1]);
      this.gameObject = u64(args[2]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-set-switch', form: 'wide', switchGroupName: this.switchGroupName, switchName: this.switchName, gameObject: this.gameObject, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseSetStateId, 'wwise-set-state-id', function (args) {
      this.stateGroupId = u32(args[0]);
      this.stateId = u32(args[1]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-set-state', form: 'id', stateGroupId: this.stateGroupId, stateGroupName: idToName[this.stateGroupId] || '', stateId: this.stateId, stateName: idToName[this.stateId] || '', result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseSetStateAnsi, 'wwise-set-state-ansi', function (args) {
      this.stateGroupName = readAnsi(args[0]);
      this.stateName = readAnsi(args[1]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-set-state', form: 'ansi', stateGroupName: this.stateGroupName, stateName: this.stateName, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseSetStateWide, 'wwise-set-state-wide', function (args) {
      this.stateGroupName = readUtf16(args[0]);
      this.stateName = readUtf16(args[1]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-set-state', form: 'wide', stateGroupName: this.stateGroupName, stateName: this.stateName, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwisePostTriggerId, 'wwise-post-trigger-id', function (args) {
      this.triggerId = u32(args[0]);
      this.gameObject = u64(args[1]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-post-trigger', form: 'id', triggerId: this.triggerId, triggerName: idToName[this.triggerId] || '', gameObject: this.gameObject, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwisePostTriggerAnsi, 'wwise-post-trigger-ansi', function (args) {
      this.triggerName = readAnsi(args[0]);
      this.gameObject = u64(args[1]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-post-trigger', form: 'ansi', triggerName: this.triggerName, gameObject: this.gameObject, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwisePostTriggerWide, 'wwise-post-trigger-wide', function (args) {
      this.triggerName = readUtf16(args[0]);
      this.gameObject = u64(args[1]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-post-trigger', form: 'wide', triggerName: this.triggerName, gameObject: this.gameObject, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseSetRtpcId, 'wwise-set-rtpc-id', function (args) {
      this.rtpcId = u32(args[0]);
      this.valueRaw = keyOf(args[1]);
      this.gameObject = u64(args[2]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-set-rtpc', form: 'id', rtpcId: this.rtpcId, rtpcName: idToName[this.rtpcId] || '', valueRaw: this.valueRaw, gameObject: this.gameObject, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseSetRtpcAnsi, 'wwise-set-rtpc-ansi', function (args) {
      this.rtpcName = readAnsi(args[0]);
      this.valueRaw = keyOf(args[1]);
      this.gameObject = u64(args[2]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-set-rtpc', form: 'ansi', rtpcName: this.rtpcName, valueRaw: this.valueRaw, gameObject: this.gameObject, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseSetRtpcWide, 'wwise-set-rtpc-wide', function (args) {
      this.rtpcName = readUtf16(args[0]);
      this.valueRaw = keyOf(args[1]);
      this.gameObject = u64(args[2]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-set-rtpc', form: 'wide', rtpcName: this.rtpcName, valueRaw: this.valueRaw, gameObject: this.gameObject, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseActionEventId, 'wwise-action-event-id', function (args) {
      this.eventId = u32(args[0]);
      this.actionType = u32(args[1]);
      this.gameObject = u64(args[2]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-action-event', form: 'id', eventId: this.eventId, eventName: idToName[this.eventId] || '', actionType: this.actionType, gameObject: this.gameObject, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseActionEventAnsi, 'wwise-action-event-ansi', function (args) {
      this.eventName = readAnsi(args[0]);
      this.actionType = u32(args[1]);
      this.gameObject = u64(args[2]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-action-event', form: 'ansi', eventName: this.eventName, actionType: this.actionType, gameObject: this.gameObject, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseActionEventWide, 'wwise-action-event-wide', function (args) {
      this.eventName = readUtf16(args[0]);
      this.actionType = u32(args[1]);
      this.gameObject = u64(args[2]);
      this.stack = stackTrace(this.context);
    }, function (retval) {
      sendLog({ type: 'wwise-action-event', form: 'wide', eventName: this.eventName, actionType: this.actionType, gameObject: this.gameObject, result: u32(retval), stack: this.stack });
    });

    hookExport(modName, exportsToHook.wwiseStopPlayingId, 'wwise-stop-playing-id', function (args) {
      this.playingId = u32(args[0]);
      this.transitionMs = u32(args[1]);
      this.stack = stackTrace(this.context);
    }, function () {
      sendLog({ type: 'wwise-stop-playing-id', playingId: this.playingId, transitionMs: this.transitionMs, stack: this.stack });
    });
  }
}

function resolveFmodSoundName(soundPtr) {
  const key = keyOf(soundPtr);
  if (!key) return '';
  if (soundNames[key]) return soundNames[key];
  const fn = findExportSafe('fmodex64.dll', 'FMOD_Sound_GetName');
  if (!fn) return '';
  try {
    const getName = new NativeFunction(fn, 'int', ['pointer', 'pointer', 'int']);
    const buffer = Memory.alloc(512);
    const result = getName(soundPtr, buffer, 512);
    if (result === 0) {
      const name = readAnsi(buffer);
      if (name) soundNames[key] = name;
      return name;
    }
  } catch (_) {}
  return '';
}

function resolveFmodEventName(eventPtr) {
  const key = keyOf(eventPtr);
  if (!key) return '';
  if (eventNames[key]) return eventNames[key];
  const fn = findExportSafe('fmod_event64.dll', 'FMOD_Event_GetInfo');
  if (!fn) return '';
  try {
    const getInfo = new NativeFunction(fn, 'int', ['pointer', 'pointer', 'pointer', 'pointer']);
    const indexPtr = Memory.alloc(4);
    const namePtrPtr = Memory.alloc(Process.pointerSize);
    const infoPtr = Memory.alloc(256);
    Memory.writeS32(indexPtr, 0);
    Memory.writePointer(namePtrPtr, ptr(0));
    const result = getInfo(eventPtr, indexPtr, namePtrPtr, infoPtr);
    if (result === 0) {
      const name = readAnsi(Memory.readPointer(namePtrPtr));
      if (name) eventNames[key] = name;
      return name;
    }
  } catch (_) {}
  return '';
}

function hookFmodCreateSound(expName, label) {
  hookExport('fmodex64.dll', expName, label, function (args) {
    this.path = readAnsi(args[1]);
    this.mode = u32(args[2]);
    this.outSound = args[4];
    this.stack = stackTrace(this.context);
  }, function (retval) {
    let soundPtr = ptr(0);
    try { if (this.outSound && !this.outSound.isNull()) soundPtr = Memory.readPointer(this.outSound); } catch (_) {}
    const key = keyOf(soundPtr);
    if (key && this.path) soundNames[key] = this.path;
    sendLog({ type: 'fmod-create-sound', api: label, path: this.path, mode: this.mode, sound: key, result: u32(retval), stack: this.stack });
  });
}

function hookFmodPlaySound(expName, label) {
  hookExport('fmodex64.dll', expName, label, function (args) {
    this.channelIndex = u32(args[1]);
    this.soundPtr = args[2];
    this.paused = u32(args[3]);
    this.soundName = resolveFmodSoundName(this.soundPtr);
    this.stack = stackTrace(this.context);
  }, function (retval) {
    sendLog({
      type: 'fmod-play-sound',
      api: label,
      sound: keyOf(this.soundPtr),
      soundName: this.soundName,
      channelIndex: this.channelIndex,
      paused: this.paused,
      result: u32(retval),
      stack: this.stack,
    });
  });
}

function hookFmodGetEvent(expName, label) {
  hookExport('fmod_event64.dll', expName, label, function (args) {
    this.name = readAnsi(args[1]);
    this.mode = u32(args[2]);
    this.outEvent = args[3];
    this.stack = stackTrace(this.context);
  }, function (retval) {
    let eventPtr = ptr(0);
    try { if (this.outEvent && !this.outEvent.isNull()) eventPtr = Memory.readPointer(this.outEvent); } catch (_) {}
    const key = keyOf(eventPtr);
    if (key && this.name) eventNames[key] = this.name;
    sendLog({ type: 'fmod-get-event', api: label, eventName: this.name, mode: this.mode, event: key, result: u32(retval), stack: this.stack });
  });
}

function hookFmodEventStart(expName, label) {
  hookExport('fmod_event64.dll', expName, label, function (args) {
    this.eventPtr = args[0];
    this.eventName = resolveFmodEventName(this.eventPtr);
    this.stack = stackTrace(this.context);
  }, function (retval) {
    sendLog({ type: 'fmod-event-start', api: label, event: keyOf(this.eventPtr), eventName: this.eventName, result: u32(retval), stack: this.stack });
  });
}

function installFmodHooks() {
  hookFmodCreateSound('FMOD_System_CreateSound', 'fmod-system-create-sound');
  hookFmodCreateSound('FMOD_System_CreateStream', 'fmod-system-create-stream');
  hookFmodCreateSound('?createSound@System@FMOD@@QEAA?AW4FMOD_RESULT@@PEBDIPEAUFMOD_CREATESOUNDEXINFO@@PEAPEAVSound@2@@Z', 'fmod-cpp-create-sound');
  hookFmodCreateSound('?createStream@System@FMOD@@QEAA?AW4FMOD_RESULT@@PEBDIPEAUFMOD_CREATESOUNDEXINFO@@PEAPEAVSound@2@@Z', 'fmod-cpp-create-stream');
  hookFmodPlaySound('FMOD_System_PlaySound', 'fmod-system-play-sound');
  hookFmodPlaySound('?playSound@System@FMOD@@QEAA?AW4FMOD_RESULT@@W4FMOD_CHANNELINDEX@@PEAVSound@2@_NPEAPEAVChannel@2@@Z', 'fmod-cpp-play-sound');

  hookExport('fmod_event64.dll', 'FMOD_EventSystem_Load', 'fmod-eventsystem-load', function (args) {
    this.path = readAnsi(args[1]);
    this.stack = stackTrace(this.context);
  }, function (retval) {
    sendLog({ type: 'fmod-eventsystem-load', path: this.path, result: u32(retval), stack: this.stack });
  });

  hookExport('fmod_event64.dll', 'FMOD_EventSystem_SetMediaPath', 'fmod-eventsystem-set-media-path', function (args) {
    this.path = readAnsi(args[1]);
    this.stack = stackTrace(this.context);
  }, function (retval) {
    sendLog({ type: 'fmod-eventsystem-set-media-path', path: this.path, result: u32(retval), stack: this.stack });
  });

  hookFmodGetEvent('FMOD_EventSystem_GetEvent', 'fmod-eventsystem-get-event');
  hookFmodGetEvent('FMOD_EventGroup_GetEvent', 'fmod-eventgroup-get-event');
  hookFmodGetEvent('?getEvent@EventSystem@FMOD@@QEAA?AW4FMOD_RESULT@@PEBDIPEAPEAVEvent@2@@Z', 'fmod-cpp-eventsystem-get-event');
  hookFmodGetEvent('?getEvent@EventGroupI@FMOD@@UEAA?AW4FMOD_RESULT@@PEBDIPEAPEAVEvent@2@@Z', 'fmod-cpp-eventgroup-get-event');
  hookFmodEventStart('FMOD_Event_Start', 'fmod-event-start');
  hookFmodEventStart('?start@Event@FMOD@@QEAA?AW4FMOD_RESULT@@XZ', 'fmod-cpp-event-start');
  hookFmodEventStart('?start@EventI@FMOD@@UEAA?AW4FMOD_RESULT@@XZ', 'fmod-cpp-eventi-start');
}

function moduleSnapshot() {
  try {
    return Process.enumerateModules()
      .filter((mod) => /wwise|fmod|sound|represent|jx3/i.test(mod.name))
      .map((mod) => ({ name: mod.name, base: mod.base.toString(), size: mod.size }));
  } catch (_) {
    return [];
  }
}

function moduleForAddress(address) {
  try {
    const target = ptr(String(address || '0'));
    for (const mod of Process.enumerateModules()) {
      const start = mod.base;
      const end = mod.base.add(mod.size);
      if (target.compare(start) >= 0 && target.compare(end) < 0) {
        return { name: mod.name, base: mod.base.toString(), size: mod.size, offset: `0x${target.sub(mod.base).toString(16)}`, path: mod.path || '' };
      }
    }
  } catch (_) {}
  return null;
}

function disassemble(address, count, back) {
  const out = [];
  let cursor;
  try {
    cursor = ptr(String(address || '0')).sub(Math.max(0, Number(back) || 0));
  } catch (_) {
    return out;
  }
  for (let i = 0; i < Math.min(Math.max(Number(count) || 24, 1), 120); i++) {
    try {
      const instruction = Instruction.parse(cursor);
      out.push({ address: cursor.toString(), module: moduleForAddress(cursor.toString()), mnemonic: instruction.mnemonic, opStr: instruction.opStr, next: instruction.next.toString() });
      cursor = instruction.next;
    } catch (error) {
      out.push({ address: cursor.toString(), error: String(error), bytes: readHex(cursor, 16), module: moduleForAddress(cursor.toString()) });
      break;
    }
  }
  return out;
}

function installHooks() {
  installAnimationTagHooks();
  installAnimationFileHooks();
  installWwiseHooks();
  installFmodHooks();
}

function handleCommand(payload) {
  const cmd = String(payload?.cmd || '');
  if (cmd === 'probePointer') {
    return { ok: true, probe: probePointer(ptr(String(payload.address || '0')), Number(payload.count) || 256) };
  }
  if (cmd === 'moduleForAddress') {
    return { ok: true, module: moduleForAddress(payload.address) };
  }
  if (cmd === 'disasm') {
    return { ok: true, instructions: disassemble(payload.address, payload.count, payload.back) };
  }
  if (cmd === 'getAudioAgentState') {
    return { ok: true, hooked: hooked.size, modules: moduleSnapshot() };
  }
  return { ok: false, error: `unknown command: ${cmd}` };
}

function receiveCommands() {
  try {
    recv('cmd', (message) => {
      const payload = message?.payload || {};
      let result;
      try {
        result = handleCommand(payload);
      } catch (error) {
        result = { ok: false, error: String(error) };
      }
      sendLog({ type: 'cmdResult', id: payload.id, cmd: payload.cmd, result });
      receiveCommands();
    });
  } catch (_) {}
}

sendLog({ type: 'audio-agent-ready', modules: moduleSnapshot() });
installHooks();
setInterval(installHooks, 2000);
receiveCommands();