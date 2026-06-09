// Iter4 replacement for initPssOnlyMode — fixes:
//   • Concurrent loadOnePss calls racing the scene (clearEffect from a
//     newer click wipes emitters added by an earlier click → blank
//     viewport even though the log says "scene ready"). We serialize via
//     a generation token: probes (cheap, server-cached) run for every
//     click, but only the most recent click is allowed to mutate
//     scene/global state.
//   • Layout: the new #pss-log-panel is fixed-position 460 px on the
//     right. The viewport's actual container is #right-area (set in
//     pss.html with `right: 12px`). Without shrinking it, the WebGL
//     canvas keeps full width and its right 460 px is hidden behind the
//     log panel. Mutate #right-area's `right` so the ResizeObserver on
//     #viewport-panel re-sizes the renderer correctly.

const __PSS_LOG = {
  steps: [],
  t0: 0,
  activeTab: 'right',
};

let __pssCurrentLoadGen = 0;

function pssLogReset() {
  __PSS_LOG.steps.length = 0;
  __PSS_LOG.t0 = performance.now();
}

function pssLogStep(level, msg, data) {
  __PSS_LOG.steps.push({
    tMs: Math.max(0, Math.round(performance.now() - __PSS_LOG.t0)),
    level,
    msg: String(msg || ''),
    data: data || null,
  });
  pssLogRender();
}

function pssLogSetTab(tab) {
  __PSS_LOG.activeTab = tab;
  const panel = document.getElementById('pss-log-panel');
  if (!panel) return;
  panel.querySelectorAll('.pss-log-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  pssLogRender();
}

function pssLogRender() {
  const panel = document.getElementById('pss-log-panel');
  if (!panel) return;
  const body = panel.querySelector('.pss-log-body');
  if (!body) return;
  const steps = __PSS_LOG.steps;
  const want = __PSS_LOG.activeTab;
  const filtered = steps.filter((s) => {
    if (want === 'right') return s.level === 'right' || s.level === 'info';
    if (want === 'wrong') return s.level === 'wrong';
    return true;
  });
  const rightCount = steps.filter((s) => s.level === 'right' || s.level === 'info').length;
  const wrongCount = steps.filter((s) => s.level === 'wrong').length;
  const rb = panel.querySelector('[data-tab="right"] .pss-log-count');
  const wb = panel.querySelector('[data-tab="wrong"] .pss-log-count');
  if (rb) rb.textContent = String(rightCount);
  if (wb) wb.textContent = String(wrongCount);
  if (!filtered.length) {
    body.innerHTML = '<div style="color:#8ea2ba;padding:8px;font-style:italic;">no entries yet</div>';
    return;
  }
  const rows = filtered.map((s) => {
    const mark = s.level === 'wrong' ? '✗' : (s.level === 'right' ? '✓' : '·');
    const color = s.level === 'wrong' ? '#ff8888' : (s.level === 'right' ? '#9be39b' : '#8ea2ba');
    const detail = s.data ? `<div class="pss-log-data">${escapeHtml(JSON.stringify(s.data))}</div>` : '';
    return `<div class="pss-log-row">
      <span class="pss-log-t">${s.tMs.toString().padStart(5, ' ')}ms</span>
      <span class="pss-log-mark" style="color:${color}">${mark}</span>
      <span class="pss-log-msg">${escapeHtml(s.msg)}</span>
      ${detail}
    </div>`;
  });
  body.innerHTML = rows.join('');
  body.scrollTop = body.scrollHeight;
}

function pssLogInstallPanel() {
  const old = document.getElementById('debug-panel');
  if (old) old.remove();

  // Shrink the right area so #viewport-panel's ResizeObserver re-sizes
  // the renderer's WebGL canvas to the visible region. Without this the
  // canvas remains full-width and the right 460 px renders under the
  // log panel — looks like nothing renders.
  const PANEL_WIDTH = 460;
  const rightArea = document.getElementById('right-area');
  if (rightArea) rightArea.style.right = `${PANEL_WIDTH + 12}px`;

  const panel = document.createElement('aside');
  panel.id = 'pss-log-panel';
  panel.innerHTML = `
    <style>
      #pss-log-panel {
        position: fixed;
        right: 0; top: var(--global-header-offset, 90px); bottom: 0;
        width: 460px;
        background: #11161c;
        border-left: 1px solid #2a3340;
        color: #d4d8de;
        font: 11px/1.45 ui-monospace, Menlo, Consolas, monospace;
        display: flex;
        flex-direction: column;
        z-index: 60;
      }
      #pss-log-panel .pss-log-tabs {
        display: flex;
        border-bottom: 1px solid #2a3340;
        background: #0d1117;
        flex-shrink: 0;
      }
      #pss-log-panel .pss-log-tab {
        flex: 1;
        background: none;
        border: none;
        color: #8ea2ba;
        padding: 8px 12px;
        cursor: pointer;
        font: inherit;
        text-align: left;
      }
      #pss-log-panel .pss-log-tab.active {
        color: #fff;
        background: #11161c;
        border-bottom: 2px solid #58a6ff;
      }
      #pss-log-panel .pss-log-tab[data-tab="right"].active { border-bottom-color: #3fb950; }
      #pss-log-panel .pss-log-tab[data-tab="wrong"].active { border-bottom-color: #f85149; }
      #pss-log-panel .pss-log-count { opacity: 0.7; margin-left: 6px; font-size: 10px; }
      #pss-log-panel .pss-log-toolbar {
        padding: 4px 8px;
        border-bottom: 1px solid #2a3340;
        display: flex;
        gap: 6px;
        flex-shrink: 0;
      }
      #pss-log-panel .pss-log-toolbar button {
        background: #1f2630;
        color: #d4d8de;
        border: 1px solid #2a3340;
        padding: 3px 8px;
        cursor: pointer;
        font: inherit;
        border-radius: 3px;
      }
      #pss-log-panel .pss-log-toolbar button:hover { background: #2a3340; }
      #pss-log-panel .pss-log-body {
        flex: 1;
        overflow-y: auto;
        padding: 4px 0;
      }
      #pss-log-panel .pss-log-row {
        padding: 2px 8px;
        border-bottom: 1px solid #1a2028;
        word-break: break-word;
      }
      #pss-log-panel .pss-log-t { color: #58a6ff; margin-right: 6px; }
      #pss-log-panel .pss-log-mark { margin-right: 6px; font-weight: bold; }
      #pss-log-panel .pss-log-data {
        color: #8ea2ba;
        font-size: 10px;
        margin-left: 78px;
        margin-top: 2px;
      }
    </style>
    <div class="pss-log-tabs">
      <button class="pss-log-tab active" type="button" data-tab="right">
        ✓ Things went right <span class="pss-log-count">0</span>
      </button>
      <button class="pss-log-tab" type="button" data-tab="wrong">
        ✗ Things went wrong <span class="pss-log-count">0</span>
      </button>
    </div>
    <div class="pss-log-toolbar">
      <button type="button" id="pss-log-copy">Copy log</button>
      <button type="button" id="pss-log-clear">Clear</button>
    </div>
    <div class="pss-log-body"></div>
  `;
  document.body.appendChild(panel);
  panel.querySelectorAll('.pss-log-tab').forEach((b) => {
    b.addEventListener('click', () => pssLogSetTab(b.dataset.tab));
  });
  panel.querySelector('#pss-log-copy').addEventListener('click', () => {
    const txt = __PSS_LOG.steps.map((s) =>
      `${s.tMs.toString().padStart(5, ' ')}ms [${s.level}] ${s.msg}` +
      (s.data ? ` ${JSON.stringify(s.data)}` : '')
    ).join('\n');
    navigator.clipboard?.writeText(txt);
  });
  panel.querySelector('#pss-log-clear').addEventListener('click', () => {
    pssLogReset();
    pssLogRender();
  });
}

function pssLogIngestDebugState() {
  const emitters = pssDebugState.emitters || [];
  const meshResults = pssDebugState.meshResults || [];
  const textureResults = pssDebugState.textureResults || [];
  const errors = pssDebugState.errors || [];
  const fallbacks = pssDebugState.fallbacks || [];

  const meshOk = meshResults.filter((m) => !m.error);
  const meshFail = meshResults.filter((m) => m.error);
  const texOk = textureResults.filter((t) => !t.error && !t.placeholder);
  const texFail = textureResults.filter((t) => t.error);
  const texPlaceholder = textureResults.filter((t) => t.placeholder);

  pssLogStep('right', `${emitters.length} emitter(s) registered by parser`, { count: emitters.length });
  if (meshOk.length) pssLogStep('right', `${meshOk.length} mesh emitter(s) loaded successfully`,
    { paths: meshOk.slice(0, 6).map((m) => m.path || m.msg) });
  if (texOk.length) pssLogStep('right', `${texOk.length} texture(s) resolved`,
    { sample: texOk.slice(0, 4).map((t) => t.path || t.msg) });

  if (texPlaceholder.length) pssLogStep('wrong', `${texPlaceholder.length} texture(s) replaced by placeholder`,
    { sample: texPlaceholder.slice(0, 4).map((t) => t.path || t.msg) });
  if (meshFail.length) pssLogStep('wrong', `${meshFail.length} mesh emitter(s) failed to load`,
    { sample: meshFail.slice(0, 6).map((m) => ({ path: m.path, err: m.error || m.msg })) });
  if (texFail.length) pssLogStep('wrong', `${texFail.length} texture(s) failed`,
    { sample: texFail.slice(0, 4).map((t) => ({ path: t.path, err: t.error || t.msg })) });

  // Aggregate fallbacks by category to avoid the 80-line wall the user saw.
  const fbByCat = new Map();
  for (const fb of fallbacks) {
    const cat = fb.category || 'misc';
    if (!fbByCat.has(cat)) fbByCat.set(cat, { count: 0, sample: fb });
    fbByCat.get(cat).count++;
  }
  for (const [cat, info] of fbByCat) {
    pssLogStep('wrong', `fallback (${cat}) ×${info.count}: ${info.sample.msg || ''}`, info.sample);
  }

  // Real errors — but skip the duplicate console.warn relays from fallbacks
  // (we already represented those above).
  const realErrors = errors.filter((e) => !/^\[console\.warn\]\s+\[PSS Debug\]\s+\[fallback\]/.test(e.msg || ''));
  for (const e of realErrors.slice(0, 20)) {
    pssLogStep('wrong', `error: ${e.msg || JSON.stringify(e)}`, e);
  }
  if (realErrors.length > 20) {
    pssLogStep('wrong', `… +${realErrors.length - 20} more error entries omitted`, null);
  }
}

async function initPssOnlyMode() {
  const btBar = document.getElementById('body-type-bar');
  if (btBar) btBar.style.display = 'none';
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) throw new Error('#sidebar missing on pss.html');

  sidebar.innerHTML = `
    <div class="body-type-bar" id="body-type-bar" style="display:none;"></div>
    <div class="sidebar-tabs">
      <button class="sidebar-tab active" type="button">PSS Files <span class="tab-badge" id="pss-list-badge">0</span></button>
    </div>
    <div class="tab-content" id="tab-pss-list">
      <input type="text" class="search-box" id="pss-search" placeholder="Search PSS by name..." value="龙牙">
      <div class="pagination" id="pss-pagination" style="font-size:11px;color:#8ea2ba;padding:4px 8px;"></div>
      <ul class="item-list" id="pss-list"></ul>
    </div>
  `;

  pssLogInstallPanel();

  if (typeof vpLabel !== 'undefined' && vpLabel) {
    vpLabel.textContent = 'No PSS loaded';
  }
  statusConnection.textContent = 'Connected (PSS-only)';
  statusConnection.className = 'status-item status-ok';
  if (typeof statusBodyType !== 'undefined' && statusBodyType) statusBodyType.textContent = 'mode: pss-only';

  const searchEl = document.getElementById('pss-search');
  const listEl = document.getElementById('pss-list');
  const badgeEl = document.getElementById('pss-list-badge');
  const pagEl = document.getElementById('pss-pagination');

  let activeListItem = null;

  async function refreshList() {
    const q = (searchEl.value || '').trim();
    pagEl.textContent = 'Loading…';
    const t0 = performance.now();
    try {
      const data = await fetchJson(`/api/pss/find?q=${encodeURIComponent(q)}&limit=300`);
      const dur = Math.round(performance.now() - t0);
      if ((searchEl.value || '').trim() !== q) return;
      const items = (data && data.items) || [];
      badgeEl.textContent = String(items.length);
      pagEl.textContent = items.length
        ? `${items.length} match${items.length === 1 ? '' : 'es'} · ${dur}ms`
        : `No matches · ${dur}ms`;
      listEl.innerHTML = '';
      activeListItem = null;
      for (const it of items) {
        const li = document.createElement('li');
        li.className = 'item';
        li.dataset.sourcePath = it.sourcePath;
        const nameNoExt = it.fileName.replace(/\.pss$/i, '');
        li.innerHTML = `<div class="item-name" title="${escapeHtml(it.sourcePath)}">${escapeHtml(nameNoExt)}</div>`;
        li.addEventListener('click', () => {
          if (activeListItem) activeListItem.classList.remove('active');
          li.classList.add('active');
          activeListItem = li;
          loadOnePss(it.sourcePath).catch((err) => {
            pssLogStep('wrong', `loadOnePss exception: ${err.message}`, { stack: err.stack });
          });
        });
        listEl.appendChild(li);
      }
    } catch (err) {
      pagEl.textContent = `Error: ${err.message}`;
      badgeEl.textContent = '0';
    }
  }

  // Loading is serialized: every click bumps the global generation. The
  // earlier in-flight loads still finish their probe phase (free, since
  // analyze + debug-dump are server-cached) but bail out before they
  // would mutate scene/global state. Without this guard, three clicks in
  // 50 ms produce three concurrent clearEffect/addPssEffect cycles that
  // race and leave the scene empty.
  async function loadOnePss(sourcePath) {
    const myGen = ++__pssCurrentLoadGen;
    pssLogReset();
    pssLogStep('info', `click → load ${extractFileName(sourcePath)}`, { sourcePath, gen: myGen });
    setAnimationPlayerStatus('loading');

    // Probe phase (read-only, doesn't touch scene state). Run in
    // parallel — both endpoints are cached after the first call.
    const tProbe = performance.now();
    const probes = await Promise.allSettled([
      fetchJson(`/api/pss/analyze?sourcePath=${encodeURIComponent(sourcePath)}`),
      fetchJson(`/api/pss/debug-dump?sourcePath=${encodeURIComponent(sourcePath)}`),
    ]);
    const probeMs = Math.round(performance.now() - tProbe);
    if (probes[0].status === 'fulfilled') {
      pssLogStep('right', `/api/pss/analyze ok`,
        { emitters: (probes[0].value?.emitters?.length) || 0, ms: probeMs });
    } else {
      pssLogStep('wrong', `/api/pss/analyze failed: ${probes[0].reason?.message}`, null);
    }
    if (probes[1].status === 'fulfilled') {
      pssLogStep('right', `/api/pss/debug-dump ok`,
        { blocks: (probes[1].value?.blocks?.length) || 0, ms: probeMs });
    } else {
      pssLogStep('wrong', `/api/pss/debug-dump failed: ${probes[1].reason?.message}`, null);
    }

    // Cancellation point: if a newer click happened while we were
    // fetching, abandon now — DO NOT touch scene state.
    if (myGen !== __pssCurrentLoadGen) {
      pssLogStep('info', `cancelled (gen ${myGen} superseded by ${__pssCurrentLoadGen})`, null);
      return;
    }

    // Commit phase — only the latest generation reaches here.
    clearEffect();
    resetDebugState();
    pssDebugState.sourcePath = sourcePath;
    pssDebugState.loadedAt = new Date().toISOString();
    if (viewportOverlay) viewportOverlay.classList.add('hidden');
    if (vpLabel) vpLabel.textContent = extractFileName(sourcePath);

    const tA = performance.now();
    await preparePlayerAnchorRigForEffect([sourcePath]);
    if (myGen !== __pssCurrentLoadGen) {
      pssLogStep('info', `cancelled after prepareRig (gen ${myGen})`, null);
      return;
    }
    pssLogStep('info', `preparePlayerAnchorRigForEffect ${Math.round(performance.now() - tA)}ms`, null);

    const tB = performance.now();
    const effectWindow = await addPssEffect(sourcePath, 0);
    const dB = Math.round(performance.now() - tB);
    if (myGen !== __pssCurrentLoadGen) {
      // Newer click won the race during addPssEffect. addPssEffect
      // already mutated scene state; the newer load's clearEffect will
      // wipe it. We just bail without confusing the log.
      pssLogStep('info', `cancelled after addPssEffect (gen ${myGen})`, null);
      return;
    }
    if (!effectWindow) {
      pssLogStep('wrong', `addPssEffect returned null after ${dB}ms`, null);
      pssLogIngestDebugState();
      if (viewportOverlay) {
        viewportOverlay.classList.remove('hidden');
        const empty = viewportOverlay.querySelector('.empty-msg');
        if (empty) empty.textContent = 'PSS load failed — see Things went wrong';
      }
      statusRenderer.textContent = 'Renderer: load failed';
      setAnimationPlayerStatus('error', 'pss-load-failed');
      return;
    }
    pssLogStep('right', `addPssEffect ${dB}ms — ${spriteEmitters.length}S ${meshObjects.length}M ${trackLines.length}T`,
      { sprite: spriteEmitters.length, mesh: meshObjects.length, track: trackLines.length });

    pssLogIngestDebugState();

    timelineTotalMs = effectWindow.endTimeMs;
    timelineMs = 0;
    timelinePlaying = true;
    timelineLastClockSec = null;
    timelinePssEntries = [{ path: sourcePath, startTimeMs: 0, effectiveStartTimeMs: 0 }];
    if (timelineBar) timelineBar.classList.remove('hidden');
    statusRenderer.textContent = `Renderer: ${spriteEmitters.length}S ${meshObjects.length}M ${trackLines.length}T | ${(timelineTotalMs / 1000).toFixed(2)}s`;
    setAnimationPlayerStatus('ready');
    pssLogStep('right', `scene ready · timeline ${(timelineTotalMs / 1000).toFixed(2)}s`, null);
  }

  let searchTimer = null;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refreshList, 180);
  });
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimer);
      refreshList();
    }
  });

  await refreshList();

  const firstItem = listEl.querySelector('li.item');
  if (firstItem) {
    firstItem.click();
  }

  // Honour ?pss=<path>. We DO NOT also auto-click the first item if a
  // ?pss param is present — that was producing two concurrent loads.
  try {
    const params = new URLSearchParams(location.search);
    const explicit = params.get('pss');
    if (explicit) {
      await loadOnePss(explicit);
    }
  } catch {}
}

