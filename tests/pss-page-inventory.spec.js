// Per-emitter inventory diagnostic for the "white walls" investigation.
//
// For each loaded PSS we capture the actual rendering parameters that
// landed on the GPU — texture src, material color/opacity/blending,
// world bounding box size, particle counts, atlas state, authored size
// curve — and write a flat human-readable table to log/ so the user can
// see at a glance which emitters look wrong (no texture / white tint /
// collapsed size curve / etc).
//
// The invariants asserted here are intentionally weak: this is a
// diagnostic test, not a pass/fail oracle. The strong oracle lives in
// pss-page-oracle.spec.js. We DO hard-fail when no emitters are
// produced or every emitter is invisible at every sample time, since
// those are catastrophic regressions.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGETS = [
  'data/source/other/HD特效/技能/Pss/发招/L_龙王_龙牙烈风拳_红01.pss',
  'data/source/other/HD特效/技能/Pss/发招/L_龙王_龙牙烈风拳_红02.pss',
];

function fmtRow(cols, widths) {
  return cols.map((c, i) => String(c ?? '').padEnd(widths[i])).join(' | ');
}

function renderInventoryTable(inv) {
  const lines = [];
  lines.push(`# PSS emitter inventory`);
  lines.push(`counts: sprite=${inv.counts.sprite} mesh=${inv.counts.mesh} track=${inv.counts.track}`);
  lines.push(`timeline: t=${inv.timeline.timelineMs}ms / total=${inv.timeline.timelineTotalMs}ms`);
  lines.push('');
  // ── Sprite table ─────────────────────────────────────────────────────
  lines.push('## SPRITES');
  const sHead = ['idx', 'edIdx', 'vis', 'startMs', 'durMs', 'box(x,y,z)', 'parts', 'alive', 'layers', 'tex0', 'col0', 'blend0', 'opac0', 'flags'];
  const sW = [4, 5, 3, 7, 6, 26, 5, 5, 6, 28, 17, 8, 5, 28];
  lines.push(fmtRow(sHead, sW));
  lines.push('-'.repeat(sW.reduce((a, b) => a + b + 3, 0)));
  for (const s of inv.sprites) {
    const l0 = s.layers[0] || {};
    const flags = Object.entries(s.flags || {}).filter(([, v]) => v).map(([k]) => k).join(',') || '';
    lines.push(fmtRow([
      s.runtimeIndex,
      s.emitterDataIndex,
      s.visible ? 'Y' : 'n',
      s.startTimeMs,
      s.effectDurationMs,
      Array.isArray(s.worldBoxSize) ? s.worldBoxSize.join(',') : '-',
      s.particleCount,
      s.aliveParticles,
      s.layerCount,
      l0.texture ? (l0.texture.bound ? `${l0.texture.srcShort}(${l0.texture.w}x${l0.texture.h})` : 'NO-TEX') : '-',
      Array.isArray(l0.materialColor) ? l0.materialColor.map((v) => v.toFixed(2)).join(',') : '-',
      l0.blending,
      l0.materialOpacity != null ? Number(l0.materialOpacity).toFixed(2) : '-',
      flags,
    ], sW));
  }
  lines.push('');
  // ── Per-sprite layer detail ──────────────────────────────────────────
  lines.push('## SPRITE LAYER DETAIL');
  for (const s of inv.sprites) {
    lines.push(`sprite#${s.runtimeIndex} (edIdx=${s.emitterDataIndex}) layers=${s.layerCount} atlas=${s.atlas.cells} (${s.atlas.rows}x${s.atlas.cols}) authored: lifetime=${s.authoredLifetime} maxParticles=${s.authoredMaxParticles} sizeCurve=${JSON.stringify(s.authoredSizeCurve)} alphaCurve=${JSON.stringify(s.authoredAlphaCurve)}`);
    for (let li = 0; li < s.layers.length; li++) {
      const l = s.layers[li];
      lines.push(`  layer ${li}: tex=${l.texture.bound ? `${l.texture.srcShort} ${l.texture.w}x${l.texture.h} cs=${l.texture.colorSpace}` : 'NONE'}` +
        ` color=[${(l.materialColor || []).map((v) => v.toFixed(2)).join(',')}]` +
        ` opacity=${l.materialOpacity}` +
        ` blend=${l.blending}` +
        ` transparent=${l.materialTransparent}` +
        ` depthWrite=${l.depthWrite}` +
        ` flag=${l.layerFlag}`);
    }
  }
  lines.push('');
  // ── Mesh table ───────────────────────────────────────────────────────
  lines.push('## MESHES');
  const mHead = ['idx', 'vis', 'startMs', 'box(x,y,z)', 'mats', 'texsBound', 'flags', 'matSample'];
  const mW = [4, 3, 7, 26, 4, 9, 24, 60];
  lines.push(fmtRow(mHead, mW));
  lines.push('-'.repeat(mW.reduce((a, b) => a + b + 3, 0)));
  for (const m of inv.meshes) {
    const flags = Object.entries(m.flags || {}).filter(([, v]) => v).map(([k]) => k).join(',') || '';
    const m0 = m.materials[0] || {};
    const sample = `${m0.name || m0.type}/col=${(m0.color || []).map((v) => v?.toFixed(2)).join(',')}/map=${m0.map?.bound ? m0.map.srcShort : 'NONE'}`;
    lines.push(fmtRow([
      m.runtimeIndex,
      m.visible ? 'Y' : 'n',
      m.startTimeMs,
      Array.isArray(m.worldBoxSize) ? m.worldBoxSize.join(',') : '-',
      m.materialCount,
      m.texturesBound,
      flags,
      sample,
    ], mW));
  }
  return lines.join('\n');
}

function summariseFlags(inv) {
  const tally = {};
  for (const e of [...inv.sprites, ...inv.meshes]) {
    for (const [k, v] of Object.entries(e.flags || {})) {
      if (v) tally[k] = (tally[k] || 0) + 1;
    }
  }
  return tally;
}

test.describe('pss.html per-emitter inventory diagnostic', () => {
  for (const sourcePath of TARGETS) {
    test(`inventory dump for ${sourcePath.split('/').pop()}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.goto(`/pss.html?pss=${encodeURIComponent(sourcePath)}`, { waitUntil: 'domcontentloaded' });

      // Wait for "scene ready" — the loader emits this after addPssEffect,
      // startRenderLoop, and autoFitCameraToEffect have all run. The
      // ?pss param triggers an extra load on top of the auto-click, so
      // we wait for the LAST scene-ready row (the one matching our path).
      const fname = sourcePath.split('/').pop();
      await expect(
        page.locator('#pss-log-panel .pss-log-row', { hasText: /scene ready/ }).last()
      ).toBeVisible({ timeout: 30_000 });
      // Also wait until __pssRuntimeSnapshot reports our path. The
      // auto-click + ?pss collision means the first snapshot might be
      // for the auto-clicked first item, not for our target.
      await page.waitForFunction((expectedPath) => {
        const snap = window.__pssRuntimeSnapshot && window.__pssRuntimeSnapshot();
        if (!snap) return false;
        const all = [...snap.sprites, ...snap.meshes, ...snap.tracks];
        return all.length > 0 && all.every((e) => e.sourcePath === expectedPath);
      }, sourcePath, { timeout: 30_000 });

      // Drive the timeline to t=2500ms — past the global startDelay so
      // every emitter has flipped to visible — then snapshot.
      await page.evaluate(() => window.__pssTimelineSeek(2500));
      await page.waitForTimeout(150);

      const inv = await page.evaluate(() => window.__pssEmitterInventory && window.__pssEmitterInventory());
      expect(inv, '__pssEmitterInventory not exposed').toBeTruthy();

      // Render the table and write to log/.
      const table = renderInventoryTable(inv);
      const logDir = path.resolve(__dirname, '..', 'log');
      fs.mkdirSync(logDir, { recursive: true });
      const fnameSafe = fname.replace(/[^\w.\-]+/g, '_');
      const txtPath = path.join(logDir, `pss-inventory-${fnameSafe}.txt`);
      const jsonPath = path.join(logDir, `pss-inventory-${fnameSafe}.json`);
      fs.writeFileSync(txtPath, table, 'utf8');
      fs.writeFileSync(jsonPath, JSON.stringify(inv, null, 2), 'utf8');

      const flagTally = summariseFlags(inv);

      // Echo a compact summary to stdout so it's visible without opening files.
      console.log(`\n[inv ${fname}] ${table}\n`);
      console.log(`[inv ${fname}] flag-tally:`, JSON.stringify(flagTally));
      console.log(`[inv ${fname}] wrote ${txtPath} and ${jsonPath}`);

      await testInfo.attach(`pss-inventory-${fnameSafe}.txt`, { body: Buffer.from(table, 'utf8'), contentType: 'text/plain' });
      await testInfo.attach(`pss-inventory-${fnameSafe}.json`, { body: Buffer.from(JSON.stringify(inv, null, 2), 'utf8'), contentType: 'application/json' });

      // Hard invariants — catastrophic regressions only.
      expect(inv.counts.sprite + inv.counts.mesh, 'no emitters at all').toBeGreaterThan(0);
      const allEmitters = [...inv.sprites, ...inv.meshes];
      expect(allEmitters.some((e) => e.visible),
        'no emitter visible at t=2500ms — timeline-gating may have broken').toBe(true);

      // Soft hint: surface the white-walls diagnostic without failing the
      // test. The user can read the table to act on these.
      const noTexCount = allEmitters.filter((e) => e.flags?.noTextureBound).length;
      const whiteTintCount = allEmitters.filter((e) => e.flags?.allWhiteTint).length;
      const collapsedSizeCount = inv.sprites.filter((e) => e.flags?.collapsedSizeCurve).length;
      console.log(`[inv ${fname}] HINT: noTextureBound=${noTexCount}/${allEmitters.length}, allWhiteTint=${whiteTintCount}/${allEmitters.length}, collapsedSizeCurve=${collapsedSizeCount}/${inv.sprites.length}`);
    });
  }
});
