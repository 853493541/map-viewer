// public/js/sounds.js — animation -> sound browser.
// Reads /api/anims (anim-sound-index.json built from .tani files).
'use strict';

const FACTION_LABELS = {
  TianCe: '天策 TianCe',
  ShaoLin: '少林 ShaoLin',
  WanHua: '万花 WanHua',
  QiXiu: '七秀 QiXiu',
  WuDu: '五毒 WuDu',
  TangMen: '唐门 TangMen',
  CangJian: '藏剑 CangJian',
  GaiBang: '丐帮 GaiBang',
  MingJiao: '明教 MingJiao',
  CangYun: '苍云 CangYun',
  ChangGe: '长歌 ChangGe',
  BaDao: '霸刀 BaDao',
  Other: 'Other / NPC',
};

const refs = {
  sidebarTitle: document.getElementById('sidebar-title'),
  catList: document.getElementById('cat-list'),
  catMeta: document.getElementById('cat-meta'),
  mainTitle: document.getElementById('main-title'),
  mainMeta: document.getElementById('main-meta'),
  animList: document.getElementById('anim-list'),
  listMeta: document.getElementById('list-meta'),
  playableMeta: document.getElementById('playable-meta'),
  search: document.getElementById('search-input'),
  modeCache: document.getElementById('mode-cache'),
  modeAni: document.getElementById('mode-ani'),
  aniToggleRow: document.getElementById('ani-toggle-row'),
  toggleSound: document.getElementById('toggle-with-sound'),
  togglePss: document.getElementById('toggle-with-pss'),
  togglePlayable: document.getElementById('toggle-playable'),
  details: document.getElementById('details'),
  player: document.getElementById('audio-player'),
  playerMeta: document.getElementById('player-meta'),
  debug: document.getElementById('debug-log'),
  aniHelperBlock: document.getElementById('ani-helper-block'),
  quickTestMeta: document.getElementById('quick-test-meta'),
  quickTestList: document.getElementById('quick-test-list'),
};

const state = {
  items: [],
  cacheAudio: [],
  cacheAudioSummary: null,
  browseMode: 'cache',
  cacheGroup: 'all',
  faction: null,
  selected: null,
  selectedCache: null,
};

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  refs.debug.textContent += `\n[${ts}] ${msg}`;
  refs.debug.scrollTop = refs.debug.scrollHeight;
}

function shortName(p) {
  const m = p.match(/[^\\/]+$/);
  return m ? m[0] : p;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function formatWhen(value) {
  if (!value) return 'unknown time';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'unknown time' : d.toLocaleString();
}

function playUrl(url, label) {
  refs.player.style.display = '';
  refs.player.src = url;
  refs.playerMeta.textContent = label || '';
  log(`play ${label || url}`);
  refs.player.play().catch(err => log(`play error: ${err.message}`));
}

function getFactionLabel(key) {
  return FACTION_LABELS[key] || key || 'Other';
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function getCacheStats() {
  const items = Array.isArray(state.cacheAudio) ? state.cacheAudio : [];
  const uniqueTani = new Set();
  let mappedCount = 0;
  for (const item of items) {
    const animations = Array.isArray(item.animations) ? item.animations : [];
    if (animations.length) mappedCount += 1;
    for (const animation of animations) {
      if (animation.file) uniqueTani.add(animation.file);
    }
  }
  return {
    count: items.length,
    mappedCount,
    unmappedCount: Math.max(0, items.length - mappedCount),
    uniqueTaniCount: uniqueTani.size,
  };
}

function getItemTaniCount(item) {
  return uniqueStrings((item?.animations || []).map((animation) => animation.file)).length;
}

function compareCacheItems(left, right) {
  if (Boolean(left.aniCount) !== Boolean(right.aniCount)) return (right.aniCount || 0) - (left.aniCount || 0);
  if ((right.mtimeMs || 0) !== (left.mtimeMs || 0)) return (right.mtimeMs || 0) - (left.mtimeMs || 0);
  return String(left.name || '').localeCompare(String(right.name || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function filteredCacheAudio() {
  const q = (refs.search.value || '').toLowerCase().trim();
  return state.cacheAudio.filter((item) => {
    const animations = Array.isArray(item.animations) ? item.animations : [];
    const hasMap = animations.length > 0;
    if (state.cacheGroup === 'mapped' && !hasMap) return false;
    if (state.cacheGroup === 'unmapped' && hasMap) return false;
    if (!q) return true;
    if (String(item.name || '').toLowerCase().includes(q)) return true;
    if (String(item.wemId || '').includes(q)) return true;
    if ((item.eventNames || []).some((eventName) => String(eventName).toLowerCase().includes(q))) return true;
    if (animations.some((animation) => String(animation.file || '').toLowerCase().includes(q))) return true;
    if (animations.some((animation) => String(animation.refAni || '').toLowerCase().includes(q))) return true;
    return false;
  });
}

function setBrowseMode(mode) {
  state.browseMode = mode === 'ani' ? 'ani' : 'cache';
  renderSidebar();
  renderMainList();
}

function playableHits(it) {
  const out = [];
  for (const sound of (it.sounds || [])) {
    for (const hit of (sound.wwise || [])) {
      if (hit.playable) out.push({ sound, hit });
    }
  }
  return out;
}

function isPlayableItem(it) {
  return playableHits(it).length > 0;
}

function bestPlayable(it) {
  return playableHits(it).sort((a, b) => b.hit.score - a.hit.score)[0] || null;
}

function buildFactionStats() {
  const stats = {};
  let playableTotal = 0;
  for (const it of state.items) {
    const key = it.faction || 'Other';
    if (!stats[key]) stats[key] = { count: 0, playable: 0 };
    stats[key].count++;
    if (isPlayableItem(it)) {
      stats[key].playable++;
      playableTotal++;
    }
  }
  return { stats, playableTotal };
}

function compareItems(a, b) {
  const aPlayable = playableHits(a).length;
  const bPlayable = playableHits(b).length;
  if (Boolean(aPlayable) !== Boolean(bPlayable)) return bPlayable - aPlayable;
  if (bPlayable !== aPlayable) return bPlayable - aPlayable;
  return shortName(a.refAni).localeCompare(shortName(b.refAni), undefined, { numeric: true, sensitivity: 'base' });
}

function focusItem(it) {
  if (!it) return;
  state.faction = it.faction || null;
  state.selected = it.file;
  state.browseMode = 'ani';
  refs.search.value = '';
  renderSidebar();
  renderMainList();
}

function focusCacheItem(item) {
  if (!item) return;
  state.selectedCache = item.name;
  state.browseMode = 'cache';
  renderSidebar();
  renderMainList();
}

async function loadIndex() {
  try {
    const r = await fetch('/api/anims');
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`HTTP ${r.status}: ${t}`);
    }
    const data = await r.json();
    state.items = data.items || [];
    const { playableTotal } = buildFactionStats();
    log(`loaded ${state.items.length} animations, ${playableTotal} playable now, from ${Object.keys(data.summary||{}).length} factions`);
    if (state.browseMode === 'ani') {
      renderSidebar();
      renderMainList();
    } else {
      renderQuickTests(state.items);
    }
  } catch (err) {
    log(`load error: ${err.message}`);
    refs.animList.innerHTML = `<li class="empty">Failed to load index: ${err.message}<br><br>Run: <code>node tools/build-anim-sound-index.mjs</code></li>`;
  }
}

async function loadCacheAudio() {
  try {
    const r = await fetch('/api/audio/cache/index');
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`HTTP ${r.status}: ${t}`);
    }
    const data = await r.json();
    state.cacheAudio = data.items || [];
    state.cacheAudioSummary = data;
    if (!state.selectedCache && state.cacheAudio.length) state.selectedCache = state.cacheAudio[0].name;
    log(`loaded ${state.cacheAudio.length} decoded cache file(s)`);
    if (state.browseMode === 'cache') {
      renderSidebar();
      renderMainList();
    }
  } catch (err) {
    state.cacheAudio = [];
    state.cacheAudioSummary = null;
    refs.playableMeta.textContent = `Failed to load decoded cache: ${err.message}`;
    refs.animList.innerHTML = '';
    log(`cache audio load error: ${err.message}`);
  }
}

function renderSidebar() {
  if (state.browseMode === 'cache') {
    const stats = getCacheStats();
    refs.sidebarTitle.textContent = 'Decoded Cache';
    refs.catMeta.textContent = `${stats.uniqueTaniCount} unique .tani`;
    refs.catList.innerHTML = [
      `<li class="cat-item ${state.cacheGroup === 'all' ? 'active' : ''}" data-key="all"><span>All decoded files</span><span class="cat-count">${stats.count}</span></li>`,
      `<li class="cat-item ${state.cacheGroup === 'mapped' ? 'active' : ''}" data-key="mapped"><span>Mapped to .tani</span><span class="cat-count">${stats.mappedCount}</span></li>`,
      `<li class="cat-item ${state.cacheGroup === 'unmapped' ? 'active' : ''}" data-key="unmapped"><span>No .tani match</span><span class="cat-count">${stats.unmappedCount}</span></li>`
    ].join('');
    return;
  }
  renderFactions();
}

function renderMainList() {
  refs.modeCache.classList.toggle('active', state.browseMode === 'cache');
  refs.modeAni.classList.toggle('active', state.browseMode === 'ani');
  refs.aniToggleRow.style.display = state.browseMode === 'ani' ? '' : 'none';
  refs.aniHelperBlock.style.display = state.browseMode === 'ani' ? '' : 'none';

  if (state.browseMode === 'cache') {
    refs.mainTitle.textContent = 'Decoded OGG Cache';
    refs.search.placeholder = 'Filter decoded OGG, WEM, event, .ani, or .tani…';
    renderCacheAudio();
    return;
  }

  refs.mainTitle.textContent = 'ANI Browser';
  refs.search.placeholder = 'Filter by .ani name, PSS, or sound event…';
  renderAniList();
}

function renderFactions() {
  const { stats, playableTotal } = buildFactionStats();
  const entries = Object.entries(stats).sort((a, b) => b[1].playable - a[1].playable || b[1].count - a[1].count);
  const total = state.items.length;
  refs.catMeta.textContent = `${playableTotal} playable / ${total} anims`;
  const html = [
    `<li class="cat-item ${!state.faction ? 'active' : ''}" data-key=""><span>All</span><span class="cat-count">${playableTotal}/${total}</span></li>`
  ];
  for (const [key, s] of entries) {
    const label = FACTION_LABELS[key] || key;
    html.push(`<li class="cat-item ${state.faction === key ? 'active' : ''}" data-key="${key}"><span>${label}</span><span class="cat-count">${s.playable}/${s.count}</span></li>`);
  }
  refs.catList.innerHTML = html.join('');
}

function filtered() {
  const q = (refs.search.value || '').toLowerCase().trim();
  const onlySound = refs.toggleSound.checked;
  const onlyPss = refs.togglePss.checked;
  const onlyPlayable = refs.togglePlayable.checked;
  return state.items.filter((it) => {
    if (state.faction && it.faction !== state.faction) return false;
    if (onlySound && !(it.sounds && it.sounds.length)) return false;
    if (onlyPss && !(it.pss && it.pss.length)) return false;
    if (onlyPlayable && !isPlayableItem(it)) return false;
    if (!q) return true;
    if (it.refAni.toLowerCase().includes(q)) return true;
    if (it.file.toLowerCase().includes(q)) return true;
    if ((it.pss || []).some((p) => p.toLowerCase().includes(q))) return true;
    if ((it.sounds || []).some((s) => (s.event || '').toLowerCase().includes(q))) return true;
    return false;
  });
}

function renderQuickTests(list) {
  const playable = list.filter(isPlayableItem);
  const { stats, playableTotal } = buildFactionStats();
  const headline = Object.entries(stats)
    .filter(([, s]) => s.playable > 0)
    .sort((a, b) => b[1].playable - a[1].playable)
    .slice(0, 3)
    .map(([key, s]) => `${FACTION_LABELS[key] || key} ${s.playable}`)
    .join(' | ');
  refs.playableMeta.innerHTML = `<strong>Playable now:</strong> ${playableTotal} total. ${headline || 'No playable rows found yet.'}`;
  refs.quickTestMeta.textContent = playable.length
    ? `Current view has ${playable.length} playable row(s). Click one of these and the detail panel will open on a real playable result.`
    : 'No playable rows in the current view. Clear the search or switch faction.';
  refs.quickTestList.innerHTML = playable.slice(0, 8).map((it) => {
    const best = bestPlayable(it);
    const label = getFactionLabel(it.faction);
    const playableName = best ? best.hit.name : 'playable';
    return `<button class="quick-btn" data-file="${encodeURIComponent(it.file)}">
      <span class="quick-main">${escapeHtml(label)}</span>
      <span class="quick-sub">${escapeHtml(shortName(it.refAni))}</span>
      <span class="quick-meta">${escapeHtml(playableName)}</span>
    </button>`;
  }).join('');
}

function renderCacheAudio() {
  const items = state.cacheAudio || [];
  const summary = state.cacheAudioSummary;
  const stats = getCacheStats();
  if (!summary || !items.length) {
    refs.playableMeta.textContent = 'No decoded OGG files yet. They appear here after this repo decodes Wwise WEMs.';
    refs.listMeta.textContent = '0 visible';
    refs.mainMeta.textContent = '0 total';
    refs.animList.innerHTML = '<li class="empty">No decoded OGG files yet.</li>';
    return;
  }
  const newest = summary.newest ? formatWhen(summary.newest.mtimeIso) : 'unknown';
  const oldest = summary.oldest ? formatWhen(summary.oldest.mtimeIso) : 'unknown';
  const list = filteredCacheAudio().sort(compareCacheItems);
  refs.mainMeta.textContent = `${summary.count} total`; 
  refs.playableMeta.innerHTML = `<strong>Decoded cache focus:</strong> ${stats.mappedCount} of ${summary.count} decoded OGG files map back to ${stats.uniqueTaniCount} unique <code>.tani</code> files in the current index. Oldest ${oldest}. Newest ${newest}.`; 
  refs.listMeta.textContent = `${list.length} visible / ${summary.count} total / ${stats.mappedCount} mapped`;
  if (!list.length) {
    refs.animList.innerHTML = '<li class="empty">No decoded cache files match the current search/filter.</li>';
    refs.details.innerHTML = '<div class="empty">No decoded cache file matches the current search/filter.</div>';
    return;
  }
  let selectedItem = list.find((item) => item.name === state.selectedCache) || list[0];
  state.selectedCache = selectedItem.name;
  refs.animList.innerHTML = list.map((item, index) => {
    const label = item.wemId != null ? `WEM ${item.wemId}` : item.name;
    const taniCount = getItemTaniCount(item);
    const mapMeta = item.aniCount
      ? `${item.aniCount} ANI • ${taniCount} .tani • ${item.eventCount} event${item.eventCount === 1 ? '' : 's'}`
      : 'No ANI match in current index';
    return `<li class="ar-row${state.selectedCache === item.name ? ' selected' : ''}${item.aniCount ? ' playable' : ''}" data-cache-idx="${index}">
      <div>
        <div class="ar-name">${escapeHtml(label)}</div>
        <div class="ar-sub">${escapeHtml(item.name)} • ${escapeHtml(formatWhen(item.mtimeIso))}</div>
      </div>
      <div class="ar-pills">
        ${item.aniCount ? `<span class="pill ok">ANI×${item.aniCount}</span>` : '<span class="pill">UNMAPPED</span>'}
        ${taniCount ? `<span class="pill wwise">TANI×${taniCount}</span>` : ''}
        ${item.eventCount ? `<span class="pill fmod">EVENT×${item.eventCount}</span>` : ''}
      </div>
    </li>`;
  }).join('');
  refs.animList._cacheItems = list;
  renderCacheAudioDetail(selectedItem);
}

function renderCacheAudioDetail(item) {
  if (!item) return;
  const eventNames = Array.isArray(item.eventNames) ? item.eventNames : [];
  const animations = Array.isArray(item.animations) ? item.animations : [];
  const taniFiles = uniqueStrings(animations.map((animation) => animation.file));
  const eventsHtml = eventNames.length
    ? eventNames.map((eventName) => `<div class="det-row sound"><span class="pill wwise">Wwise</span><span class="event">${escapeHtml(eventName)}</span></div>`).join('')
    : '<div class="empty" style="padding:6px;">No Wwise event in the current ANI index resolves to this decoded file yet.</div>';
  const taniHtml = taniFiles.length
    ? taniFiles.map((filePath) => `<div class="det-row"><span class="pill ok">.tani</span> ${escapeHtml(filePath)}</div>`).join('')
    : '<div class="empty" style="padding:6px;">No .tani file in the current ANI index maps to this decoded file yet.</div>';
  const animationsHtml = animations.length
    ? animations.map((animation) => {
      const matched = (animation.matchedEvents || []).slice(0, 3).join(', ');
      const source = (animation.sourceEvents || []).slice(0, 2).join(', ');
      return `<div class="det-row sound">
        <span class="pill ok">${escapeHtml(getFactionLabel(animation.faction))}</span>
        <span class="event">${escapeHtml(shortName(animation.refAni || animation.file || ''))}</span>
        <button class="play-btn jump-ani-btn" data-ani-file="${encodeURIComponent(animation.file || '')}">Open ANI</button>
        <span class="candidates">.tani: ${escapeHtml(animation.file || '')}</span>
        ${matched ? `<span class="candidates">matched Wwise: ${escapeHtml(matched)}</span>` : ''}
        ${source ? `<span class="candidates">source tag: ${escapeHtml(source)}</span>` : ''}
      </div>`;
    }).join('')
    : '<div class="empty" style="padding:6px;">No ANI match in the current /api/anims dataset.</div>';

  refs.details.innerHTML = `
    <div class="det-block">
      <h3>Decoded Cache File</h3>
      <div class="det-row ready">
        <span class="pill ok">Cache</span>
        <span class="event">${escapeHtml(item.name)}</span>
        ${item.wemId != null ? `<span class="pill" style="margin-left:6px;">wem ${item.wemId}</span>` : ''}
        <button class="play-btn" data-cache-name="${encodeURIComponent(item.name)}">▶ Play cached OGG</button>
        <span class="candidates">${escapeHtml(formatBytes(item.size))} • decoded ${escapeHtml(formatWhen(item.mtimeIso))} • ${animations.length} ANI rows • ${taniFiles.length} .tani files</span>
      </div>
    </div>
    <div class="det-block">
      <h3>Mapped Wwise events (${eventNames.length})</h3>
      ${eventsHtml}
    </div>
    <div class="det-block">
      <h3>Mapped .tani files (${taniFiles.length})</h3>
      ${taniHtml}
    </div>
    <div class="det-block">
      <h3>Mapped ANI rows (${animations.length})</h3>
      ${animationsHtml}
    </div>
  `;
}

function renderAniList() {
  const list = filtered().sort(compareItems);
  const playableVisible = list.filter(isPlayableItem).length;
  refs.mainMeta.textContent = `${state.items.length} indexed rows`;
  refs.listMeta.textContent = `${playableVisible} playable / ${list.length} visible / ${state.items.length} total`;
  refs.playableMeta.innerHTML = '';
  if (!list.length) {
    refs.animList.innerHTML = '<li class="empty">No matches.</li>';
    refs.animList._items = [];
    renderQuickTests([]);
    renderDetail(null);
    return;
  }
  let selectedItem = list.find((it) => it.file === state.selected) || list[0];
  state.selected = selectedItem.file;
  const html = list.map((it, i) => {
    const fmodN = (it.sounds || []).filter(s => s.system === 'FMOD').length;
    const wwiseN = (it.sounds || []).filter(s => s.system === 'Wwise').length;
    const pssN = (it.pss || []).length;
    const playableN = playableHits(it).length;
    const pills = [];
    if (playableN) pills.push(`<span class="pill ok">PLAYABLE×${playableN}</span>`);
    if (fmodN) pills.push(`<span class="pill fmod">FMOD×${fmodN}</span>`);
    if (wwiseN) pills.push(`<span class="pill wwise">Wwise×${wwiseN}</span>`);
    if (pssN) pills.push(`<span class="pill pss">PSS×${pssN}</span>`);
    return `<li class="ar-row${state.selected === it.file ? ' selected' : ''}${playableN ? ' playable' : ''}" data-idx="${i}">
      <div>
        <div class="ar-name">${shortName(it.refAni)}</div>
        <div class="ar-sub">${it.refAni}</div>
      </div>
      <div class="ar-pills">${pills.join('')}</div>
    </li>`;
  });
  refs.animList.innerHTML = html.join('');
  refs.animList._items = list;
  renderQuickTests(list);
  renderDetail(selectedItem);
}

function renderDetail(it) {
  if (!it) { refs.details.innerHTML = '<div class="empty">Pick an animation on the left.</div>'; return; }
  const best = bestPlayable(it);
  const pssHtml = (it.pss || []).map(p => `<div class="det-row"><span class="pill pss">PSS</span> ${p}</div>`).join('') || '<div class="empty" style="padding:6px;">No SFX tags.</div>';
  const soundHtml = (it.sounds || []).map((s, si) => {
    const sysCls = s.system === 'Wwise' ? 'wwise' : '';
    const candStr = (s.candidates && s.candidates.length) ? `<span class="candidates">candidates: ${s.candidates.join(', ')}</span>` : '';
    const wwiseAll = (s.wwise || []).slice(0, 5);
    let wwiseHtml = '';
    if (wwiseAll.length) {
      wwiseHtml = '<div class="wwise-hits" style="margin-top:6px;">' +
        wwiseAll.map((w, i) => `
          <div class="det-row" style="margin:2px 0;background:${w.playable ? 'rgba(122,210,213,0.12)' : 'rgba(160,160,160,0.06)'};opacity:${w.playable ? 1 : 0.65};">
            <span class="pill wwise">Wwise</span>
            <span class="event">${w.name}</span>
            <span class="pill" style="margin-left:6px;">id ${w.id}</span>
            <span class="pill" style="margin-left:4px;">score ${w.score}</span>
            ${w.playable
              ? `<button class="play-btn" data-event-id="${w.id}" data-event-name="${encodeURIComponent(w.name)}">▶ Play${i === 0 ? ' (best)' : ''}</button>`
              : '<span class="pill" style="margin-left:4px;background:#553;">no WEMs in indexed banks</span>'}
          </div>`).join('') + '</div>';
    }
    return `<div class="det-row sound">
      <span class="system ${sysCls}">${s.system}</span>
      <span class="event">${s.event || '(no path)'}</span>
      ${s.bank ? `<span class="pill" style="margin-left:6px;">bank: ${s.bank}</span>` : ''}
      ${candStr}
      ${wwiseHtml}
    </div>`;
  }).join('') || '<div class="empty" style="padding:6px;">No Sound tag.</div>';

  const readyHtml = best ? `
    <div class="det-block">
      <h3>Ready Now</h3>
      <div class="det-row ready">
        <span class="pill ok">Playable</span>
        <span class="event">${escapeHtml(best.hit.name)}</span>
        <span class="pill" style="margin-left:6px;">id ${best.hit.id}</span>
        <button class="play-btn" data-event-id="${best.hit.id}" data-event-name="${encodeURIComponent(best.hit.name)}">▶ Play best now</button>
      </div>
    </div>` : '';

  refs.details.innerHTML = `
    ${readyHtml}
    <div class="det-block">
      <h3>Source .tani</h3>
      <div class="det-row">${it.file}</div>
    </div>
    <div class="det-block">
      <h3>References .ani</h3>
      <div class="det-row">${it.refAni}</div>
    </div>
    <div class="det-block">
      <h3>SFX tags (${(it.pss || []).length})</h3>
      ${pssHtml}
    </div>
    <div class="det-block">
      <h3>Sound tags (${(it.sounds || []).length})</h3>
      ${soundHtml}
    </div>
  `;
}

refs.catList.addEventListener('click', (e) => {
  const li = e.target.closest('.cat-item');
  if (!li) return;
  if (state.browseMode === 'cache') {
    state.cacheGroup = li.dataset.key || 'all';
    renderSidebar();
    renderMainList();
    return;
  }
  state.faction = li.dataset.key || null;
  renderSidebar();
  renderMainList();
});

refs.animList.addEventListener('click', (e) => {
  if (state.browseMode === 'cache') {
    const row = e.target.closest('.ar-row');
    if (!row) return;
    const idx = Number(row.dataset.cacheIdx);
    const list = refs.animList._cacheItems || [];
    const item = list[idx];
    if (!item) return;
    state.selectedCache = item.name;
    renderMainList();
    return;
  }
  const row = e.target.closest('.ar-row');
  if (!row) return;
  const idx = Number(row.dataset.idx);
  const list = refs.animList._items || [];
  const it = list[idx];
  if (!it) return;
  state.selected = it.file;
  renderMainList();
});

refs.quickTestList.addEventListener('click', (e) => {
  const btn = e.target.closest('.quick-btn');
  if (!btn) return;
  const file = btn.dataset.file ? decodeURIComponent(btn.dataset.file) : '';
  const it = state.items.find((item) => item.file === file);
  if (!it) return;
  focusItem(it);
});

refs.details.addEventListener('click', (e) => {
  const jumpBtn = e.target.closest('.jump-ani-btn');
  if (jumpBtn) {
    const file = jumpBtn.dataset.aniFile ? decodeURIComponent(jumpBtn.dataset.aniFile) : '';
    const item = state.items.find((entry) => entry.file === file);
    if (item) focusItem(item);
    return;
  }
  const cacheBtn = e.target.closest('[data-cache-name].play-btn');
  if (cacheBtn) {
    const name = cacheBtn.dataset.cacheName ? decodeURIComponent(cacheBtn.dataset.cacheName) : '';
    if (!name) return;
    playUrl(`/api/audio/cache/file?name=${encodeURIComponent(name)}`, `cache ${name}`);
    return;
  }
  const btn = e.target.closest('.play-btn');
  if (!btn) return;
  const id = btn.dataset.eventId;
  const name = btn.dataset.eventName ? decodeURIComponent(btn.dataset.eventName) : null;
  if (!id && !name) return;
  // Prefer ID (we know it's playable in this bnk corpus); fallback to name.
  const url = id
    ? `/api/audio/wwise/event?event=${id}`
    : `/api/audio/wwise/event?event=${encodeURIComponent(name)}`;
  playUrl(url, name || id);
});

refs.search.addEventListener('input', renderList);
refs.toggleSound.addEventListener('change', renderMainList);
refs.togglePss.addEventListener('change', renderMainList);
refs.togglePlayable.addEventListener('change', renderMainList);
refs.modeCache.addEventListener('click', () => setBrowseMode('cache'));
refs.modeAni.addEventListener('click', () => setBrowseMode('ani'));

function renderList() {
  renderMainList();
}

renderSidebar();
renderMainList();
loadIndex();
loadCacheAudio();
