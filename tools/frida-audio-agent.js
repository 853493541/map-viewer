// Frida agent for runtime audio and animation-resource tracing in the JX3 client.
// It logs Wwise/FMOD calls plus animation/effect file opens with stack traces.

const hooked = new Set();
const idToName = Object.create(null);
const soundNames = Object.create(null);
const eventNames = Object.create(null);
const pssFileTargets = Object.create(null);
const pssObjectTargets = Object.create(null);
const pssThreadHints = Object.create(null);
let pssTraceSeq = 1;

const PSS_THREAD_HINT_MS = 4000;
const PSS_TARGET_TTL_MS = 120000;
const PSS_MAX_READ_LOGS_PER_TARGET = 32;
const PSS_MAX_METHOD_LOGS_PER_OBJECT = 64;
const PSS_METHOD_VTABLE_SLOTS = 48;
const PSS_METHOD_HOOK_SLOTS = new Set([0, 5, 11, 12]);
const PSS_READ_HEADER_BYTES = 96;

const agentConfig = (() => {
  try {
    return typeof __JX3_CLIENT_MONITOR_AGENT_CONFIG__ === 'object' && __JX3_CLIENT_MONITOR_AGENT_CONFIG__
      ? __JX3_CLIENT_MONITOR_AGENT_CONFIG__
      : {};
  } catch (_) {
    return {};
  }
})();
const AGENT_MODE = String(agentConfig.mode || 'audio-only').toLowerCase();
const TRACE_SAFE_MODE = AGENT_MODE === 'trace';
const CAPTURE_ANIMATION_HOOKS = AGENT_MODE === 'full' || AGENT_MODE === 'animation' || AGENT_MODE === 'trace';
const CAPTURE_AUDIO_HOOKS = AGENT_MODE !== 'animation';
const CAPTURE_STACKS = agentConfig.captureStacks === true || AGENT_MODE === 'full';
const CAPTURE_CALL_CONTEXT = agentConfig.captureCallContext === true || AGENT_MODE === 'full';
const CAPTURE_DEEP_PROBES = agentConfig.deepProbes === true || AGENT_MODE === 'full';
const CAPTURE_OS_FILE_OPEN_HOOKS = agentConfig.osFileOpenHooks === true || AGENT_MODE === 'full' || AGENT_MODE === 'animation';
const CAPTURE_PSS_READ_HOOKS = agentConfig.pssReadHooks === true || AGENT_MODE === 'full';
const CAPTURE_PSS_OBJECT_METHODS = agentConfig.pssObjectMethods === true || AGENT_MODE === 'full';
const CAPTURE_REPRESENT_SFX_HOOKS = agentConfig.representSfxHooks === true || AGENT_MODE === 'full' || AGENT_MODE === 'animation';
const CAPTURE_PARTICLE_EXPORT_HOOKS = agentConfig.particleExportHooks === true || AGENT_MODE === 'full' || AGENT_MODE === 'animation';
const CAPTURE_KG3D_PARTICLE_RVA_HOOKS = agentConfig.kg3dParticleRvaHooks === true || AGENT_MODE === 'full' || AGENT_MODE === 'animation';
const CAPTURE_KG3D_DISPLAY_PROOF_HOOKS = agentConfig.kg3dDisplayProofHooks === true || agentConfig.displayProofHooks === true;
const CAPTURE_WWISE_REGISTRATION_HOOKS = agentConfig.wwiseRegistrationHooks === true || !TRACE_SAFE_MODE;
const AGENT_RETRY_INTERVAL_MS = AGENT_MODE === 'full' ? 2000 : 10000;

const representModuleNames = ['jx3representx64.dll', 'JX3RepresentX64.dll'];
const kg3dEngineModuleNames = ['KG3DEngineDX11EX64.dll', 'kg3denginedx11ex64.dll'];

const representSfxRvaHooks = [
  { label: 'represent-load-socket-sfx', rva: 0xcc6a60, maxLogs: 80 },
  { label: 'represent-get-part-info-for-sfx', rva: 0xccaaa0, maxLogs: 80 },
  { label: 'represent-equip-sfx-init', rva: 0xccbac0, maxLogs: 80 },
  { label: 'represent-update-equip-sfx', rva: 0xcd5828, maxLogs: 40 },
  { label: 'represent-update-equip-sfx-custom-transform', rva: 0xcd5850, maxLogs: 40 },
  { label: 'represent-update-socket-transform', rva: 0xcd5fd0, maxLogs: 40 },
  { label: 'represent-force-bind-to-bone', rva: 0xcd8f30, maxLogs: 40 },
];

const representSfxCurrentRvaHooks = [
  { label: 'represent-load-model-sfx-param-current', rva: 0x408959, anchor: 'LoadModelSFXParam.szSocketName', maxLogs: 80 },
  { label: 'represent-lua-load-socket-sfx-current', rva: 0x476c66, anchor: 'RendererComponent::LuaLoadSocketSFX', maxLogs: 80 },
  { label: 'represent-renderer-load-socket-sfx-current', rva: 0x47bb90, anchor: 'RendererComponent::LoadSocketSFX', maxLogs: 120 },
  { label: 'represent-socket-get-bone-position-current', rva: 0x47b230, anchor: 'm_rlActor.GetBonePosition(pszSocket)', maxLogs: 120 },
  { label: 'represent-socket-get-part-info-current', rva: 0x4c2810, anchor: 'pRLSources->m_rlActor.GetPartInfo', maxLogs: 120 },
  { label: 'represent-update-equip-sfx-current', rva: 0x57bf00, anchor: 'KRLCharacter::UpdateEquipSFX', maxLogs: 120 },
  { label: 'represent-update-socket-transform-current', rva: 0x587e90, anchor: 'KRLCharacter::UpdateSocketTransform', maxLogs: 120 },
];

const kg3dParticleRvaHooks = [
  { label: 'kg3d-particle-filedata-load-current', rva: 0xd99850, maxLogs: 120 },
  { label: 'kg3d-parsys-material-block-current', rva: 0xd98190, maxLogs: 120 },
  { label: 'kg3d-parsys-launcher-block-current', rva: 0xd98520, maxLogs: 120 },
  { label: 'kg3d-parsys-track-block', rva: 0xd98d10, maxLogs: 120 },
  { label: 'kg3d-particle-add-launcher-current', rva: 0xd95740, maxLogs: 120 },
  { label: 'kg3d-particle-add-material-current', rva: 0xd95980, maxLogs: 120 },
  { label: 'kg3d-particle-add-track-current', rva: 0xd95ba0, maxLogs: 120 },
];

const kg3dDisplayProofRvaHooks = [
  { label: 'kg3d-display-proof-filedata-parent-a', rva: 0xd7f1c0, stage: 'filedata-load-parent', maxLogs: 16 },
  { label: 'kg3d-display-proof-filedata-parent-b', rva: 0xd9a740, stage: 'filedata-load-parent', maxLogs: 16 },
  { label: 'kg3d-display-proof-common-render-data', rva: 0xd7fdd0, stage: 'common-render-data', maxLogs: 16 },
  { label: 'kg3d-display-proof-launcher-on-after-bind', rva: 0xd9d5e0, stage: 'launcher-on-after-bind', maxLogs: 16 },
  { label: 'kg3d-display-proof-update-target-render-data', rva: 0xd9d6b0, stage: 'target-render-data', maxLogs: 16 },
  { label: 'kg3d-display-proof-prepare-render-data-a', rva: 0xd9e2a0, stage: 'prepare-render-data', maxLogs: 16 },
  { label: 'kg3d-display-proof-prepare-render-data-b', rva: 0xd9e9c0, stage: 'prepare-render-data', maxLogs: 16 },
];

const particleExportNameRe = /KG3D_ParticleFileData|KE3D_ParticleSystem|PARSYS|Particle.*LoadFromFile|AddLauncher|AddMaterial|AddTrack/i;
const runtimeHookCounts = Object.create(null);

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

function isRuntimePssPath(value) {
  return /\.pss(?:$|[\s?#])/i.test(normalizeRuntimeResourcePath(value));
}

function nextPssTraceId(kind) {
  return `pss-${kind || 'trace'}-${(pssTraceSeq++).toString(36)}`;
}

function currentThreadKey() {
  try { return String(Process.getCurrentThreadId()); } catch (_) { return ''; }
}

function rememberPssThreadHint(path, traceId) {
  const thread = currentThreadKey();
  if (!thread || !path) return;
  pssThreadHints[thread] = {
    path,
    traceId,
    openedAt: Date.now(),
    until: Date.now() + PSS_THREAD_HINT_MS,
    readCount: 0,
    totalBytesRead: 0,
    targetKind: 'thread-hint',
  };
}

function pssThreadHint() {
  const thread = currentThreadKey();
  if (!thread) return null;
  const hint = pssThreadHints[thread];
  if (!hint) return null;
  if (Date.now() > hint.until) {
    delete pssThreadHints[thread];
    return null;
  }
  return hint;
}

function isInvalidRuntimeHandleText(value) {
  const text = String(value || '').toLowerCase();
  return !text || text === '0x0' || text === '0' || text === '0xffffffffffffffff' || text === '-1';
}

function pointerValueToNumber(value) {
  const text = keyOf(value);
  if (!text) return null;
  try {
    if (/^0x/i.test(text)) {
      const big = BigInt(text);
      if (big <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(big);
      return null;
    }
  } catch (_) {}
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

function readNativeUIntAt(ptrValue, offset) {
  const pointed = readPointerSafe(ptrValue, offset || 0);
  return pointed ? pointerValueToNumber(pointed) : null;
}

function readU32PointerValue(ptrValue) {
  try {
    if (!ptrValue || ptrValue.isNull()) return null;
    if (typeof ptrValue.readU32 === 'function') return ptrValue.readU32() >>> 0;
  } catch (_) {}
  try { return Memory.readU32(ptrValue) >>> 0; } catch (_) { return null; }
}

function readPointerHex(ptrValue, count) {
  if (!ptrValue || ptrValue.isNull()) return '';
  return readHex(ptrValue, count || Process.pointerSize);
}

function debugSymbolSafe(addr) {
  try { return DebugSymbol.fromAddress(addr).toString(); } catch (_) { return keyOf(addr); }
}

function findModuleAny(names) {
  const wanted = (names || []).map((name) => String(name || '').toLowerCase()).filter(Boolean);
  if (!wanted.length) return null;
  for (const name of names) {
    try {
      const mod = Process.findModuleByName(name);
      if (mod) return mod;
    } catch (_) {}
  }
  try {
    for (const mod of Process.enumerateModules()) {
      if (wanted.indexOf(String(mod.name || '').toLowerCase()) >= 0) return mod;
    }
  } catch (_) {}
  return null;
}

function shouldLogRuntimeHook(label, maxLogs) {
  const key = String(label || 'runtime-hook');
  runtimeHookCounts[key] = (runtimeHookCounts[key] || 0) + 1;
  return runtimeHookCounts[key] <= (Number(maxLogs) || 60);
}

function pointerStringCandidates(ptrValue) {
  if (!ptrValue || ptrValue.isNull()) return null;
  const ansi = readAnsiBounded(ptrValue, 260);
  const utf16 = readUtf16Bounded(ptrValue, 260);
  const out = { address: keyOf(ptrValue) };
  if (ansi) out.ansi = ansi;
  if (utf16 && utf16 !== ansi) out.utf16 = utf16;
  return (out.ansi || out.utf16) ? out : null;
}

function runtimeArgSnapshot(args, context, probePointers) {
  const registers = captureCallContext(context);
  const raw = rawArgs(args, 6);
  const stringCandidates = [];
  const probes = [];
  for (let i = 0; i < 6; i++) {
    const candidate = pointerStringCandidates(args[i]);
    if (candidate) stringCandidates.push({ arg: i, ...candidate });
    if (probePointers && i < 4) probes.push({ arg: i, probe: probePointer(args[i], 192) });
  }
  return { raw, stringCandidates, probes, callContext: registers };
}

function memoryRangeForAddress(addr) {
  try {
    if (typeof Process.findRangeByAddress === 'function') return Process.findRangeByAddress(addr);
  } catch (_) {}
  return null;
}

function describeMemoryRange(range) {
  if (!range) return null;
  return {
    base: keyOf(range.base),
    size: range.size,
    protection: String(range.protection || ''),
  };
}

function describePssMethodPointer(fn, slot) {
  const address = keyOf(fn);
  const methodModule = moduleForAddress(address);
  const range = memoryRangeForAddress(fn);
  const executable = !!(range && /x/i.test(String(range.protection || '')));
  let skipReason = '';
  if (!PSS_METHOD_HOOK_SLOTS.has(slot)) skipReason = 'outside-tracked-slots';
  else if (!methodModule) skipReason = 'no-module';
  else if (!executable) skipReason = 'not-executable';
  return {
    slot,
    address,
    symbol: debugSymbolSafe(fn),
    module: methodModule,
    range: describeMemoryRange(range),
    hookable: !skipReason,
    skipReason,
  };
}

function registerArgs(context) {
  const out = [];
  for (const name of ['rcx', 'rdx', 'r8', 'r9']) {
    try { out.push(keyOf(context && context[name])); } catch (_) { out.push(''); }
  }
  return out;
}

function prunePssTargets() {
  const cutoff = Date.now() - PSS_TARGET_TTL_MS;
  for (const [key, target] of Object.entries(pssFileTargets)) {
    if ((target.openedAt || 0) < cutoff) delete pssFileTargets[key];
  }
  for (const [key, target] of Object.entries(pssObjectTargets)) {
    if ((target.openedAt || 0) < cutoff) delete pssObjectTargets[key];
  }
  for (const [key, hint] of Object.entries(pssThreadHints)) {
    if ((hint.until || 0) < Date.now()) delete pssThreadHints[key];
  }
}

function captureVtableSlots(objectPtr, slotCount) {
  const vtable = readPointerSafe(objectPtr, 0);
  const slots = [];
  if (!vtable || vtable.isNull()) return { vtable: '', slots };
  for (let slot = 0; slot < Math.min(Number(slotCount) || PSS_METHOD_VTABLE_SLOTS, 96); slot++) {
    const fn = readPointerSafe(vtable, slot * Process.pointerSize);
    if (!fn || fn.isNull()) continue;
    slots.push(describePssMethodPointer(fn, slot));
  }
  return { vtable: keyOf(vtable), slots };
}

function hookPssObjectMethod(address, observedSlot) {
  const addr = ptr(String(address || '0'));
  if (!addr || addr.isNull()) return false;
  const pointerInfo = describePssMethodPointer(addr, observedSlot);
  if (!pointerInfo.hookable) return false;
  const key = `pss-object-method@${keyOf(addr)}`;
  if (hooked.has(key)) return false;
  try {
    Interceptor.attach(addr, {
      onEnter(args) {
        const objectKey = keyOf(this.context && this.context.rcx ? this.context.rcx : args[0]);
        const target = pssObjectTargets[objectKey];
        if (!target) return;
        target.methodCount = (target.methodCount || 0) + 1;
        if (target.methodCount > PSS_MAX_METHOD_LOGS_PER_OBJECT) return;
        const methodAddress = keyOf(addr);
        sendLog({
          type: 'pss-object-method-call',
          path: target.path,
          kind: 'effect',
          traceId: target.traceId,
          object: objectKey,
          api: 'vtable-call',
          openApi: target.api,
          slot: observedSlot,
          methodAddress,
          methodSymbol: debugSymbolSafe(addr),
          methodModule: moduleForAddress(methodAddress),
          callIndex: target.methodCount,
          argsRaw: registerArgs(this.context),
          rdxProbe: target.methodCount <= 10 ? probePointer(this.context.rdx, 128) : null,
          r8Probe: target.methodCount <= 10 ? probePointer(this.context.r8, 128) : null,
          callContext: captureCallContext(this.context),
          stack: stackTrace(this.context),
        });
      },
    });
    hooked.add(key);
    sendLog({ type: 'hooked', label: 'pss-object-method', address: keyOf(addr), slot: observedSlot, module: pointerInfo.module, range: pointerInfo.range });
    return true;
  } catch (error) {
    sendLog({ type: 'agent-error', where: 'attach:pss-object-method', message: String(error), address: keyOf(addr), slot: observedSlot, module: pointerInfo.module, range: pointerInfo.range });
    return false;
  }
}

function hookPssObjectMethods(objectPtr) {
  if (!CAPTURE_PSS_OBJECT_METHODS) return { vtable: '', slots: [], methodHooksDisabled: true };
  const vtable = captureVtableSlots(objectPtr, PSS_METHOD_VTABLE_SLOTS);
  for (const slot of vtable.slots) hookPssObjectMethod(slot.address, slot.slot);
  return vtable;
}

function rememberPssTarget(targetKind, label, path, targetValue, details) {
  const targetKey = keyOf(targetValue);
  if (isInvalidRuntimeHandleText(targetKey)) return;
  prunePssTargets();
  const traceId = nextPssTraceId(targetKind);
  const entry = {
    traceId,
    path,
    api: label,
    targetKind,
    openedAt: Date.now(),
    readCount: 0,
    totalBytesRead: 0,
    methodCount: 0,
  };
  rememberPssThreadHint(path, traceId);
  if (targetKind === 'handle') {
    pssFileTargets[targetKey] = entry;
    sendLog({
      type: 'pss-file-open',
      api: label,
      path,
      kind: 'effect',
      traceId,
      handle: targetKey,
      result: targetKey,
      argsRaw: details?.argsRaw || [],
      callContext: details?.callContext || null,
      stack: details?.stack || [],
    });
    return;
  }
  pssObjectTargets[targetKey] = entry;
  const objectProbe = probePointer(targetValue, 192);
  const vtable = hookPssObjectMethods(targetValue);
  sendLog({
    type: 'pss-object-open',
    api: label,
    path,
    kind: 'effect',
    traceId,
    object: targetKey,
    result: targetKey,
    argsRaw: details?.argsRaw || [],
    objectProbe,
    vtable,
    callContext: details?.callContext || null,
    stack: details?.stack || [],
  });
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

function readF32At(ptrValue, offset) {
  try {
    if (!ptrValue || ptrValue.isNull()) return null;
    const address = ptrValue.add(offset || 0);
    const value = typeof address.readFloat === 'function' ? address.readFloat() : Memory.readFloat(address);
    return Number.isFinite(value) ? value : null;
  } catch (_) { return null; }
}

function roundProbeFloat(value) {
  return Math.round(value * 1000000) / 1000000;
}

function isUsefulProbeFloat(value) {
  if (!Number.isFinite(value)) return false;
  if (Math.abs(value) > 1000000) return false;
  return Math.abs(value) >= 0.000001 || Object.is(value, 0);
}

function readF32Array(ptrValue, offset, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const value = readF32At(ptrValue, offset + i * 4);
    if (value == null || !isUsefulProbeFloat(value)) return null;
    out.push(value);
  }
  return out;
}

function collectF32Fields(ptrValue, span) {
  const fields = [];
  for (let offset = 0; offset + 4 <= Math.min(span, 160); offset += 4) {
    const value = readF32At(ptrValue, offset);
    if (value == null || !isUsefulProbeFloat(value)) continue;
    if (Math.abs(value) > 10000 && Math.abs(value) < 1000000) continue;
    fields.push({ offset: `0x${offset.toString(16)}`, value: roundProbeFloat(value) });
    if (fields.length >= 40) break;
  }
  return fields;
}

function looksLikeTransformMatrix(values) {
  if (!values || values.length !== 16) return false;
  const nonZero = values.filter((value) => Math.abs(value) > 0.0001).length;
  if (nonZero < 4) return false;
  const diag = [values[0], values[5], values[10], values[15]];
  const diagScore = diag.filter((value) => Math.abs(value) > 0.05 && Math.abs(value) < 10).length;
  const affineScore = [values[3], values[7], values[11], values[15]].filter((value) => Math.abs(value) < 10000).length;
  const hasUnitish = values.some((value) => Math.abs(Math.abs(value) - 1) < 0.02);
  return diagScore >= 2 && affineScore >= 3 && hasUnitish;
}

function collectMatrixCandidates(ptrValue, span) {
  const candidates = [];
  for (let offset = 0; offset + 64 <= Math.min(span, 256); offset += 4) {
    const values = readF32Array(ptrValue, offset, 16);
    if (!looksLikeTransformMatrix(values)) continue;
    candidates.push({
      offset: `0x${offset.toString(16)}`,
      values: values.map(roundProbeFloat),
    });
    if (candidates.length >= 4) break;
  }
  return candidates;
}

function probePointer(ptrValue, count) {
  if (!CAPTURE_DEEP_PROBES) return null;
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
    f32Fields: [],
    matrixCandidates: [],
    pointers: [],
  };
  for (let offset = 0; offset < Math.min(span, 96); offset += 4) {
    const value = readU32At(ptrValue, offset);
    if (value != null) probe.u32Fields.push({ offset: `0x${offset.toString(16)}`, value });
  }
  probe.f32Fields = collectF32Fields(ptrValue, span);
  probe.matrixCandidates = collectMatrixCandidates(ptrValue, span);
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
      f32Fields: collectF32Fields(pointed, 96).slice(0, 12),
      matrixCandidates: collectMatrixCandidates(pointed, 160).slice(0, 2),
    };
    if (entry.ansi || entry.utf16 || entry.bytes || entry.asciiStrings.length || entry.utf16Strings.length || entry.f32Fields.length || entry.matrixCandidates.length) probe.pointers.push(entry);
  }
  return probe;
}

function captureCallContext(context) {
  if (!CAPTURE_CALL_CONTEXT) return null;
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
  if (!CAPTURE_STACKS) return [];
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

function hookModuleRva(moduleNames, rva, label, onEnter, onLeave) {
  const mod = findModuleAny(moduleNames);
  if (!mod) return false;
  const offset = Number(rva) || 0;
  if (!offset || offset >= mod.size) return false;
  const addr = mod.base.add(offset);
  const range = memoryRangeForAddress(addr);
  if (range && !/x/i.test(String(range.protection || ''))) {
    const key = `skip-nonexec-rva:${label}@${mod.name}+0x${offset.toString(16)}`;
    if (!hooked.has(key)) {
      hooked.add(key);
      sendLog({
        type: 'hook-skip',
        label,
        reason: 'non-executable-rva',
        rva: `0x${offset.toString(16)}`,
        address: keyOf(addr),
        module: { name: mod.name, base: keyOf(mod.base), size: mod.size, path: mod.path || '' },
        range: describeMemoryRange(range),
      });
    }
    return false;
  }
  return hookAddress(addr, label, onEnter, onLeave);
}

function installRepresentSfxHooks() {
  for (const spec of representSfxRvaHooks.concat(representSfxCurrentRvaHooks)) {
    hookModuleRva(representModuleNames, spec.rva, spec.label, function (args, addr) {
      if (!shouldLogRuntimeHook(spec.label, spec.maxLogs)) return;
      const probePointers = runtimeHookCounts[spec.label] <= 12;
      sendLog({
        type: 'represent-sfx-call',
        label: spec.label,
        anchor: spec.anchor || '',
        rva: `0x${spec.rva.toString(16)}`,
        address: keyOf(addr),
        module: moduleForAddress(keyOf(addr)),
        args: runtimeArgSnapshot(args, this.context, probePointers),
        stack: stackTrace(this.context),
      });
    });
  }
}

function installParticleExportHooks() {
  const mod = findModuleAny(kg3dEngineModuleNames);
  if (!mod) return;
  const scanKey = `particle-export-scan@${mod.name}@${mod.base}`;
  if (hooked.has(scanKey)) return;
  hooked.add(scanKey);
  let exports = [];
  try { exports = mod.enumerateExports(); } catch (_) { exports = []; }
  const matches = exports.filter((entry) => particleExportNameRe.test(String(entry.name || ''))).slice(0, 48);
  sendLog({
    type: 'particle-export-scan',
    module: { name: mod.name, base: keyOf(mod.base), size: mod.size, path: mod.path || '' },
    matched: matches.map((entry) => ({ name: entry.name, address: keyOf(entry.address), type: entry.type || '' })),
  });
  for (const entry of matches) {
    if (entry.type && entry.type !== 'function') continue;
    hookAddress(entry.address, `kg3d-particle-export:${entry.name}`, function (args, addr) {
      if (!shouldLogRuntimeHook(`kg3d-particle-export:${entry.name}`, 80)) return;
      const probePointers = runtimeHookCounts[`kg3d-particle-export:${entry.name}`] <= 12;
      sendLog({
        type: 'kg3d-particle-export-call',
        exportName: entry.name,
        address: keyOf(addr),
        module: moduleForAddress(keyOf(addr)),
        args: runtimeArgSnapshot(args, this.context, probePointers),
        stack: stackTrace(this.context),
      });
    });
  }
}

function installKg3dParticleRvaHooks() {
  for (const spec of kg3dParticleRvaHooks) {
    hookModuleRva(kg3dEngineModuleNames, spec.rva, spec.label, function (args, addr) {
      if (!shouldLogRuntimeHook(spec.label, spec.maxLogs)) return;
      const probePointers = runtimeHookCounts[spec.label] <= 16;
      sendLog({
        type: 'kg3d-particle-rva-call',
        label: spec.label,
        rva: `0x${spec.rva.toString(16)}`,
        address: keyOf(addr),
        module: moduleForAddress(keyOf(addr)),
        args: runtimeArgSnapshot(args, this.context, probePointers),
        stack: stackTrace(this.context),
      });
    }, function (retval, addr) {
      if (runtimeHookCounts[spec.label] > Math.min(20, spec.maxLogs)) return;
      sendLog({
        type: 'kg3d-particle-rva-return',
        label: spec.label,
        rva: `0x${spec.rva.toString(16)}`,
        address: keyOf(addr),
        result: keyOf(retval),
        resultU32: u32(retval),
      });
    });
  }
}

function installKg3dDisplayProofHooks() {
  for (const spec of kg3dDisplayProofRvaHooks) {
    hookModuleRva(kg3dEngineModuleNames, spec.rva, spec.label, function (args, addr) {
      if (!shouldLogRuntimeHook(spec.label, spec.maxLogs)) return;
      const probePointers = runtimeHookCounts[spec.label] <= 4;
      sendLog({
        type: 'kg3d-display-proof-call',
        label: spec.label,
        stage: spec.stage,
        rva: `0x${spec.rva.toString(16)}`,
        address: keyOf(addr),
        module: moduleForAddress(keyOf(addr)),
        args: runtimeArgSnapshot(args, this.context, probePointers),
        stack: stackTrace(this.context),
      });
    });
  }
}

function installAnimationTagHooks() {
  let mod = null;
  try { mod = Process.findModuleByName('KG3D_AnimationTagX64.dll'); } catch (_) {}
  if (!mod) return;
  hookAddress(mod.base.add(0x132a7), 'animtag-audio-virtual-call-132a7', function () {
    if (!shouldLogRuntimeHook('animtag-audio-callsite-132a7', TRACE_SAFE_MODE ? 16 : 160)) return;
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
    if (isRuntimePssPath(path)) this.callContext = captureCallContext(this.context);
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
    if (isRuntimePssPath(this.animationPath)) {
      rememberPssTarget(label === 'g-open-file' ? 'object' : 'handle', label, this.animationPath, retval, {
        argsRaw: this.argsRaw,
        callContext: this.callContext,
        stack: this.stack,
      });
    }
  });
}

function beginPssRead(api, handle, buffer, requested, bytesOut, ioStatusBlock, byteOffset, context) {
  const handleKey = keyOf(handle);
  const tracked = pssFileTargets[handleKey];
  const hinted = tracked ? null : pssThreadHint();
  const target = tracked || hinted;
  if (!target) return null;
  return {
    api,
    target,
    tracked: !!tracked,
    handleKey,
    buffer,
    requested: Number(requested || 0) || 0,
    bytesOut,
    ioStatusBlock,
    byteOffsetHex: readPointerHex(byteOffset, 16),
    callContext: captureCallContext(context),
    stack: stackTrace(context),
  };
}

function readPssReadByteCount(state, success) {
  const direct = readU32PointerValue(state.bytesOut);
  if (direct != null) return direct;
  const ioStatusBytes = readNativeUIntAt(state.ioStatusBlock, Process.pointerSize);
  if (ioStatusBytes != null) return ioStatusBytes;
  return success ? state.requested : 0;
}

function finishPssRead(state, statusValue, success) {
  if (!state || !state.target) return;
  const bytesRead = readPssReadByteCount(state, success);
  const target = state.target;
  target.readCount = (target.readCount || 0) + 1;
  target.totalBytesRead = (target.totalBytesRead || 0) + Math.max(0, Number(bytesRead || 0));
  if (target.readCount > PSS_MAX_READ_LOGS_PER_TARGET) return;
  sendLog({
    type: 'pss-file-read',
    api: state.api,
    path: target.path,
    kind: 'effect',
    traceId: target.traceId,
    handle: state.handleKey,
    targetKind: target.targetKind || (state.tracked ? 'handle' : 'thread-hint'),
    matchedBy: state.tracked ? 'handle' : 'thread-hint',
    requested: state.requested,
    bytesRead,
    readIndex: target.readCount,
    totalBytesRead: target.totalBytesRead,
    status: String(statusValue || ''),
    byteOffsetHex: state.byteOffsetHex,
    buffer: keyOf(state.buffer),
    headerHex: bytesRead ? readHex(state.buffer, Math.min(PSS_READ_HEADER_BYTES, bytesRead)) : '',
    callContext: state.callContext,
    stack: state.stack,
  });
}

function hookReadFileExport(modName, expName, label) {
  hookExport(modName, expName, label, function (args) {
    this.pssRead = beginPssRead(label, args[0], args[1], pointerValueToNumber(args[2]) || u32(args[2]) || 0, args[3], null, ptr(0), this.context);
  }, function (retval) {
    finishPssRead(this.pssRead, keyOf(retval), !!u32(retval));
  });
}

function hookNtReadFileExport(expName, label) {
  hookExport('ntdll.dll', expName, label, function (args) {
    this.pssRead = beginPssRead(label, args[0], args[5], pointerValueToNumber(args[6]) || u32(args[6]) || 0, null, args[4], args[7], this.context);
  }, function (retval) {
    finishPssRead(this.pssRead, keyOf(retval), u32(retval) === 0);
  });
}

function hookCloseHandleExport(modName, expName, label) {
  hookExport(modName, expName, label, function (args) {
    const handleKey = keyOf(args[0]);
    const target = pssFileTargets[handleKey];
    if (!target) return;
    this.pssClose = { handleKey, target, stack: stackTrace(this.context), callContext: captureCallContext(this.context) };
  }, function (retval) {
    if (!this.pssClose) return;
    const { handleKey, target } = this.pssClose;
    sendLog({
      type: 'pss-file-close',
      api: label,
      path: target.path,
      kind: 'effect',
      traceId: target.traceId,
      handle: handleKey,
      targetKind: 'handle',
      result: keyOf(retval),
      readCount: target.readCount || 0,
      totalBytesRead: target.totalBytesRead || 0,
      callContext: this.pssClose.callContext,
      stack: this.pssClose.stack,
    });
    delete pssFileTargets[handleKey];
  });
}

function installPssReadHooks() {
  hookReadFileExport('KernelBase.dll', 'ReadFile', 'readfile');
  hookReadFileExport('kernel32.dll', 'ReadFile', 'readfile-k32');
  hookNtReadFileExport('NtReadFile', 'nt-readfile');
  hookNtReadFileExport('ZwReadFile', 'zw-readfile');
  hookCloseHandleExport('KernelBase.dll', 'CloseHandle', 'closehandle');
  hookCloseHandleExport('kernel32.dll', 'CloseHandle', 'closehandle-k32');
  hookCloseHandleExport('ntdll.dll', 'NtClose', 'nt-close');
  hookCloseHandleExport('ntdll.dll', 'ZwClose', 'zw-close');
}

function installAnimationFileHooks() {
  if (CAPTURE_OS_FILE_OPEN_HOOKS) {
    hookRuntimeFileOpen('KernelBase.dll', 'CreateFileW', 'createfile-wide', readUtf16Path);
    hookRuntimeFileOpen('KernelBase.dll', 'CreateFileA', 'createfile-ansi', readAnsiPathWithBytes);
    hookRuntimeFileOpen('kernel32.dll', 'CreateFileW', 'createfile-wide-k32', readUtf16Path);
    hookRuntimeFileOpen('kernel32.dll', 'CreateFileA', 'createfile-ansi-k32', readAnsiPathWithBytes);
  }
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

    if (CAPTURE_WWISE_REGISTRATION_HOOKS) {
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
    }

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
      .filter((mod) => /wwise|fmod|sound|represent|jx3|kg3d|engine/i.test(mod.name))
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
  if (CAPTURE_ANIMATION_HOOKS) {
    installAnimationTagHooks();
    installAnimationFileHooks();
    if (CAPTURE_PSS_READ_HOOKS) installPssReadHooks();
    if (CAPTURE_REPRESENT_SFX_HOOKS) installRepresentSfxHooks();
    if (CAPTURE_PARTICLE_EXPORT_HOOKS) installParticleExportHooks();
    if (CAPTURE_KG3D_PARTICLE_RVA_HOOKS) installKg3dParticleRvaHooks();
    if (CAPTURE_KG3D_DISPLAY_PROOF_HOOKS) installKg3dDisplayProofHooks();
  }
  if (CAPTURE_AUDIO_HOOKS) {
    installWwiseHooks();
    installFmodHooks();
  }
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

sendLog({
  type: 'audio-agent-ready',
  mode: AGENT_MODE,
  captureStacks: CAPTURE_STACKS,
  captureCallContext: CAPTURE_CALL_CONTEXT,
  deepProbes: CAPTURE_DEEP_PROBES,
  safeTrace: TRACE_SAFE_MODE,
  osFileOpenHooks: CAPTURE_OS_FILE_OPEN_HOOKS,
  pssReadHooks: CAPTURE_PSS_READ_HOOKS,
  pssObjectMethods: CAPTURE_PSS_OBJECT_METHODS,
  representSfxHooks: CAPTURE_REPRESENT_SFX_HOOKS,
  particleExportHooks: CAPTURE_PARTICLE_EXPORT_HOOKS,
  kg3dParticleRvaHooks: CAPTURE_KG3D_PARTICLE_RVA_HOOKS,
  kg3dDisplayProofHooks: CAPTURE_KG3D_DISPLAY_PROOF_HOOKS,
  wwiseRegistrationHooks: CAPTURE_WWISE_REGISTRATION_HOOKS,
  modules: moduleSnapshot(),
});
installHooks();
setInterval(installHooks, AGENT_RETRY_INTERVAL_MS);
receiveCommands();