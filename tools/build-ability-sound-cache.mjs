import { buildAbilitySoundCache } from './ability-sound-cache.js';

const forcePrefix = process.argv.includes('--force-prefix');
const cache = await buildAbilitySoundCache({
	forcePrefix,
	onProgress(progress) {
		const parts = Object.entries(progress)
			.map(([key, value]) => `${key}=${value}`)
			.join(' ');
		console.log(parts);
	},
});

console.log(`wrote ${cache.cachePath}`);
console.log(JSON.stringify(cache.stats, null, 2));