import { test, expect } from '@playwright/test';

const QIXIU_TANI = 'data/source/player/f2/动作/f2s05qx剑技能22_鹊踏枝hd.tani';
const QIXIU_PSS_A = 'data/source/other/hd特效/技能/pss/发招/q_七秀鹊踏枝01.pss';
const QIXIU_PSS_B = 'data/source/other/hd特效/技能/pss/发招/q_七秀鹊踏枝_01.pss';

async function getJson(request, url) {
  const response = await request.get(url);
  expect(response.ok(), `${url} returned HTTP ${response.status()}`).toBeTruthy();
  return response.json();
}

function emitterByIndex(body, index) {
  const emitter = body.emitters.find((entry) => entry.index === index);
  expect(emitter, `missing emitter ${index}`).toBeTruthy();
  return emitter;
}

test.describe('Client Monitor animation player - 鹊踏枝', () => {
  test('decodes no-time-module sprite lifetime from PSS global play duration', async ({ request }) => {
    const expectations = [
      { sourcePath: QIXIU_PSS_A, indices: [1] },
      { sourcePath: QIXIU_PSS_B, indices: [1, 2, 5, 6, 7, 12, 13, 15, 16, 17, 18] },
    ];

    for (const { sourcePath, indices } of expectations) {
      const body = await getJson(request, `/api/pss/analyze?sourcePath=${encodeURIComponent(sourcePath)}`);
      expect(body.ok).toBe(true);
      expect(body.globalPlayDuration).toBe(5000);

      for (const emitter of body.emitters.filter((entry) => entry.type === 'sprite')) {
        expect(String(emitter.runtimeParams?.source || ''), `${sourcePath} emitter ${emitter.index}`).not.toContain('inferred');
      }

      for (const index of indices) {
        const emitter = emitterByIndex(body, index);
        expect(emitter.runtimeParams?.lifetimeSeconds, `${sourcePath} emitter ${index}`).toBe(5);
        expect(emitter.runtimeParams?.lifetimeSource, `${sourcePath} emitter ${index}`).toBe('pss-global-play-duration');
        expect(emitter.runtimeParams?.lifetimeSourceMs, `${sourcePath} emitter ${index}`).toBe(5000);
      }
    }

    const dump = await getJson(request, `/api/pss/debug-dump?sourcePath=${encodeURIComponent(QIXIU_PSS_B)}`);
    const emitter14 = dump.blocks.find((block) => block.index === 14);
    const scale = emitter14?.parsed?.curveInfo?.scale?.find((entry) => entry.layoutKind === 'scale-record24');
    expect(scale, 'emitter 14 scale-record24 decoder missing').toBeTruthy();
    expect(scale.decodedKeyCount).toBe(10);
    expect(scale.keys[0].value).toBe(0.5);
  });

  test('renders a targeted moon and pink swirl frame without old player code', async ({ page }, testInfo) => {
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
    });

    await page.setViewportSize({ width: 960, height: 720 });
    const params = new URLSearchParams({
      embed: 'client-monitor',
      strict: '1',
      auto: '1',
      bodyType: 'f2',
      autoTani: QIXIU_TANI,
      monitorSkillId: 'qixiu-target-frame-test',
    });
    await page.goto(`/client-monitor-animation-player.html?${params.toString()}`, { waitUntil: 'domcontentloaded' });

    const stats = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      for (let attempt = 0; attempt < 80; attempt++) {
        await wait(250);
        const internals = window.__clientMonitorAnimationPlayerInternals;
        const state = internals?.state;
        if (!state?.loaded || state.timelineMs < 2200 || state.timelineMs > 6800) continue;

        const canvas = document.querySelector('#viewport');
        const sample = document.createElement('canvas');
        sample.width = 320;
        sample.height = 180;
        const ctx = sample.getContext('2d');
        ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
        const data = ctx.getImageData(0, 0, sample.width, sample.height).data;
        let nonBgPixels = 0;
        let pinkPixels = 0;
        let brightPixels = 0;
        let maxChannel = 0;
        const distinct = new Set();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          maxChannel = Math.max(maxChannel, r, g, b);
          distinct.add((r << 16) | (g << 8) | b);
          if (r > 18 || g > 22 || b > 26) nonBgPixels++;
          if (r > 140 && b > 95 && r > g + 24 && b > g + 8) pinkPixels++;
          if (r > 190 && g > 160 && b > 130) brightPixels++;
        }
        const report = window.__clientMonitorAnimationPlayerSnapshot?.();
        return {
          timelineMs: state.timelineMs,
          report,
          actorScriptLoaded: performance.getEntriesByType('resource').some((entry) => entry.name.includes('actor-animation-player')),
          newScriptLoaded: performance.getEntriesByType('resource').some((entry) => entry.name.includes('client-monitor-animation-player.js')),
          pixel: {
            sampledPixels: data.length / 4,
            nonBgPixels,
            nonBgPct: nonBgPixels / (data.length / 4),
            pinkPixels,
            brightPixels,
            maxChannel,
            distinctColors: distinct.size,
          },
          visibleSprites: state.sprites.filter((sprite) => sprite.group.visible).length,
        };
      }
      return null;
    });

    expect(stats, 'target active frame was not sampled').toBeTruthy();
    await testInfo.attach('qixiu-target-frame-stats.json', {
      body: JSON.stringify(stats, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('qixiu-target-frame.png', {
      body: await page.locator('#viewport').screenshot(),
      contentType: 'image/png',
    });

    expect(stats.actorScriptLoaded).toBe(false);
    expect(stats.newScriptLoaded).toBe(true);
    expect(stats.report.status, JSON.stringify(stats.report.blockers || [], null, 2)).toBe('ok');
    expect(stats.report.fallbackCount).toBe(0);
    expect(stats.report.errorCount).toBe(0);
    expect(stats.report.renderCounts.sprite).toBeGreaterThanOrEqual(24);
    expect(stats.visibleSprites).toBeGreaterThanOrEqual(24);
    expect(stats.pixel.distinctColors).toBeGreaterThan(40);
    expect(stats.pixel.nonBgPct).toBeGreaterThan(0.08);
    expect(stats.pixel.pinkPixels).toBeGreaterThan(700);
    expect(stats.pixel.brightPixels).toBeGreaterThan(700);
    expect(stats.pixel.maxChannel).toBeGreaterThan(220);
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  });
});