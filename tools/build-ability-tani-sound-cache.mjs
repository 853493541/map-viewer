import { buildAbilityTaniSoundCache } from './ability-tani-sound.js';

const extractTani = process.argv.includes('--extract');
const force = process.argv.includes('--force');

const cache = await buildAbilityTaniSoundCache({
  force,
  extractTani,
  onProgress: (event) => console.error('[ability-tani-sound]', JSON.stringify(event)),
});

console.log(JSON.stringify({
  ok: cache.ok,
  schemaVersion: cache.schemaVersion,
  total: cache.total,
  yes: cache.stats?.total?.yes || 0,
  no: cache.stats?.total?.no || 0,
  taniExtraction: cache.taniExtraction,
  cachePath: cache.cachePath,
}, null, 2));