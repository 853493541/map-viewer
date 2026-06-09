// Reverse-engineer dirHash → parent path by brute-forcing known patterns.
import iconv from 'iconv-lite';
function djb2(s) { let h = 5381; for (const c of iconv.encode(s, 'gbk')) h = ((h * 33) + c) & 0x3fffff; return h >>> 0; }

const TARGETS = {
  958761: 'data/wwiseaudio/generatedsoundbanks/windows/base', // known
  1913463: '?',
  4088703: '?',
  3929621: '?',
  2476016: '?',
};

const bases = ['data', 'data/audio', 'data/sound', 'data/wwiseaudio', 'data/wwiseaudio/generatedsoundbanks'];
const middles = ['', 'wwiseaudio', 'wwise', 'sound', 'audio', 'fmod', 'generatedsoundbanks', 'win', 'windows'];
const subs = ['generatedsoundbanks', 'originals', 'cache', 'sfx', 'voice', 'media', 'streamed', 'character', 'characters', 'menpai', ''];
const platforms = ['windows', 'win', 'pc', 'chinese(prc)', 'chinese', 'sfx', 'voice', ''];
const tail = ['', 'base', 'streamed', 'streamedaudio', 'voice', 'sfx', 'media', 'cache', 'gen', 'in_memory', 'inmemory', 'originals', 'wem', 'menpai', 'characters', 'skills', 'tiance', 'shaolin', 'qixiu', 'wudu', 'tangmen', 'cangjian', 'gaibang', 'changge', 'badao', 'cangyun', 'chunyang', 'wanhua', 'mingjiao', 'penglai', 'lingxue', 'wanling', 'character', 'common', 'ui', 'bgm', 'amb'];

const paths = new Set();
for (const b of bases) for (const m of middles) for (const s of subs) for (const p of platforms) for (const t of tail) {
  const parts = [b, m, s, p, t].filter(Boolean);
  paths.add(parts.join('/').toLowerCase());
}
console.log('candidates:', paths.size);
for (const path of paths) {
  const h = djb2(path);
  if (TARGETS[h] !== undefined) console.log('HIT', h, '->', path);
}

// Also show what the known one hashes to
console.log('verify base 958761 ->', djb2('data/wwiseaudio/generatedsoundbanks/windows/base'));
