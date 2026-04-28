// Parameter oracle test for pss.html — compares the in-memory runtime
// state of every emitter against the analyzer's authored data. Designed
// to surface "every emitter shares the same default startTime/lifetime"
// bugs (the user's "they appear together, feels like should have been
// timelined" hypothesis).
//
// Strategy:
//   1. Open pss.html, wait for "scene ready".
//   2. Read window.__pssRuntimeSnapshot() — kind, startTimeMs, lifetime,
//      sourcePath, world position for every sprite/mesh/track.
//   3. Fetch /api/pss/analyze for the loaded sourcePath.
//   4. Cross-check counts (analyze.emitters.length vs runtime totals).
//   5. Report distributions of startTimeMs and effectDurationMs across
//      runtime emitters — used as evidence (not a hard pass/fail) that
//      timing is or isn't varied per-emitter.
//   6. Hard-assert sane invariants (counts match, no NaN startTimes,
//      every runtime emitter has a sourcePath that matches the loaded
//      one, every visible emitter has a non-degenerate world position).

import { test, expect } from '@playwright/test';

test.describe('pss.html parameter oracle', () => {
  test('runtime emitter parameters reconcile with /api/pss/analyze', async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/pss.html', { waitUntil: 'domcontentloaded' });
    await expect(
      page.locator('#pss-log-panel .pss-log-row', { hasText: /scene ready/ }).first()
    ).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(300);

    const snap = await page.evaluate(() => window.__pssRuntimeSnapshot && window.__pssRuntimeSnapshot());
    expect(snap, '__pssRuntimeSnapshot() not exposed').toBeTruthy();

    // Discover the loaded sourcePath via __pssDebug or the active list item.
    const loadedSourcePath = await page.evaluate(() => {
      const all = [
        ...(window.__pssRuntimeSnapshot?.()?.sprites || []),
        ...(window.__pssRuntimeSnapshot?.()?.meshes || []),
        ...(window.__pssRuntimeSnapshot?.()?.tracks || []),
      ];
      return all.find((e) => e.sourcePath)?.sourcePath || null;
    });
    expect(loadedSourcePath, 'no runtime emitter exposes a sourcePath').toBeTruthy();

    // Fetch analyzer data for the same sourcePath via the running server.
    const analyzeResp = await request.get(`/api/pss/analyze?sourcePath=${encodeURIComponent(loadedSourcePath)}`);
    expect(analyzeResp.ok(), 'analyze endpoint returned !ok').toBeTruthy();
    const analyze = await analyzeResp.json();
    expect(analyze.ok, 'analyze.ok = false').toBeTruthy();

    const allRuntime = [...snap.sprites, ...snap.meshes, ...snap.tracks];
    const analyzeCounts = {
      sprite: (analyze.emitters || []).filter((e) => e.type === 'sprite').length,
      mesh: (analyze.emitters || []).filter((e) => e.type === 'mesh').length,
      track: (analyze.emitters || []).filter((e) => e.type === 'track').length,
    };

    const distinct = (arr) => Array.from(new Set(arr));
    const startTimes = allRuntime.map((e) => e.startTimeMs);
    const durations = [...snap.sprites, ...snap.tracks].map((e) => e.effectDurationMs);

    const report = {
      loadedSourcePath,
      runtimeCounts: snap.counts,
      analyzeCounts,
      analyzeTotalEmitters: (analyze.emitters || []).length,
      runtimeTotalEmitters: allRuntime.length,
      distinctStartTimesMs: distinct(startTimes),
      distinctEffectDurationsMs: distinct(durations),
      // Sample for human review.
      runtimeSamples: allRuntime.slice(0, 8).map((e) => ({
        kind: e.kind, runtimeIndex: e.runtimeIndex,
        startTimeMs: e.startTimeMs, effectDurationMs: e.effectDurationMs,
        worldPosition: e.worldPosition, attachedTo: e.attachedTo,
      })),
      analyzeTimingFields: {
        globalStartDelay: analyze.globalStartDelay ?? null,
        globalDuration: analyze.globalDuration ?? null,
        globalPlayDuration: analyze.globalPlayDuration ?? null,
      },
      analyzeEmitterRuntimeParamsSample: (analyze.emitters || []).slice(0, 4).map((em) => ({
        index: em.index,
        type: em.type,
        runtimeParams: em.runtimeParams || null,
      })),
    };
    console.log('[pss-oracle]', JSON.stringify(report, null, 2));
    await testInfo.attach('oracle-report.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });

    // ── Hard invariants ─────────────────────────────────────────────────
    // 1. Every runtime emitter's sourcePath equals the loaded path.
    for (const e of allRuntime) {
      expect(e.sourcePath, `emitter ${e.kind}#${e.runtimeIndex} has wrong sourcePath`).toBe(loadedSourcePath);
    }
    // 2. No NaN/null startTimes — engine fields must be numeric.
    for (const e of allRuntime) {
      expect(Number.isFinite(e.startTimeMs), `emitter ${e.kind}#${e.runtimeIndex} startTimeMs not finite`).toBe(true);
    }
    // 3. Every visible emitter has a non-zero world position OR is at
    //    an emitter group origin — degenerate (NaN) positions indicate
    //    broken matrix updates.
    for (const e of allRuntime) {
      if (!e.visible) continue;
      const p = e.worldPosition || [0, 0, 0];
      expect(p.every((v) => Number.isFinite(v)),
        `${e.kind}#${e.runtimeIndex} has non-finite world position ${JSON.stringify(p)}`).toBe(true);
    }
    // 4. Type-by-type counts: sprite + track lengths must match analyze.
    //    (mesh count can differ when GLB loader rejects an emitter — that
    //    is logged in the Things-went-wrong tab; we don't fail on it here.)
    expect(snap.counts.sprite, 'sprite count mismatch').toBe(analyzeCounts.sprite);
    expect(snap.counts.track, 'track count mismatch').toBe(analyzeCounts.track);

    // ── Diagnostic invariant for the user's hypothesis ─────────────────
    // If the analyzer parsed any per-emitter runtimeParams.lifetimeSeconds
    // values, capture whether they are distinct. If all runtime emitters
    // share one startTimeMs AND lifetimeSeconds varies in the analyze
    // data, the renderer is collapsing per-emitter timing — record this
    // as evidence (warning, not a hard fail) so the user can act on it.
    const analyzeLifetimes = (analyze.emitters || [])
      .map((em) => em?.runtimeParams?.lifetimeSeconds)
      .filter((x) => Number.isFinite(x));
    const distinctAnalyzeLifetimes = distinct(analyzeLifetimes);
    const distinctRuntimeStarts = distinct(startTimes);
    if (distinctAnalyzeLifetimes.length > 1 && distinctRuntimeStarts.length === 1) {
      console.log('[pss-oracle WARN] analyze has', distinctAnalyzeLifetimes.length,
        'distinct authored per-emitter lifetimes but every runtime emitter shares startTimeMs =', distinctRuntimeStarts[0],
        '— per-emitter timing appears to be collapsed.');
    }
  });
});
