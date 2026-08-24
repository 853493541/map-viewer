/**
 * Data module for the positioning map: world bounds + CSV loaders.
 * World bounds derived from public/map-data/map-config.json (龙门寻宝).
 */
export const WORLD = {
  // Playable area from the game's own Setting.ini:
  // [LogicalScene] X_Start=0 Z_Start=0 X_Width=2048 Z_Width=2048
  // 2048 cells x 100 units/cell = 204800 units per axis.
  // The map is the inner 4x4 playable regions (16 regions) of the 8x8 grid;
  // outer edge regions are excluded.
  minX: 0,
  maxX: 204800,
  minZ: 0,
  maxZ: 204800,
  get spanX() { return this.maxX - this.minX; },
  get spanZ() { return this.maxZ - this.minZ; },
};

export const LAYERS = [
  ['entities', 'map-data/positions/Entities.csv', (r) => ({
    x: Number(r.PosX), y: Number(r.PosY), z: Number(r.PosZ),
    name: r.Name, template: r.Template, mesh: r.Mesh,
  })],
  ['npcs', 'map-data/positions/NPCs.csv', (r) => {
    const [x, y, z] = String(r.Position).split(',').map(Number);
    return { x, y, z, nickname: r.Nickname, templateID: r.TemplateID };
  }],
  ['containers', 'map-data/positions/Containers.csv', (r) => ({
    x: Number(r.PosX), y: Number(r.PosY), z: Number(r.PosZ),
    name: r.Name, template: r.Template, mesh: r.Mesh,
  })],
  ['doodads', 'map-data/positions/Doodads.csv', (r) => {
    const [x, y, z] = String(r.Position).split(',').map(Number);
    return { x, y, z, nickname: r.Nickname, templateID: r.TemplateID, kind: r.Kind };
  }],
  ['doodadpos', 'map-data/positions/DoodadPositions.csv', (r) => {
    const [x, y, z] = String(r.Position).split(',').map(Number);
    return { x, y, z, nickname: r.Nickname, templateID: r.TemplateID, kind: r.Kind };
  }],
];

// Game .tab lookup tables (UTF-8 conversions from the client's represent
// tables): RepresentID -> display name. First table wins on duplicate IDs.
export const NAME_TABLE_FILES = [
  'map-data/positions/tab-lookups/longmenhuangmo.tab.utf8.txt',
  'map-data/positions/tab-lookups/wabao.tab.utf8.txt',
  'map-data/positions/tab-lookups/xunbaoxitong.tab.utf8.txt',
  'map-data/positions/tab-lookups/xunyangNPC.tab.utf8.txt',
];

export function parseTsv(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].replace(/^\uFEFF/, '').split('\t').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split('\t');
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = (cols[c] ?? '').trim();
    return row;
  });
}

export async function loadTabLookups() {
  const byId = new Map();
  for (const file of NAME_TABLE_FILES) {
    try {
      const res = await fetch(file);
      if (!res.ok) {
        console.warn(`Lookup ${file} -> HTTP ${res.status}`);
        continue;
      }
      for (const row of parseTsv(await res.text())) {
        const id = String(row.RepresentID ?? '');
        const name = String(row.Name ?? '');
        if (id && name && !byId.has(id)) byId.set(id, name);
      }
    } catch (err) {
      console.warn(`Failed to load lookup ${file}:`, err);
    }
  }
  return byId;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  if (!rows.length) return [];
  const header = rows[0].map((h) => h.replace(/^\uFEFF/, '').trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = r[c];
    return obj;
  });
}

export async function loadCsv(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const text = await res.text();
  return parseCsv(text);
}
