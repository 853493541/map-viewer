// Patch: replace the guessed mesh transform pass in loadMeshEmitter with
// "render mesh as authored, only apply emitterScale". Direct-to-disk to
// bypass the stale VS Code editor buffer issue.
import fs from 'node:fs';
const FILE = 'public/js/actor-animation-player.js';
let s = fs.readFileSync(FILE, 'utf8');
const before = s.length;

if (!s.includes('centerAndScaleMeshGroup')) {
  console.log('[patch] no centerAndScaleMeshGroup found — already patched? size:', before);
  process.exit(0);
}

function replaceOnce(old, repl, label) {
  const occ = s.split(old).length - 1;
  if (occ !== 1) throw new Error(`[patch] anchor "${label}" matched ${occ} times`);
  s = s.replace(old, repl);
  console.log('[patch] applied:', label);
}

const oldHeader = `  // PSS particle meshes: normalize to 100 units max, matching the track emitter\r\n  // normalisation (scale = 100 / maxDim) so all effect layers share the same\r\n  // coordinate scale. Then apply the per-emitter emitterScale from meshFields.\r\n  const pssEffectNormalizeSize = 100;\r\n  const emitterScaleFactor = Number.isFinite(meshAsset?.meshFields?.emitterScale)\r\n    ? Math.max(0.1, Math.min(4, meshAsset.meshFields.emitterScale)) : 1;\r\n  const actorMultiMeshRadialOffset = 8;`;
const newHeader = `  // Authored emitter scale from the type-2 launcher block (+308 f32). This\r\n  // is the ONLY transform field we extract today. \`f3MeshScale\` (Vector3)\r\n  // and \`f3CenterAdjust\` (Vector3) from the editor's mesh schema (DLL\r\n  // \`KG3D_SceneNodeFactory\` strings: szMeshPath / f3MeshScale /\r\n  // f3CenterAdjust / eUpAxis / eForwardAxis) are not yet probed in the\r\n  // type-2 block, so until those offsets are wired we apply only this\r\n  // uniform multiplier and otherwise render the mesh as authored.\r\n  const emitterScaleFactor = Number.isFinite(meshAsset?.meshFields?.emitterScale)\r\n    ? Math.max(0.1, Math.min(4, meshAsset.meshFields.emitterScale)) : 1;`;
replaceOnce(oldHeader, newHeader, 'remove pssEffectNormalizeSize / actorMultiMeshRadialOffset');

const oldFn = `  const centerAndScaleMeshGroup = (root) => {\r\n    const box = new THREE.Box3().setFromObject(root);\r\n    if (box.isEmpty()) return false;\r\n    const boxCenter = new THREE.Vector3();\r\n    const boxSize = new THREE.Vector3();\r\n    box.getCenter(boxCenter);\r\n    box.getSize(boxSize);\r\n    const maxDim = Math.max(boxSize.x, boxSize.y, boxSize.z);\r\n    if (!Number.isFinite(maxDim) || maxDim <= 0.0001) return false;\r\n    const normScale = (pssEffectNormalizeSize / maxDim) * emitterScaleFactor;\r\n    root.scale.setScalar(normScale);\r\n    root.position.copy(boxCenter).multiplyScalar(-normScale);\r\n    return true;\r\n  };`;
const newFn = `  // Authored-transform pass.\r\n  // Previously: bbox-recentre + normalize-to-100 with isotropic scale. Both\r\n  // were guesses that DESTROYED the mesh's authored shape:\r\n  //   - normalize-to-100 erased authored size relative to the actor.\r\n  //   - bbox-recentre erased the authored pivot (\`f3CenterAdjust\` in the\r\n  //     editor's mesh-node schema).\r\n  // Engine behaviour: render mesh at authored size with the launcher's\r\n  // emitterScale (+308 in type-2 block) applied as uniform scale. Until\r\n  // we wire \`f3MeshScale\` (Vector3) and \`f3CenterAdjust\` from the\r\n  // launcher bytes, this is the honest rendering.\r\n  const applyAuthoredEmitterScale = (root) => {\r\n    if (Number.isFinite(emitterScaleFactor) && emitterScaleFactor !== 1) {\r\n      root.scale.setScalar(emitterScaleFactor);\r\n    }\r\n    return true;\r\n  };`;
replaceOnce(oldFn, newFn, 'replace centerAndScaleMeshGroup');

const oldCall = `      const instance = prepareMeshInstance(root);\r\n      await applyPssMeshMaterialTextures(instance);\r\n      if (!centerAndScaleMeshGroup(instance)) continue;\r\n\r\n      if (resolvedMeshAssets.length > 1) {\r\n        const angle = (meshIndex / Math.max(resolvedMeshAssets.length, 1)) * Math.PI * 2;\r\n        const radial = actorMultiMeshRadialOffset;\r\n        instance.position.x += Math.cos(angle) * radial;\r\n        instance.position.z += Math.sin(angle) * radial;\r\n      }\r\n\r\n      group.add(instance);`;
const newCall = `      const instance = prepareMeshInstance(root);\r\n      await applyPssMeshMaterialTextures(instance);\r\n      applyAuthoredEmitterScale(instance);\r\n\r\n      // No invented radial spread for multi-mesh emitters: the engine\r\n      // renders all referenced meshes at the launcher origin (they overlap\r\n      // by design, e.g. red02's 4 dragon-head meshes layer to compose one\r\n      // visual). Spreading them in a ring was a guess and made the effect\r\n      // look like several separate objects orbiting a point.\r\n\r\n      group.add(instance);`;
replaceOnce(oldCall, newCall, 'replace call site');

fs.writeFileSync(FILE, s);
console.log('[patch] done; size', before, '->', s.length);
