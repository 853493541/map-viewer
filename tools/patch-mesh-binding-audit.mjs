// Patch actor-animation-player.js to add mesh-emitter material-binding audit
// that surfaces results in the on-page #pss-log-panel via pssLogStep().
import fs from 'node:fs';
const FILE = 'public/js/actor-animation-player.js';
let s = fs.readFileSync(FILE, 'utf8');

if (s.includes('auditMeshMaterialBinding')) {
  console.log('[patch] already applied; nothing to do');
  process.exit(0);
}

function replaceOnce(needle, replacement, label) {
  const occ = s.split(needle).length - 1;
  if (occ !== 1) throw new Error(`[patch] anchor "${label}" matched ${occ} times, need exactly 1`);
  s = s.replace(needle, replacement);
  console.log(`[patch] applied: ${label}`);
}

// 1) Add meshBindingAudit field to pssDebugState (after socketRouting: [])
replaceOnce(
  `  // Per-PSS socket routing (what the renderer actually applied, and why).\r\n  socketRouting: [],\r\n  textureResults: [],`,
  `  // Per-PSS socket routing (what the renderer actually applied, and why).\r\n  socketRouting: [],\r\n  // Per-PSS audit of mesh emitter material binding (launcher.nMaterialIndex\r\n  // -> embedded KE3D_MT_PARTICLE_MATERIAL .tga). Surfaced live in the\r\n  // on-page #pss-log-panel via pssLogStep so the user can verify, per PSS,\r\n  // that every mesh emitter resolved to its authored .tga textures.\r\n  meshBindingAudit: [],\r\n  textureResults: [],`,
  'pssDebugState.meshBindingAudit field'
);

// 2) Reset meshBindingAudit in resetDebugState
replaceOnce(
  `  pssDebugState.socketRouting = [];\r\n  pssDebugState.textureResults = [];`,
  `  pssDebugState.socketRouting = [];\r\n  pssDebugState.meshBindingAudit = [];\r\n  pssDebugState.textureResults = [];`,
  'resetDebugState reset meshBindingAudit'
);

// 3) Insert auditMeshMaterialBinding fn after dbg() closes, before fallback aggregator comment
const auditFn = `\r\n// Per-PSS mesh-emitter material-binding audit. For every mesh emitter that\r\n// has a .Mesh path, verifies launcher.nMaterialIndex (decoded server-side\r\n// at +260 in the type-2 launcher block) successfully resolved into a PSS\r\n// embedded KE3D_MT_PARTICLE_MATERIAL record with .tga textures present in\r\n// cache. Pushes one item per mesh emitter to pssDebugState.meshBindingAudit\r\n// AND mirrors every result to the on-page #pss-log-panel via pssLogStep so\r\n// the user can see, per click, that every PSS file we load has matching\r\n// .tga textures (or which emitter failed to bind and why).\r\nfunction auditMeshMaterialBinding(data, sourcePath) {\r\n  const fileName = sourcePath ? sourcePath.split(/[\\\\/]/).pop() : '?';\r\n  const meshEms = (data?.emitters || []).filter(\r\n    (e) => e.type === 'mesh' && Array.isArray(e.meshes) && e.meshes.length > 0,\r\n  );\r\n  let okCount = 0;\r\n  const startIdx = pssDebugState.meshBindingAudit.length;\r\n  for (const em of meshEms) {\r\n    const meshName = (em.meshes[0] || '').split(/[\\\\/]/).pop();\r\n    const texPaths = Array.isArray(em.texturePaths) ? em.texturePaths : [];\r\n    const resolved = Array.isArray(em.resolvedTextures) ? em.resolvedTextures : [];\r\n    const resolvedOk = resolved.filter((t) => t && t.existsInCache).length;\r\n    const texCount = texPaths.length;\r\n    const ok = texCount > 0 && resolvedOk === texCount;\r\n    if (ok) okCount++;\r\n    pssDebugState.meshBindingAudit.push({\r\n      sourcePath, fileName,\r\n      index: em.index, mesh: meshName,\r\n      materialIndex: (em.materialIndex == null) ? null : em.materialIndex,\r\n      refPath: em.materialRefPath || null,\r\n      textureSource: em.textureSource || 'unbound',\r\n      textures: texPaths.map((p) => (p || '').split(/[\\\\/]/).pop()),\r\n      texCount, resolvedOk, ok,\r\n    });\r\n  }\r\n  if (meshEms.length > 0 && typeof pssLogStep === 'function') {\r\n    const allOk = okCount === meshEms.length;\r\n    pssLogStep(allOk ? 'right' : 'wrong',\r\n      \`mesh material binding: \${okCount}/\${meshEms.length} matched\`,\r\n      { sourcePath, ok: okCount, total: meshEms.length });\r\n    const items = pssDebugState.meshBindingAudit.slice(startIdx);\r\n    for (const item of items) {\r\n      const idxStr = item.materialIndex == null ? 'n/a' : '#' + item.materialIndex;\r\n      const refTail = item.refPath ? item.refPath.split(/[\\\\/]/).pop() : '\\u2014';\r\n      const texList = item.textures.length ? item.textures.join(', ') : '(no .tga)';\r\n      pssLogStep(item.ok ? 'right' : 'wrong',\r\n        \`[\${item.index}] \${item.mesh} <- mat\${idxStr} \${refTail} (\${item.resolvedOk}/\${item.texCount}) :: \${texList}\`,\r\n        { textureSource: item.textureSource, materialIndex: item.materialIndex, refPath: item.refPath, textures: item.textures });\r\n    }\r\n  }\r\n}\r\n`;

replaceOnce(
  `  else console.debug(\`[PSS Debug] [\${category}]\`, msg, data || '');\r\n}\r\n\r\n// Per-PSS fallback aggregator:`,
  `  else console.debug(\`[PSS Debug] [\${category}]\`, msg, data || '');\r\n}\r\n${auditFn}\r\n// Per-PSS fallback aggregator:`,
  'auditMeshMaterialBinding function'
);

// 4) Call it in addPssEffect after debugDump push
const addPssAnchor = `    if (debugDump && debugDump.ok) {\r\n      debugDump._sourcePath = sourcePath;\r\n      if (!pssDebugState.debugDumps.some((d) => d._sourcePath === sourcePath)) {\r\n        pssDebugState.debugDumps.push(debugDump);\r\n      }\r\n    }\r\n\r\n    // Per-PSS socket selection: honor the server-provided hint if it resolves`;
const addPssReplacement = `    if (debugDump && debugDump.ok) {\r\n      debugDump._sourcePath = sourcePath;\r\n      if (!pssDebugState.debugDumps.some((d) => d._sourcePath === sourcePath)) {\r\n        pssDebugState.debugDumps.push(debugDump);\r\n      }\r\n    }\r\n\r\n    // Mesh-emitter material binding audit: surfaces per-PSS pass/fail in the\r\n    // on-page #pss-log-panel so we can see, every click, that every mesh\r\n    // emitter resolved its launcher.nMaterialIndex -> .tga binding.\r\n    auditMeshMaterialBinding(data, sourcePath);\r\n\r\n    // Per-PSS socket selection: honor the server-provided hint if it resolves`;
replaceOnce(addPssAnchor, addPssReplacement, 'addPssEffect call site');

// 5) Call it in loadPssEffect after debugDump push (different surrounding text)
const loadPssAnchor = `    pssDebugState.apiData = data;\r\n    if (debugDump && debugDump.ok) {\r\n      debugDump._sourcePath = sourcePath;\r\n      if (!pssDebugState.debugDumps.some((d) => d._sourcePath === sourcePath)) {\r\n        pssDebugState.debugDumps.push(debugDump);\r\n      }\r\n    }\r\n\r\n    const requestedSocket`;
const loadPssReplacement = `    pssDebugState.apiData = data;\r\n    if (debugDump && debugDump.ok) {\r\n      debugDump._sourcePath = sourcePath;\r\n      if (!pssDebugState.debugDumps.some((d) => d._sourcePath === sourcePath)) {\r\n        pssDebugState.debugDumps.push(debugDump);\r\n      }\r\n    }\r\n\r\n    auditMeshMaterialBinding(data, sourcePath);\r\n\r\n    const requestedSocket`;
replaceOnce(loadPssAnchor, loadPssReplacement, 'loadPssEffect call site');

fs.writeFileSync(FILE, s);
console.log('[patch] wrote', FILE, 'size now', s.length);
