// Visual smoke test for pss.html — confirms the WebGL viewport actually
// renders pixels (not just that the log says "scene ready"). Uses the
// `__pssDebug()` introspection hook installed in initThreeJs and the
// raw PNG of `#viewport-canvas` to count distinct pixel colours.
//
// Background: pss.html showed `addPssEffect ok / scene ready` in the
// step log but the user reported nothing rendered. A blank renderer
// produces ~1 unique colour (the clear color #080c12); a real render
// produces hundreds (anti-aliased edges + textured sprites + grid). We
// assert > 50 distinct colours as the minimum bar.

import { test, expect } from '@playwright/test';
import zlib from 'node:zlib';

const TARGET_SOURCE_PATH = 'data/source/other/HD特效/技能/Pss/发招/T_天策龙牙.pss';

// Tiny inline PNG decoder — extracts the raw RGBA pixel buffer from a
// PNG screenshot Playwright returned. Avoids adding a dependency.
function decodePngRGBA(buf) {
  // PNG signature
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error('not a PNG');
  }
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idatChunks = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); off += 4;
    const type = buf.toString('ascii', off, off + 4); off += 4;
    const data = buf.slice(off, off + len); off += len;
    off += 4; // CRC
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') break;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit PNGs supported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  // Apply PNG filter per scanline.
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const lineStart = y * (stride + 1) + 1;
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const b = raw[lineStart + x];
      const left = x >= channels ? cur[x - channels] : 0;
      const up = prev[x];
      const upLeft = x >= channels ? prev[x - channels] : 0;
      let v = 0;
      switch (filter) {
        case 0: v = b; break;
        case 1: v = (b + left) & 0xff; break;
        case 2: v = (b + up) & 0xff; break;
        case 3: v = (b + ((left + up) >> 1)) & 0xff; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pred = (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : upLeft);
          v = (b + pred) & 0xff; break;
        }
        default: throw new Error(`bad filter ${filter}`);
      }
      cur[x] = v;
    }
    cur.copy(prev);
    if (channels === 4) {
      cur.copy(rgba, y * width * 4);
    } else {
      for (let x = 0; x < width; x++) {
        rgba[(y * width + x) * 4 + 0] = cur[x * 3 + 0];
        rgba[(y * width + x) * 4 + 1] = cur[x * 3 + 1];
        rgba[(y * width + x) * 4 + 2] = cur[x * 3 + 2];
        rgba[(y * width + x) * 4 + 3] = 0xff;
      }
    }
  }
  return { width, height, rgba };
}

function summarisePixels({ width, height, rgba }) {
  const colors = new Set();
  let nonBg = 0;
  let colorful = 0;
  let bright = 0;
  let maxChannel = 0;
  let chromaSum = 0;
  let satSum = 0;
  // Renderer.setClearColor(0x080c12) → R=8, G=12, B=18.
  const bgR = 0x08, bgG = 0x0c, bgB = 0x12;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    colors.add((r << 16) | (g << 8) | b);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    const sat = max > 0 ? chroma / max : 0;
    maxChannel = Math.max(maxChannel, max);
    if (Math.abs(r - bgR) > 6 || Math.abs(g - bgG) > 6 || Math.abs(b - bgB) > 6) {
      nonBg++;
      chromaSum += chroma;
      satSum += sat;
    }
    if (sat > 0.22 && max > 35) colorful++;
    if (max > 150) bright++;
  }
  return {
    width, height,
    pixels: width * height,
    distinctColors: colors.size,
    nonBgPixels: nonBg,
    nonBgPct: +(100 * nonBg / (width * height)).toFixed(2),
    colorfulPct: +(100 * colorful / (width * height)).toFixed(2),
    brightPct: +(100 * bright / (width * height)).toFixed(2),
    avgChromaNonBg: nonBg ? +(chromaSum / nonBg).toFixed(2) : 0,
    avgSatNonBg: nonBg ? +(satSum / nonBg).toFixed(3) : 0,
    maxChannel,
  };
}

async function summariseCanvasElement(page, sampleWidth = 400, sampleHeight = 240) {
  return page.evaluate(({ sampleWidth, sampleHeight }) => {
    const canvas = document.querySelector('#viewport-canvas');
    if (!canvas) throw new Error('#viewport-canvas missing');
    const sample = document.createElement('canvas');
    sample.width = sampleWidth;
    sample.height = sampleHeight;
    const ctx = sample.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
    const rgba = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;
    const colors = new Set();
    let nonBg = 0;
    let colorful = 0;
    let bright = 0;
    let maxChannel = 0;
    let chromaSum = 0;
    let satSum = 0;
    let minX = sampleWidth;
    let minY = sampleHeight;
    let maxX = -1;
    let maxY = -1;
    const bgR = 0x08, bgG = 0x0c, bgB = 0x12;
    for (let y = 0; y < sampleHeight; y++) {
      for (let x = 0; x < sampleWidth; x++) {
        const i = (y * sampleWidth + x) * 4;
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        colors.add((r << 16) | (g << 8) | b);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const chroma = max - min;
        const sat = max > 0 ? chroma / max : 0;
        maxChannel = Math.max(maxChannel, max);
        if (Math.abs(r - bgR) > 6 || Math.abs(g - bgG) > 6 || Math.abs(b - bgB) > 6) {
          nonBg++;
          chromaSum += chroma;
          satSum += sat;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
        if (sat > 0.22 && max > 35) colorful++;
        if (max > 150) bright++;
      }
    }
    return {
      width: sampleWidth,
      height: sampleHeight,
      pixels: sampleWidth * sampleHeight,
      distinctColors: colors.size,
      nonBgPixels: nonBg,
      nonBgPct: +(100 * nonBg / (sampleWidth * sampleHeight)).toFixed(2),
      colorfulPct: +(100 * colorful / (sampleWidth * sampleHeight)).toFixed(2),
      brightPct: +(100 * bright / (sampleWidth * sampleHeight)).toFixed(2),
      avgChromaNonBg: nonBg ? +(chromaSum / nonBg).toFixed(2) : 0,
      avgSatNonBg: nonBg ? +(satSum / nonBg).toFixed(3) : 0,
      maxChannel,
      nonBgBounds: nonBg ? { minX, minY, maxX, maxY } : null,
    };
  }, { sampleWidth, sampleHeight });
}

test.describe('pss.html visual rendering', () => {
  test('viewport canvas has non-blank rendered content after auto-load', async ({ page }, testInfo) => {
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
    });

    // Use a generous viewport so the layout has space for both the log
    // panel (460px) and the renderer.
    await page.setViewportSize({ width: 1600, height: 900 });

    await page.goto('/pss.html', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => {
      const runtime = window.__pssRuntimeSnapshot && window.__pssRuntimeSnapshot();
      const debug = window.__pssDebug && window.__pssDebug();
      if (!runtime || !debug) return false;
      const totalRuntime = runtime.counts.sprite + runtime.counts.mesh + runtime.counts.track;
      const totalDebug = debug.counts.sprite + debug.counts.mesh + debug.counts.track;
      return totalRuntime > 0 && totalDebug > 0 && debug.isRendering === true;
    }, { timeout: 30_000 });

    // Give the render loop a few frames so the canvas has content.
    await page.waitForTimeout(500);

    // Snapshot internals for diagnostics.
    const snap = await page.evaluate(() => window.__pssDebug && window.__pssDebug());
    testInfo.attach('pss-debug-snapshot.json', {
      body: JSON.stringify(snap, null, 2),
      contentType: 'application/json',
    });
    console.log('[pss-debug]', JSON.stringify(snap, null, 2));

    expect(snap, '__pssDebug() returned nothing').toBeTruthy();
    expect(snap.canvas.cw, 'canvas client width is 0').toBeGreaterThan(50);
    expect(snap.canvas.ch, 'canvas client height is 0').toBeGreaterThan(50);
    expect(snap.counts.sprite + snap.counts.mesh + snap.counts.track,
      'no emitters/meshes/tracks landed in the scene').toBeGreaterThan(0);
    expect(snap.isRendering, 'render loop not running').toBe(true);

    // Take a screenshot of just the canvas.
    const png = await page.locator('#viewport-canvas').screenshot();
    await testInfo.attach('viewport-canvas.png', { body: png, contentType: 'image/png' });

    const summary = summarisePixels(decodePngRGBA(png));
    console.log('[pixel-summary]', JSON.stringify(summary));
    await testInfo.attach('pixel-summary.json', {
      body: JSON.stringify(summary, null, 2),
      contentType: 'application/json',
    });

    expect(summary.distinctColors,
      `canvas appears blank — only ${summary.distinctColors} distinct color(s)`).toBeGreaterThan(50);
    expect(summary.nonBgPct,
      `<1% of pixels differ from the clear color`).toBeGreaterThan(1);

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  });

  test('narrow layout keeps canvas visible and seek renders immediately', async ({ page }, testInfo) => {
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
    });

    await page.setViewportSize({ width: 360, height: 700 });
    await page.goto(`/pss.html?pss=${encodeURIComponent(TARGET_SOURCE_PATH)}&v=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((expectedPath) => {
      const snap = window.__pssRuntimeSnapshot && window.__pssRuntimeSnapshot();
      return snap?.renderModel?.sourcePath === expectedPath && snap.counts.sprite > 0 && snap.counts.track > 0;
    }, TARGET_SOURCE_PATH, { timeout: 30_000 });

    const seekResult = await page.evaluate(() => window.__pssTimelineSeek(2500));
    expect(seekResult?.rendered, '__pssTimelineSeek should render before returning').toBe(true);

    const runtime = await page.evaluate(() => {
      const rect = document.querySelector('#viewport-canvas')?.getBoundingClientRect();
      const snap = window.__pssRuntimeSnapshot();
      const inv = window.__pssEmitterInventory();
      return {
        canvas: rect ? { width: rect.width, height: rect.height } : null,
        visibleSprites: snap.sprites.filter((s) => s.visible).length,
        visibleTracks: snap.tracks.filter((t) => t.visible).length,
        aliveSprites: inv.sprites.reduce((count, sprite) => count + sprite.aliveParticles, 0),
        timeline: snap.timeline,
      };
    });
    console.log('[pss-narrow-runtime]', JSON.stringify(runtime, null, 2));
    await testInfo.attach('pss-narrow-runtime.json', {
      body: JSON.stringify(runtime, null, 2),
      contentType: 'application/json',
    });

    expect(runtime.canvas?.width, 'narrow canvas collapsed horizontally').toBeGreaterThan(100);
    expect(runtime.canvas?.height, 'narrow canvas collapsed vertically').toBeGreaterThan(250);
    expect(runtime.visibleSprites, 'seek did not make sprites visible immediately').toBeGreaterThan(0);
    expect(runtime.visibleTracks, 'seek did not make track ribbons visible immediately').toBeGreaterThan(0);
    expect(runtime.aliveSprites, 'seek produced no alive sprite particles').toBeGreaterThan(0);
    expect(runtime.timeline.timelineMs).toBe(2500);

    const png = await page.locator('#viewport-canvas').screenshot();
    await testInfo.attach('narrow-viewport-canvas.png', { body: png, contentType: 'image/png' });
    const summary = summarisePixels(decodePngRGBA(png));
    console.log('[narrow-pixel-summary]', JSON.stringify(summary));
    await testInfo.attach('narrow-pixel-summary.json', {
      body: JSON.stringify(summary, null, 2),
      contentType: 'application/json',
    });

    expect(summary.distinctColors,
      `narrow canvas appears blank — only ${summary.distinctColors} distinct color(s)`).toBeGreaterThan(50);
    expect(summary.nonBgPct,
      `<1% of narrow canvas pixels differ from the clear color`).toBeGreaterThan(1);

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  });

  test('target PSS has renderer coverage and visible color energy', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
    });

    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`/pss.html?pss=${encodeURIComponent(TARGET_SOURCE_PATH)}&v=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((expectedPath) => {
      const snap = window.__pssRuntimeSnapshot && window.__pssRuntimeSnapshot();
      return snap?.renderModel?.sourcePath === expectedPath && snap.counts.sprite > 0 && snap.counts.track > 0;
    }, TARGET_SOURCE_PATH, { timeout: 90_000 });

    await page.evaluate(() => {
      const gridButton = document.querySelector('#btn-grid');
      if (gridButton?.classList.contains('active')) gridButton.click();
    });
    const seekResult = await page.evaluate(() => window.__pssTimelineSeek(2500));
    expect(seekResult?.rendered, '__pssTimelineSeek should render before returning').toBe(true);
    await page.waitForTimeout(250);

    const runtime = await page.evaluate(() => {
      const snap = window.__pssRuntimeSnapshot();
      const inv = window.__pssEmitterInventory();
      const collapsedSprites = inv.sprites
        .filter((sprite) => sprite.visible && sprite.aliveParticles > 0)
        .filter((sprite) => !Array.isArray(sprite.worldBoxSize) || Math.max(...sprite.worldBoxSize) < 0.5)
        .map((sprite) => ({
          emitterDataIndex: sprite.emitterDataIndex,
          worldBoxSize: sprite.worldBoxSize,
          authoredSizeCurve: sprite.authoredSizeCurve,
          authoredSizeKeyframes: Array.isArray(sprite.authoredSizeKeyframes) ? sprite.authoredSizeKeyframes.length : 0,
          spriteWorldScale: sprite.spriteWorldScale,
          spriteWorldScaleSource: sprite.spriteWorldScaleSource,
          lastScaleMultiplierRange: sprite.lastScaleMultiplierRange,
        }));
      return {
        counts: snap.counts,
        renderModel: snap.renderModel,
        camera: window.__pssDebug?.()?.camera || null,
        orbit: window.__pssDebug?.()?.orbit || null,
        aliveSprites: inv.sprites.reduce((sum, sprite) => sum + sprite.aliveParticles, 0),
        collapsedSprites,
        spriteScaleSources: [...new Set(inv.sprites.map((sprite) => sprite.spriteWorldScaleSource).filter(Boolean))],
        partialBadRows: [...document.querySelectorAll('#trace-body .trace-row')]
          .filter((node) => node.innerText.includes('renderer-partial')).length,
      };
    });
    console.log('[pss-target-runtime]', JSON.stringify(runtime, null, 2));
    await testInfo.attach('pss-target-runtime.json', {
      body: JSON.stringify(runtime, null, 2),
      contentType: 'application/json',
    });

    expect(runtime.renderModel?.renderCounts?.skipped, 'parsed PSS emitters are still skipped').toBe(0);
    expect(runtime.renderModel?.renderCounts?.proceduralSprite, 'procedural type-2 launchers did not instantiate').toBeGreaterThan(0);
    expect(runtime.orbit?.dist ?? 9999, 'camera did not refit close enough after seek').toBeLessThan(140);
    expect(runtime.aliveSprites, 'no live sprite particles at target frame').toBeGreaterThan(0);
    expect(runtime.collapsedSprites, `visible sprites collapsed: ${JSON.stringify(runtime.collapsedSprites)}`).toEqual([]);
    expect(runtime.spriteScaleSources, 'sprite scene-unit scale was not exposed').toContain('pss-billboard-scene-unit');
    expect(runtime.partialBadRows, 'partial procedural rows should remain visible in Bad').toBeGreaterThan(0);

    const png = await page.locator('#viewport-canvas').screenshot();
    await testInfo.attach('target-viewport-canvas.png', { body: png, contentType: 'image/png' });
    const summary = summarisePixels(decodePngRGBA(png));
    const canvasOnlySummary = await summariseCanvasElement(page);
    console.log('[target-pixel-summary]', JSON.stringify(summary));
    console.log('[target-canvas-only-summary]', JSON.stringify(canvasOnlySummary));
    await testInfo.attach('target-pixel-summary.json', {
      body: JSON.stringify(summary, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('target-canvas-only-summary.json', {
      body: JSON.stringify(canvasOnlySummary, null, 2),
      contentType: 'application/json',
    });

    expect(canvasOnlySummary.nonBgPct, 'effect is barely visible against the clear color').toBeGreaterThan(2);
    expect(canvasOnlySummary.colorfulPct, 'effect has too little saturated/colorful output').toBeGreaterThan(1.2);
    expect(canvasOnlySummary.brightPct, 'effect has almost no bright pixels').toBeGreaterThan(0.03);
    expect(canvasOnlySummary.avgChromaNonBg, 'non-background pixels are too gray').toBeGreaterThan(8);

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  });

  test('direct target URL opens paused on a visible preview frame', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
    });

    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`/pss.html?pss=${encodeURIComponent(TARGET_SOURCE_PATH)}&v=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((expectedPath) => {
      const snap = window.__pssRuntimeSnapshot && window.__pssRuntimeSnapshot();
      return snap?.renderModel?.sourcePath === expectedPath
        && snap.counts.sprite > 0
        && snap.counts.track > 0
        && snap.timeline?.playing === false
        && snap.timeline?.timelineMs > 0;
    }, TARGET_SOURCE_PATH, { timeout: 90_000 });
    await page.waitForTimeout(250);

    const runtime = await page.evaluate(() => {
      const snap = window.__pssRuntimeSnapshot();
      const inv = window.__pssEmitterInventory();
      const debug = window.__pssDebug?.();
      return {
        statusText: document.querySelector('#status-renderer')?.textContent || '',
        timeline: snap.timeline,
        counts: snap.counts,
        renderModel: snap.renderModel,
        orbit: debug?.orbit || null,
        aliveSprites: inv.sprites.reduce((sum, sprite) => sum + sprite.aliveParticles, 0),
        badRows: [...document.querySelectorAll('#trace-body .trace-row')].length,
        activeListPath: document.querySelector('#pss-list li.active')?.dataset.sourcePath || null,
      };
    });
    const canvasOnlySummary = await summariseCanvasElement(page);
    console.log('[direct-url-runtime]', JSON.stringify(runtime, null, 2));
    console.log('[direct-url-canvas-only-summary]', JSON.stringify(canvasOnlySummary));
    await testInfo.attach('direct-url-runtime.json', {
      body: JSON.stringify(runtime, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('direct-url-canvas-only-summary.json', {
      body: JSON.stringify(canvasOnlySummary, null, 2),
      contentType: 'application/json',
    });

    expect(runtime.timeline.playing, 'direct URL should hold the preview frame instead of autoplaying past it').toBe(false);
    expect(runtime.timeline.timelineMs, 'direct URL did not seek to the preview frame').toBeGreaterThan(1000);
    expect(runtime.timeline.timelineMs, 'direct URL preview frame drifted past the useful frame').toBeLessThan(3000);
    expect(runtime.renderModel?.renderCounts?.skipped, 'direct URL load still skipped parsed emitters').toBe(0);
    expect(runtime.aliveSprites, 'direct URL preview has no alive sprite particles').toBeGreaterThan(0);
    expect(runtime.badRows, 'direct URL did not populate Bad trace rows').toBeGreaterThan(0);
    expect(runtime.activeListPath, 'direct URL did not activate the matching list item').toBe(TARGET_SOURCE_PATH);
    expect(canvasOnlySummary.nonBgPct, 'direct URL preview is barely visible in the raw canvas').toBeGreaterThan(2);
    expect(canvasOnlySummary.colorfulPct, 'direct URL preview has too little saturated/colorful raw canvas output').toBeGreaterThan(1.2);
    expect(canvasOnlySummary.brightPct, 'direct URL preview has almost no bright raw canvas pixels').toBeGreaterThan(0.03);

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  });
});
