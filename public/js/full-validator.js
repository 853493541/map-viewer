class FullExportValidator {
  constructor() {
    this.packageSelect = document.getElementById('package-select');
    this.statusEl = document.getElementById('status');
    this.summaryEl = document.getElementById('summary');
    this.reportEl = document.getElementById('report');
    this.downloadBtn = document.getElementById('download-report');
    this.lastReport = null;
  }

  async init() {
    document.getElementById('refresh-packages').addEventListener('click', () => this.refreshPackages());
    document.getElementById('validate-package').addEventListener('click', () => this.validateSelected());
    document.getElementById('open-viewer').addEventListener('click', () => this.openFullViewer());
    this.downloadBtn.addEventListener('click', () => this.downloadReport());

    await this.refreshPackages();

    const q = new URLSearchParams(window.location.search);
    const pkg = q.get('pkg');
    if (pkg) {
      this.packageSelect.value = pkg;
      if (this.packageSelect.value === pkg) {
        await this.validatePackage(pkg);
      }
    }
  }

  setStatus(text, cls = '') {
    this.statusEl.textContent = text;
    this.statusEl.className = cls;
  }

  async fetchJson(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed ${path} (${res.status})`);
    return res.json();
  }

  async tryFetchJson(path) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async pathExists(path) {
    try {
      const res = await fetch(path, { method: 'HEAD', cache: 'no-store' });
      return res.ok;
    } catch {
      return false;
    }
  }

  normalizeGlbName(name) {
    let n = String(name || '').trim();
    if (!n) return null;
    n = n.replace(/^meshes\//i, '').replace(/^\.\//, '');
    if (!n.toLowerCase().endsWith('.glb')) n += '.glb';
    return n;
  }

  collectTextureNames(entry) {
    const set = new Set();
    if (!entry || typeof entry !== 'object') return set;

    const add = (v) => {
      if (typeof v === 'string' && v.trim()) set.add(v.trim());
    };

    add(entry.albedo);
    add(entry.mre);
    add(entry.normal);

    if (Array.isArray(entry.subsets)) {
      for (const s of entry.subsets) {
        add(s?.albedo);
        add(s?.mre);
        add(s?.normal);
      }
    }

    return set;
  }

  pad3(n) {
    return String(n).padStart(3, '0');
  }

  createSection(title, html) {
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `<h2 class="section-title">${title}</h2>${html}`;
    return panel;
  }

  renderList(items, cssClass = '') {
    if (!items || items.length === 0) return '<div class="empty">None</div>';
    const max = 200;
    const sliced = items.slice(0, max);
    const rows = sliced.map((x) => `<li>${this.escapeHtml(String(x))}</li>`).join('');
    const more = items.length > max ? `<li>... ${items.length - max} more</li>` : '';
    return `<ul class="list ${cssClass}">${rows}${more}</ul>`;
  }

  escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async mapWithLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;

    const worker = async () => {
      while (true) {
        const idx = i;
        i += 1;
        if (idx >= items.length) break;
        out[idx] = await fn(items[idx], idx);
      }
    };

    const workers = [];
    const count = Math.max(1, Math.min(limit, items.length || 1));
    for (let w = 0; w < count; w++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  async refreshPackages() {
    this.setStatus('Fetching Desktop exports...');
    const prev = this.packageSelect.value;
    this.packageSelect.innerHTML = '';

    try {
      const data = await this.fetchJson('/api/full-exports');
      const list = Array.isArray(data?.exports) ? data.exports : [];

      if (list.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No Desktop full exports found';
        this.packageSelect.appendChild(opt);
        this.setStatus('No exports found', 'warn');
        return;
      }

      for (const item of list) {
        const opt = document.createElement('option');
        opt.value = item.packageName;
        const created = item.createdAt ? new Date(item.createdAt).toLocaleString() : 'unknown time';
        const entities = item.stats?.entities ?? '?';
        opt.textContent = `${item.packageName} | ${entities} entities | ${created}`;
        this.packageSelect.appendChild(opt);
      }

      if (prev && list.some((x) => x.packageName === prev)) this.packageSelect.value = prev;
      this.setStatus(`Found ${list.length} export packages`, 'ok');
    } catch (err) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Failed to load export list';
      this.packageSelect.appendChild(opt);
      this.setStatus(`Error: ${err.message || err}`, 'bad');
    }
  }

  openFullViewer() {
    const pkg = this.packageSelect.value;
    if (!pkg) return;
    const win = window.open(`/full-viewer.html?pkg=${encodeURIComponent(pkg)}`, '_blank');
    if (!win) this.setStatus('Popup blocked while opening full viewer', 'warn');
  }

  downloadReport() {
    if (!this.lastReport) return;
    const blob = new Blob([JSON.stringify(this.lastReport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.lastReport.packageName}-validator-report.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async validateSelected() {
    const pkg = this.packageSelect.value;
    if (!pkg) return;
    await this.validatePackage(pkg);
  }

  async validatePackage(pkgName) {
    const startedAt = Date.now();
    const packageBase = `/full-exports/${encodeURIComponent(pkgName)}`;
    const dataBase = `${packageBase}/map-data`;

    this.summaryEl.textContent = 'Validating package...';
    this.reportEl.innerHTML = '';
    this.downloadBtn.disabled = true;
    this.setStatus(`Validating ${pkgName}...`);

    const report = {
      kind: 'jx3-full-export-validator-report',
      version: 1,
      packageName: pkgName,
      createdAt: Date.now(),
      durationMs: 0,
      ok: false,
      requiredMissing: [],
      optionalMissing: [],
      missingMeshes: [],
      missingTextures: [],
      missingHeightmaps: [],
      missingTerrainTextures: [],
      warnings: [],
      stats: {},
    };

    const requiredCore = [
      `${packageBase}/manifest.json`,
      `${dataBase}/map-config.json`,
      `${dataBase}/entity-index.json`,
      `${dataBase}/mesh-map.json`,
      `${dataBase}/mesh-list.json`,
      `${dataBase}/entities/full.json`,
    ];

    const optionalCore = [
      `${dataBase}/environment.json`,
      `${dataBase}/texture-map.json`,
      `${dataBase}/verdicts.json`,
      `${dataBase}/terrain-textures/index.json`,
      `${dataBase}/minimap.png`,
    ];

    const requiredExists = await this.mapWithLimit(requiredCore, 12, async (p) => ({ path: p, ok: await this.pathExists(p) }));
    report.requiredMissing = requiredExists.filter((x) => !x.ok).map((x) => x.path);

    const optionalExists = await this.mapWithLimit(optionalCore, 12, async (p) => ({ path: p, ok: await this.pathExists(p) }));
    report.optionalMissing = optionalExists.filter((x) => !x.ok).map((x) => x.path);

    const manifest = await this.tryFetchJson(`${packageBase}/manifest.json`);
    const mapConfig = await this.tryFetchJson(`${dataBase}/map-config.json`);
    const entityIndex = await this.tryFetchJson(`${dataBase}/entity-index.json`);
    const meshMap = await this.tryFetchJson(`${dataBase}/mesh-map.json`);
    const meshList = await this.tryFetchJson(`${dataBase}/mesh-list.json`);
    const textureMap = await this.tryFetchJson(`${dataBase}/texture-map.json`);
    const terrainIndex = await this.tryFetchJson(`${dataBase}/terrain-textures/index.json`);

    const entityFiles = Array.isArray(entityIndex) ? entityIndex : [];
    const allEntities = [];
    const missingEntityFiles = [];

    for (const f of entityFiles) {
      const p = `${dataBase}/entities/${encodeURIComponent(f)}`;
      const json = await this.tryFetchJson(p);
      if (!json) {
        missingEntityFiles.push(f);
        continue;
      }
      if (Array.isArray(json)) allEntities.push(...json);
    }

    if (missingEntityFiles.length > 0) {
      report.requiredMissing.push(...missingEntityFiles.map((f) => `${dataBase}/entities/${f}`));
    }

    const meshRefs = new Set();

    for (const ent of allEntities) {
      const m = this.normalizeGlbName(ent?.mesh);
      if (m) meshRefs.add(m);
    }

    if (Array.isArray(meshList)) {
      for (const m of meshList) {
        const n = this.normalizeGlbName(String(m || '').split('/').pop());
        if (n) meshRefs.add(n);
      }
    }

    if (meshMap && typeof meshMap === 'object') {
      for (const [k, v] of Object.entries(meshMap)) {
        const nk = this.normalizeGlbName(String(k || '').split('/').pop());
        if (nk) meshRefs.add(nk);
        const nv = this.normalizeGlbName(String(v || '').split('/').pop());
        if (nv) meshRefs.add(nv);
      }
    }

    const meshRefArr = [...meshRefs].sort();
    const meshExists = await this.mapWithLimit(meshRefArr, 20, async (name) => {
      const p = `${dataBase}/meshes/${encodeURIComponent(name)}`;
      return { name, ok: await this.pathExists(p) };
    });
    report.missingMeshes = meshExists.filter((x) => !x.ok).map((x) => x.name);

    const meshMapKeys = new Set();
    if (meshMap && typeof meshMap === 'object') {
      for (const k of Object.keys(meshMap)) {
        const n = this.normalizeGlbName(String(k || '').split('/').pop());
        if (n) meshMapKeys.add(n.toLowerCase());
      }
    }

    const entityMeshNotInMap = [];
    for (const ent of allEntities) {
      const m = this.normalizeGlbName(ent?.mesh);
      if (!m) continue;
      if (!meshMapKeys.has(m.toLowerCase())) entityMeshNotInMap.push(m);
    }

    if (entityMeshNotInMap.length > 0) {
      const uniq = [...new Set(entityMeshNotInMap)].sort();
      report.warnings.push(`Entity meshes missing mesh-map key: ${uniq.length}`);
      report.warnings.push(...uniq.slice(0, 50).map((x) => `mesh-map missing key: ${x}`));
    }

    const textureRefs = new Set();
    if (textureMap && typeof textureMap === 'object') {
      for (const v of Object.values(textureMap)) {
        for (const t of this.collectTextureNames(v)) textureRefs.add(t);
      }
    }

    const textureRefArr = [...textureRefs].sort();
    const textureExists = await this.mapWithLimit(textureRefArr, 20, async (name) => {
      const p = `${dataBase}/textures/${encodeURIComponent(name)}`;
      return { name, ok: await this.pathExists(p) };
    });
    report.missingTextures = textureExists.filter((x) => !x.ok).map((x) => x.name);

    const heightmapExpected = [];
    const terrainTextureRefs = new Set();

    if (terrainIndex?.regions && mapConfig?.name) {
      for (const [k, info] of Object.entries(terrainIndex.regions)) {
        const parts = String(k).split('_').map((n) => Number(n));
        if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) continue;
        const fname = `${mapConfig.name}_${this.pad3(parts[0])}_${this.pad3(parts[1])}.bin`;
        heightmapExpected.push(fname);

        if (typeof info?.color === 'string' && info.color.trim()) terrainTextureRefs.add(info.color.trim());
        if (typeof info?.detail === 'string' && info.detail.trim()) terrainTextureRefs.add(info.detail.trim());
      }
    }

    const heightmapExists = await this.mapWithLimit(heightmapExpected, 20, async (name) => {
      const p = `${dataBase}/heightmap/${encodeURIComponent(name)}`;
      return { name, ok: await this.pathExists(p) };
    });
    report.missingHeightmaps = heightmapExists.filter((x) => !x.ok).map((x) => x.name);

    const terrainTexArr = [...terrainTextureRefs].sort();
    const terrainTexExists = await this.mapWithLimit(terrainTexArr, 20, async (name) => {
      const p = `${dataBase}/terrain-textures/${encodeURIComponent(name)}`;
      return { name, ok: await this.pathExists(p) };
    });
    report.missingTerrainTextures = terrainTexExists.filter((x) => !x.ok).map((x) => x.name);

    report.stats = {
      entities: allEntities.length,
      entityFiles: entityFiles.length,
      uniqueMeshRefs: meshRefArr.length,
      uniqueTextureRefs: textureRefArr.length,
      expectedHeightmaps: heightmapExpected.length,
      expectedTerrainTextures: terrainTexArr.length,
      manifestEntities: Number(manifest?.stats?.entities) || null,
      manifestMeshesCopied: Number(manifest?.stats?.meshesCopied) || null,
      manifestTexturesCopied: Number(manifest?.stats?.texturesCopied) || null,
      manifestHeightmapsCopied: Number(manifest?.stats?.heightmapsCopied) || null,
    };

    const hardFailCount =
      report.requiredMissing.length +
      report.missingMeshes.length +
      report.missingTextures.length +
      report.missingHeightmaps.length +
      report.missingTerrainTextures.length;

    report.ok = hardFailCount === 0;
    report.durationMs = Date.now() - startedAt;

    this.lastReport = report;
    this.downloadBtn.disabled = false;

    this.renderReport(report);

    if (report.ok) {
      this.setStatus(`Validation passed in ${report.durationMs}ms`, 'ok');
    } else {
      this.setStatus(`Validation found ${hardFailCount} issues`, 'bad');
    }
  }

  renderReport(report) {
    const hardIssues =
      report.requiredMissing.length +
      report.missingMeshes.length +
      report.missingTextures.length +
      report.missingHeightmaps.length +
      report.missingTerrainTextures.length;

    const softIssues = report.optionalMissing.length + report.warnings.length;

    this.summaryEl.innerHTML = `
      <div><strong>Package:</strong> ${this.escapeHtml(report.packageName)}</div>
      <div><strong>Result:</strong> <span class="${report.ok ? 'ok' : 'bad'}">${report.ok ? 'PASS' : 'FAIL'}</span></div>
      <div><strong>Hard Issues:</strong> <span class="${hardIssues === 0 ? 'ok' : 'bad'}">${hardIssues}</span></div>
      <div><strong>Soft Issues:</strong> <span class="${softIssues === 0 ? 'ok' : 'warn'}">${softIssues}</span></div>
      <div><strong>Checked In:</strong> ${report.durationMs} ms</div>
    `;

    this.reportEl.innerHTML = '';

    this.reportEl.appendChild(this.createSection('Stats', `
      <div class="kv">
        <div>Entities</div><div>${report.stats.entities}</div>
        <div>Entity Files</div><div>${report.stats.entityFiles}</div>
        <div>Mesh Refs</div><div>${report.stats.uniqueMeshRefs}</div>
        <div>Texture Refs</div><div>${report.stats.uniqueTextureRefs}</div>
        <div>Expected Heightmaps</div><div>${report.stats.expectedHeightmaps}</div>
        <div>Expected Terrain Textures</div><div>${report.stats.expectedTerrainTextures}</div>
      </div>
    `));

    this.reportEl.appendChild(this.createSection('Missing Required Core Files', this.renderList(report.requiredMissing, 'bad')));
    this.reportEl.appendChild(this.createSection('Missing Optional Core Files', this.renderList(report.optionalMissing, 'warn')));
    this.reportEl.appendChild(this.createSection('Missing Mesh Files', this.renderList(report.missingMeshes, 'bad')));
    this.reportEl.appendChild(this.createSection('Missing Texture Files', this.renderList(report.missingTextures, 'bad')));
    this.reportEl.appendChild(this.createSection('Missing Heightmaps', this.renderList(report.missingHeightmaps, 'bad')));
    this.reportEl.appendChild(this.createSection('Missing Terrain Textures', this.renderList(report.missingTerrainTextures, 'bad')));
    this.reportEl.appendChild(this.createSection('Warnings', this.renderList(report.warnings, 'warn')));
  }
}

const validator = new FullExportValidator();
validator.init().catch((err) => {
  const el = document.getElementById('summary');
  if (el) el.textContent = `Validator init failed: ${err.message || err}`;
});
