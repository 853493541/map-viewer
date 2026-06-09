// Parameter oracle test for pss.html — compares the in-memory runtime
// state of every emitter against the analyzer's authored data. Designed
// to surface "every emitter shares the same default startTime/lifetime"
// bugs (the user's "they appear together, feels like should have been
// timelined" hypothesis).
//
// Strategy:
//   1. Open pss.html on a deterministic PSS file and wait for runtime state.
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

const TARGET_SOURCE_PATH = 'data/source/other/HD特效/技能/Pss/发招/T_天策龙牙.pss';

test.describe('pss.html parameter oracle', () => {
  test('runtime emitter parameters reconcile with /api/pss/analyze', async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`/pss.html?pss=${encodeURIComponent(TARGET_SOURCE_PATH)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((expectedPath) => {
      const snap = window.__pssRuntimeSnapshot && window.__pssRuntimeSnapshot();
      if (!snap?.renderModel) return false;
      const all = [...snap.sprites, ...snap.meshes, ...snap.tracks];
      return all.length > 0 && all.every((e) => e.sourcePath === expectedPath);
    }, TARGET_SOURCE_PATH, { timeout: 30_000 });
    await page.waitForTimeout(300);

    const snap = await page.evaluate(() => window.__pssRuntimeSnapshot && window.__pssRuntimeSnapshot());
    expect(snap, '__pssRuntimeSnapshot() not exposed').toBeTruthy();

    const loadedSourcePath = TARGET_SOURCE_PATH;

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
    const particleLifetimes = snap.sprites.map((e) => e.particleLifetimeMs).filter((x) => Number.isFinite(x));

    const report = {
      loadedSourcePath,
      runtimeCounts: snap.counts,
      renderModel: snap.renderModel || null,
      analyzeCounts,
      analyzeTotalEmitters: (analyze.emitters || []).length,
      runtimeTotalEmitters: allRuntime.length,
      distinctStartTimesMs: distinct(startTimes),
      distinctEffectDurationsMs: distinct(durations),
      distinctParticleLifetimeMs: distinct(particleLifetimes),
      // Sample for human review.
      runtimeSamples: allRuntime.slice(0, 8).map((e) => ({
        kind: e.kind, runtimeIndex: e.runtimeIndex,
        emitterDataIndex: e.emitterDataIndex, startTimeMs: e.startTimeMs,
        effectDurationMs: e.effectDurationMs, particleLifetimeMs: e.particleLifetimeMs,
        timing: e.timing,
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
    // 4. Type-by-type counts: sprites follow analyzer count; tracks follow
    //    render-model count because linked ribbon launchers render through
    //    their paired type-3 track instead of double-rendering the track block.
    //    Mesh count can differ when GLB loader rejects an emitter — that is
    //    logged in the Things-went-wrong tab; we don't fail on it here.
    expect(snap.counts.sprite, 'sprite count mismatch').toBe(analyzeCounts.sprite);
    expect(snap.renderModel, 'render model contract missing from runtime snapshot').toBeTruthy();
    expect(snap.renderModel.parsedCounts.sprite, 'render model parsed sprite count mismatch').toBe(analyzeCounts.sprite);
    expect(snap.renderModel.parsedCounts.mesh, 'render model parsed mesh count mismatch').toBe(analyzeCounts.mesh);
    expect(snap.renderModel.parsedCounts.track, 'render model parsed track count mismatch').toBe(analyzeCounts.track);
    expect(snap.renderModel.renderCounts.sprite, 'render model sprite render count mismatch').toBe(snap.counts.sprite);
    expect(snap.renderModel.renderCounts.track, 'render model track render count mismatch').toBe(snap.counts.track);

    const linkedRibbonTracks = snap.tracks.filter((t) => t.trackRole === 'linked-ribbon');
    expect(linkedRibbonTracks.length, 'linked ribbon render count mismatch')
      .toBe(snap.renderModel.renderCounts.linkedRibbon || 0);
    for (const t of snap.tracks) {
      expect(t.usesDecodedTrack, `track#${t.runtimeIndex} should use decoded track nodes`).toBe(true);
      expect(t.usesTrackParams, `track#${t.runtimeIndex} should expose parsed KG3D_PARSYS_TRACK_BLOCK params`).toBe(true);
      expect(Number.isFinite(t.decodedNodeCount) && t.decodedNodeCount >= 2,
        `track#${t.runtimeIndex} decoded node count invalid`).toBe(true);
      expect(Number.isFinite(t.geometryNodeCount) && t.geometryNodeCount >= 2,
        `track#${t.runtimeIndex} geometry node count invalid`).toBe(true);
      expect(Number.isFinite(t.geometryVertexCount) && t.geometryVertexCount >= t.geometryNodeCount * 2,
        `track#${t.runtimeIndex} geometry vertex count invalid`).toBe(true);
      expect(t.trackParams?.struct, `track#${t.runtimeIndex} missing parsed track struct`).toBe('KG3D_PARSYS_TRACK_BLOCK');
      expect(Array.isArray(t.trackRenderConfig?.scaleXYZ), `track#${t.runtimeIndex} missing scaleXYZ render config`).toBe(true);
      expect(Number.isFinite(t.trackRenderConfig?.alphaScale), `track#${t.runtimeIndex} missing alpha render config`).toBe(true);
    }
    for (const t of linkedRibbonTracks) {
      expect(Number.isFinite(t.sourceTrackEmitterIndex), `linked ribbon#${t.runtimeIndex} missing paired type-3 source index`).toBe(true);
      expect(t.trackPath, `linked ribbon#${t.runtimeIndex} missing decoded track path`).toBeTruthy();
    }
    if (linkedRibbonTracks.length > 0) {
      expect(linkedRibbonTracks.some((t) => t.usesMaterialTexture || !!t.selectedTexture),
        'at least one linked ribbon should use launcher material/global texture binding').toBe(true);
    }
    for (const s of snap.sprites) {
      expect(s.instanced, `sprite#${s.runtimeIndex} is not using instanced billboard rendering`).toBe(true);
      expect(s.usesInstanceColor, `sprite#${s.runtimeIndex} missing per-instance color`).toBe(true);
      expect(s.usesInstanceOpacity, `sprite#${s.runtimeIndex} missing per-instance opacity`).toBe(true);
      expect(Number.isFinite(s.particleCount) && s.particleCount > 0,
        `sprite#${s.runtimeIndex} particle count is not finite`).toBe(true);
      expect(Number.isFinite(s.particleLifetimeMs) && s.particleLifetimeMs > 0,
        `sprite#${s.runtimeIndex} particle lifetime is not finite`).toBe(true);
    }

    const analyzerByIndex = new Map((analyze.emitters || [])
      .filter((em) => em.type === 'sprite')
      .map((em) => [em.index, em]));
    for (const s of snap.sprites) {
      const authoredLifetime = analyzerByIndex.get(s.emitterDataIndex)?.runtimeParams?.lifetimeSeconds;
      if (!Number.isFinite(authoredLifetime)) continue;
      expect(Math.abs(s.particleLifetimeMs - authoredLifetime * 1000),
        `sprite#${s.runtimeIndex} particle lifetime should follow analyzer runtimeParams.lifetimeSeconds`).toBeLessThan(0.01);
    }

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
    const distinctRuntimeParticleLifetimes = distinct(particleLifetimes.map((ms) => +(ms / 1000).toFixed(4)));
    if (distinctAnalyzeLifetimes.length > 1) {
      expect(distinctRuntimeParticleLifetimes.length,
        'renderer collapsed distinct authored particle lifetimes').toBeGreaterThan(1);
    }
  });
});
