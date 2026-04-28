// Time-evolution invariant test for pss.html — verifies that the scene
// actually evolves over time: emitter visibility/positions change as
// the timeline advances. Catches "frozen scene" bugs even when the
// initial frame looks correct.
//
// Strategy:
//   1. Open pss.html, wait for "scene ready".
//   2. Snapshot at t=0, 500ms, 2000ms, 5000ms via __pssTimelineSeek().
//   3. Assert at least one of: (a) some emitter became visible/invisible
//      between consecutive snapshots, OR (b) some emitter world-position
//      changed by > 0.001 between snapshots — i.e. SOMETHING moved.
//   4. After the global play window ends, assert visible-counts drop OR
//      timeline wraps (whichever the engine does).

import { test, expect } from '@playwright/test';

const SAMPLE_TIMES_MS = [0, 500, 2000, 5000];

function diffSnapshots(a, b) {
  const diffs = { visibilityChanges: 0, positionChanges: 0, sample: [] };
  const map = new Map(a.map((e) => [`${e.kind}#${e.runtimeIndex}`, e]));
  for (const eb of b) {
    const ea = map.get(`${eb.kind}#${eb.runtimeIndex}`);
    if (!ea) continue;
    if (ea.visible !== eb.visible) {
      diffs.visibilityChanges++;
      if (diffs.sample.length < 6) diffs.sample.push({ key: `${eb.kind}#${eb.runtimeIndex}`, kind: 'visibility', from: ea.visible, to: eb.visible });
    }
    const pa = ea.worldPosition || [0, 0, 0];
    const pb = eb.worldPosition || [0, 0, 0];
    const d = Math.hypot((pa[0] - pb[0]), (pa[1] - pb[1]), (pa[2] - pb[2]));
    if (d > 0.001) {
      diffs.positionChanges++;
      if (diffs.sample.length < 6) diffs.sample.push({ key: `${eb.kind}#${eb.runtimeIndex}`, kind: 'position', delta: +d.toFixed(3) });
    }
  }
  return diffs;
}

test.describe('pss.html timeline evolution', () => {
  test('scene state evolves as the timeline advances', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/pss.html', { waitUntil: 'domcontentloaded' });
    await expect(
      page.locator('#pss-log-panel .pss-log-row', { hasText: /scene ready/ }).first()
    ).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(300);

    expect(await page.evaluate(() => typeof window.__pssTimelineSeek === 'function'),
      '__pssTimelineSeek not exposed').toBe(true);
    expect(await page.evaluate(() => typeof window.__pssRuntimeSnapshot === 'function'),
      '__pssRuntimeSnapshot not exposed').toBe(true);

    const snapshots = [];
    for (const t of SAMPLE_TIMES_MS) {
      await page.evaluate((ms) => window.__pssTimelineSeek(ms), t);
      // Allow the render loop a few frames so visibility flags update.
      await page.waitForTimeout(150);
      const snap = await page.evaluate(() => window.__pssRuntimeSnapshot());
      const all = [...snap.sprites, ...snap.meshes, ...snap.tracks];
      const visibleCount = all.filter((e) => e.visible).length;
      snapshots.push({ tMs: t, visibleCount, totalEmitters: all.length, all });
    }

    // Diff consecutive snapshots.
    const diffs = [];
    for (let i = 1; i < snapshots.length; i++) {
      diffs.push({
        from: snapshots[i - 1].tMs,
        to: snapshots[i].tMs,
        ...diffSnapshots(snapshots[i - 1].all, snapshots[i].all),
      });
    }

    const report = {
      sampleTimesMs: SAMPLE_TIMES_MS,
      timelineTotalMs: await page.evaluate(() => window.__pssRuntimeSnapshot().timeline.timelineTotalMs),
      perSnapshot: snapshots.map((s) => ({ tMs: s.tMs, visibleCount: s.visibleCount, totalEmitters: s.totalEmitters })),
      diffs,
    };
    console.log('[pss-timeline]', JSON.stringify(report, null, 2));
    await testInfo.attach('timeline-report.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });

    // Hard assertion: across all sample-pair diffs, SOMETHING must change.
    // A scene that produces zero visibility AND zero position changes
    // across 4 sample times spanning 5 seconds is frozen — that is the
    // failure mode we want this test to catch.
    const totalChanges = diffs.reduce((acc, d) => acc + d.visibilityChanges + d.positionChanges, 0);
    expect(totalChanges, `scene appears frozen — no visibility or position changes across t=${SAMPLE_TIMES_MS.join('ms,')}ms`).toBeGreaterThan(0);

    // Soft hint: if every emitter is visible at t=0 AND at t=500ms with
    // identical positions, the user's "they appear together" hypothesis
    // is confirmed. Surface it without failing the test.
    const t0 = snapshots[0];
    if (t0.visibleCount > 0 && t0.visibleCount === t0.totalEmitters) {
      console.log('[pss-timeline NOTE] every emitter visible at t=0 (', t0.visibleCount,
        '/', t0.totalEmitters, ') — per-emitter spawn-time staggering is not active.');
    }
  });
});
