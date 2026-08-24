/**
 * JX3 Positioning Map — 龙门寻宝
 * 2D top-down positioning viewer. Loads world-coordinate CSV dumps
 * (Entities / NPCs / Containers / Doodads) and renders them as color-coded,
 * toggleable point layers over the map image. Includes a manual Mark mode.
 *
 * Coordinate system (source LH world, matching map-config.json):
 *   minX = worldOriginX = -102400
 *   maxX = worldOriginX + regionGridX * regionSize * unitScaleX = 307200
 *   Z (LH) spans the same range; canvas top = max LH Z (matches 3D scene orientation)
 */
import { WORLD, LAYERS, loadCsv, parseCsv, loadTabLookups } from './position-map-data.js';

const canvas = document.getElementById('map-canvas');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('map-wrap');
const tooltip = document.getElementById('tooltip');
const coordsEl = document.getElementById('coords');

// ─── View state ─────────────────────────────────────
const view = { scale: 1, offsetX: 0, offsetY: 0 };
let mapImage = null;      // loaded map.png (fallback: white placeholder)
let mapImageSize = { w: WORLD.spanX, h: WORLD.spanZ };

const state = {
  layers: {
    entities: { visible: true, color: '#4aa3ff', points: [] },
    npcs: { visible: true, color: '#ff4a4a', points: [] },
    containers: { visible: true, color: '#ffd24a', points: [] },
    doodads: { visible: true, color: '#4aff7c', points: [] },
    doodadpos: { visible: true, color: '#c04aff', points: [] },
  },
  marks: [],   // user marks: { id, x, z, name, time }
  mode: 'pan', // 'pan' | 'mark'
  hoverPoint: null,
  selectedInfo: null,
};

// ─── Coordinate helpers ─────────────────────────────
function worldToCanvas(wx, wz) {
  const sx = mapImageSize.w / WORLD.spanX;
  const sy = mapImageSize.h / WORLD.spanZ;
  const cx = (wx - WORLD.minX) * sx;
  const cy = (WORLD.maxZ - wz) * sy; // top of map = max LH Z
  return { x: cx * view.scale + view.offsetX, y: cy * view.scale + view.offsetY };
}

function canvasToWorld(cx, cy) {
  const sx = mapImageSize.w / WORLD.spanX;
  const sy = mapImageSize.h / WORLD.spanZ;
  const mx = (cx - view.offsetX) / view.scale;
  const my = (cy - view.offsetY) / view.scale;
  return { x: mx / sx + WORLD.minX, z: WORLD.maxZ - my / sy };
}

// ─── Rendering ──────────────────────────────────────
function render() {
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Map image (white placeholder if none)
  if (mapImage) {
    ctx.drawImage(mapImage, view.offsetX, view.offsetY,
      mapImageSize.w * view.scale, mapImageSize.h * view.scale);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(view.offsetX, view.offsetY,
      mapImageSize.w * view.scale, mapImageSize.h * view.scale);
    ctx.fillStyle = '#d9d9d9';
    ctx.fillRect(view.offsetX, view.offsetY, mapImageSize.w * view.scale,
      Math.min(40 * view.scale, mapImageSize.h * view.scale));
    ctx.fillStyle = '#888';
    ctx.font = `${Math.max(12, 16 * view.scale)}px sans-serif`;
    ctx.fillText('MAP PLACEHOLDER — drop map.png into public/map-data/positions/', view.offsetX + 10 * view.scale, view.offsetY + 28 * view.scale);
  }

  // Layer points
  const dotR = 3;
  for (const key of Object.keys(state.layers)) {
    const layer = state.layers[key];
    if (!layer.visible) continue;
    if (key === 'doodadpos') {
      ctx.strokeStyle = layer.color;
      ctx.lineWidth = 1.5;
      for (const p of layer.points) {
        const c = worldToCanvas(p.x, p.z);
        if (c.x < -10 || c.y < -10 || c.x > canvas.width + 10 || c.y > canvas.height + 10) continue;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 5.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      continue;
    }
    ctx.fillStyle = layer.color;
    for (const p of layer.points) {
      const c = worldToCanvas(p.x, p.z);
      if (c.x < -10 || c.y < -10 || c.x > canvas.width + 10 || c.y > canvas.height + 10) continue;
      ctx.beginPath();
      ctx.arc(c.x, c.y, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Marks
  if (document.getElementById('ly-marks').checked) {
    for (const m of state.marks) {
      const c = worldToCanvas(m.x, m.z);
      ctx.fillStyle = '#ff8800';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ff8800';
      ctx.font = '11px sans-serif';
      ctx.fillText(m.name, c.x + 9, c.y - 7);
    }
  }

  // Hover highlight
  if (state.hoverPoint) {
    const c = worldToCanvas(state.hoverPoint.x, state.hoverPoint.z);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 7, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function pickPoint(mx, my, radiusPx = 8) {
  let best = null;
  let bestDist = radiusPx;
  const consider = (points) => {
    for (const p of points) {
      const c = worldToCanvas(p.x, p.z);
      const d = Math.hypot(c.x - mx, c.y - my);
      if (d < bestDist) { bestDist = d; best = p; }
    }
  };
  for (const key of Object.keys(state.layers)) {
    const layer = state.layers[key];
    if (!layer.visible) continue;
    consider(layer.points);
  }
  return best;
}

// ─── Tooltip ────────────────────────────────────────
function showTooltip(p, clientX, clientY) {
  tooltip.style.display = 'block';
  const lines = [];
  const title = p.resolvedName || p.nickname || p.name;
  if (title) lines.push(`<div class="t-name">${escapeHtml(title)}</div>`);
  if (p.resolvedName && p.nickname && p.nickname !== p.resolvedName) {
    lines.push(`<div class="t-row">Nickname: ${escapeHtml(p.nickname)}</div>`);
  }
  if (p.templateID || p.template) lines.push(`<div class="t-row">Template: ${escapeHtml(String(p.templateID || p.template))}</div>`);
  if (p.mesh) lines.push(`<div class="t-row">Mesh: ${escapeHtml(p.mesh)}</div>`);
  lines.push(`<div class="t-row">X: ${p.x.toFixed(1)}</div>`);
  lines.push(`<div class="t-row">Y: ${p.y.toFixed(1)}</div>`);
  lines.push(`<div class="t-row">Z: ${p.z.toFixed(1)}</div>`);
  tooltip.innerHTML = lines.join('');
  const rect = wrap.getBoundingClientRect();
  let tx = clientX - rect.left + 14;
  let ty = clientY - rect.top + 14;
  if (tx + 350 > rect.width) tx = clientX - rect.left - 355;
  if (ty + tooltip.offsetHeight > rect.height) ty = clientY - rect.top - tooltip.offsetHeight - 12;
  tooltip.style.left = `${tx}px`;
  tooltip.style.top = `${ty}px`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ─── Marks ──────────────────────────────────────────
function loadMarks() {
  try { state.marks = JSON.parse(localStorage.getItem('jx3-posmap-marks') || '[]'); }
  catch { state.marks = []; }
}

function saveMarks() {
  localStorage.setItem('jx3-posmap-marks', JSON.stringify(state.marks));
  renderMarkList();
}

function addMark(x, z) {
  const name = prompt('Mark name:', `Mark ${state.marks.length + 1}`);
  if (name === null) return;
  state.marks.push({ id: Date.now(), x, z, name: name || `Mark ${state.marks.length + 1}`, time: Date.now() });
  saveMarks();
}

function renderMarkList() {
  const list = document.getElementById('mark-list');
  const count = document.getElementById('c-marks');
  count.textContent = `(${state.marks.length})`;
  if (!state.marks.length) {
    list.innerHTML = '<div id="mark-empty">No marks yet. Switch to Mark mode and click the map.</div>';
    return;
  }
  list.innerHTML = '';
  for (const m of state.marks) {
    const row = document.createElement('div');
    row.className = 'mark-row';
    row.innerHTML = `
      <span class="m-name">${escapeHtml(m.name)}</span>
      <span class="m-pos">${m.x.toFixed(0)}, ${m.z.toFixed(0)}</span>
      <button title="Delete">✕</button>
    `;
    row.querySelector('button').addEventListener('click', () => {
      state.marks = state.marks.filter((mm) => mm.id !== m.id);
      saveMarks();
      render();
    });
    row.addEventListener('dblclick', () => {
      const c = worldToCanvas(m.x, m.z);
      view.offsetX = canvas.width / 2 - c.x;
      view.offsetY = canvas.height / 2 - c.y;
      render();
    });
    list.appendChild(row);
  }
}

// ─── Input handling ─────────────────────────────────
let dragging = false;
let lastX = 0, lastY = 0;

wrap.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = wrap.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newScale = Math.min(40, Math.max(0.05, view.scale * factor));
  view.offsetX = mx - (mx - view.offsetX) * (newScale / view.scale);
  view.offsetY = my - (my - view.offsetY) * (newScale / view.scale);
  view.scale = newScale;
  render();
}, { passive: false });

wrap.addEventListener('mousedown', (e) => {
  const rect = wrap.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  if (state.mode === 'mark') {
    const w = canvasToWorld(mx, my);
    addMark(w.x, w.z);
    render();
    return;
  }

  const p = pickPoint(mx, my);
  if (p) {
    showTooltip(p, e.clientX, e.clientY);
    return;
  }
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  wrap.style.cursor = 'grabbing';
});

window.addEventListener('mousemove', (e) => {
  const rect = wrap.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const w = canvasToWorld(mx, my);
  coordsEl.textContent = `X: ${w.x.toFixed(1)}  Z: ${w.z.toFixed(1)}`;

  if (dragging) {
    view.offsetX += e.clientX - lastX;
    view.offsetY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    render();
    return;
  }

  if (state.mode === 'pan') {
    const p = pickPoint(mx, my);
    if (p) {
      wrap.style.cursor = 'pointer';
      state.hoverPoint = p;
      showTooltip(p, e.clientX, e.clientY);
      render();
    } else {
      if (state.hoverPoint) { state.hoverPoint = null; render(); }
      tooltip.style.display = 'none';
      wrap.style.cursor = dragging ? 'grabbing' : 'grab';
    }
  } else {
    tooltip.style.display = 'none';
    wrap.style.cursor = 'crosshair';
  }
});

window.addEventListener('mouseup', () => {
  dragging = false;
  wrap.style.cursor = state.mode === 'mark' ? 'crosshair' : 'grab';
});

wrap.addEventListener('mouseleave', () => {
  tooltip.style.display = 'none';
  if (state.hoverPoint) { state.hoverPoint = null; render(); }
});

// ─── Layer toggles ──────────────────────────────────
for (const [key, id] of [['entities', 'ly-entities'], ['npcs', 'ly-npcs'], ['containers', 'ly-containers'],
  ['doodads', 'ly-doodads'], ['doodadpos', 'ly-doodadpos']]) {
  document.getElementById(id).addEventListener('change', (e) => {
    state.layers[key].visible = e.target.checked;
    render();
  });
}
document.getElementById('ly-marks').addEventListener('change', () => render());

document.getElementById('mode-pan').addEventListener('click', () => setMode('pan'));
document.getElementById('mode-mark').addEventListener('click', () => setMode('mark'));
function setMode(mode) {
  state.mode = mode;
  document.getElementById('mode-pan').classList.toggle('active', mode === 'pan');
  document.getElementById('mode-mark').classList.toggle('active', mode === 'mark');
  wrap.style.cursor = mode === 'mark' ? 'crosshair' : 'grab';
  tooltip.style.display = 'none';
  state.hoverPoint = null;
}

document.getElementById('clear-marks').addEventListener('click', () => {
  if (!confirm('Clear all marks?')) return;
  state.marks = [];
  saveMarks();
  render();
});

// ─── Boot ───────────────────────────────────────────
async function boot() {
  loadMarks();
  renderMarkList();

  const counts = {};
  for (const [key, file, mapFn] of LAYERS) {
    try {
      const rows = await loadCsv(file);
      state.layers[key].points = rows.map(mapFn)
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))
        .filter((p) => p.x >= WORLD.minX && p.x <= WORLD.maxX && p.z >= WORLD.minZ && p.z <= WORLD.maxZ);
      counts[key] = state.layers[key].points.length;
    } catch (err) {
      console.warn(`Failed to load ${file}:`, err);
      counts[key] = 0;
    }
    document.getElementById(`c-${key}`).textContent = `(${counts[key]})`;
  }

  // Resolve template IDs to display names from the game .tab lookup tables.
  const nameById = await loadTabLookups();
  let resolvedCount = 0;
  for (const key of ['npcs', 'doodads', 'doodadpos']) {
    for (const p of state.layers[key].points) {
      const id = String(p.templateID ?? '');
      if (id && nameById.has(id)) {
        p.resolvedName = nameById.get(id);
        resolvedCount += 1;
      }
    }
  }
  console.log(`position-map: ${nameById.size} tab names loaded, ${resolvedCount} points resolved`);

  // Try to load real map image; white placeholder otherwise
  mapImage = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // Crop the white title/legend bars (image content: y 26..872 of 1024x896)
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = 872 - 26;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 26, img.naturalWidth, 872 - 26, 0, 0, img.naturalWidth, 872 - 26);
      mapImageSize = { w: c.width, h: c.height };
      resolve(c);
    };
    img.onerror = () => resolve(null);
    img.src = 'map-data/positions/map.png';
  });
  // Fit map to viewport
  const rect = wrap.getBoundingClientRect();
  view.scale = Math.min(rect.width / mapImageSize.w, rect.height / mapImageSize.h);
  view.offsetX = (rect.width - mapImageSize.w * view.scale) / 2;
  view.offsetY = (rect.height - mapImageSize.h * view.scale) / 2;
  wrap.style.cursor = 'grab';

  render();
}

boot();
