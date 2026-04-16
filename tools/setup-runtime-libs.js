import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const NODE_MODULES = join(ROOT, 'node_modules');
const PUBLIC_LIB = join(ROOT, 'public', 'lib');

const THREE_ROOT = join(NODE_MODULES, 'three');
const BVH_ROOT = join(NODE_MODULES, 'three-mesh-bvh');

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function copyFileChecked(src, dst) {
  if (!existsSync(src)) {
    throw new Error(`Missing source file: ${src}`);
  }
  ensureDir(dirname(dst));
  cpSync(src, dst, { force: true });
}

function copyDirChecked(src, dst) {
  if (!existsSync(src)) {
    throw new Error(`Missing source directory: ${src}`);
  }
  ensureDir(dirname(dst));
  cpSync(src, dst, { recursive: true, force: true });
}

function rewriteGLTFLoaderImport(loaderPath) {
  const from = "../utils/BufferGeometryUtils.js";
  const to = "./BufferGeometryUtils.js";

  const original = readFileSync(loaderPath, 'utf8');
  const updated = original.includes(from)
    ? original.replace(from, to)
    : original;

  if (updated !== original) {
    writeFileSync(loaderPath, updated, 'utf8');
  }
}

function rewriteBvhBareImports(filePath, replacements) {
  const original = readFileSync(filePath, 'utf8');
  let updated = original;

  for (const [from, to] of replacements) {
    updated = updated.replace(from, to);
  }

  if (updated !== original) {
    writeFileSync(filePath, updated, 'utf8');
  }
}

function main() {
  ensureDir(PUBLIC_LIB);

  copyFileChecked(
    join(THREE_ROOT, 'build', 'three.module.js'),
    join(PUBLIC_LIB, 'three.module.js')
  );
  copyFileChecked(
    join(THREE_ROOT, 'examples', 'jsm', 'utils', 'BufferGeometryUtils.js'),
    join(PUBLIC_LIB, 'BufferGeometryUtils.js')
  );
  copyFileChecked(
    join(THREE_ROOT, 'examples', 'jsm', 'loaders', 'GLTFLoader.js'),
    join(PUBLIC_LIB, 'GLTFLoader.js')
  );
  rewriteGLTFLoaderImport(join(PUBLIC_LIB, 'GLTFLoader.js'));

  copyFileChecked(
    join(THREE_ROOT, 'examples', 'jsm', 'controls', 'TransformControls.js'),
    join(PUBLIC_LIB, 'three-addons', 'controls', 'TransformControls.js')
  );

  copyFileChecked(
    join(THREE_ROOT, 'examples', 'jsm', 'controls', 'OrbitControls.js'),
    join(PUBLIC_LIB, 'three-addons', 'controls', 'OrbitControls.js')
  );

  copyFileChecked(
    join(THREE_ROOT, 'examples', 'jsm', 'loaders', 'FBXLoader.js'),
    join(PUBLIC_LIB, 'three-addons', 'loaders', 'FBXLoader.js')
  );

  copyFileChecked(
    join(THREE_ROOT, 'examples', 'jsm', 'libs', 'fflate.module.js'),
    join(PUBLIC_LIB, 'three-addons', 'libs', 'fflate.module.js')
  );

  copyFileChecked(
    join(THREE_ROOT, 'examples', 'jsm', 'curves', 'NURBSCurve.js'),
    join(PUBLIC_LIB, 'three-addons', 'curves', 'NURBSCurve.js')
  );

  copyFileChecked(
    join(THREE_ROOT, 'examples', 'jsm', 'curves', 'NURBSUtils.js'),
    join(PUBLIC_LIB, 'three-addons', 'curves', 'NURBSUtils.js')
  );

  copyDirChecked(
    join(BVH_ROOT, 'src'),
    join(PUBLIC_LIB, 'three-mesh-bvh', 'src')
  );

  rewriteBvhBareImports(
    join(PUBLIC_LIB, 'three-mesh-bvh', 'src', 'core', 'ObjectBVH.js'),
    [[
      "from 'three-mesh-bvh';",
      "from '../index.js';",
    ]]
  );

  rewriteBvhBareImports(
    join(PUBLIC_LIB, 'three-mesh-bvh', 'src', 'core', 'SkinnedMeshBVH.js'),
    [[
      "from 'three-mesh-bvh';",
      "from '../index.js';",
    ]]
  );

  console.log('[setup-runtime-libs] Runtime browser libs are ready in public/lib');
}

try {
  main();
} catch (err) {
  console.error(`[setup-runtime-libs] ${err.message || err}`);
  process.exit(1);
}
