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
  // Renderer.setClearColor(0x080c12) → R=8, G=12, B=18.
  const bgR = 0x08, bgG = 0x0c, bgB = 0x12;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    colors.add((r << 16) | (g << 8) | b);
    if (Math.abs(r - bgR) > 6 || Math.abs(g - bgG) > 6 || Math.abs(b - bgB) > 6) nonBg++;
  }
  return {
    width, height,
    pixels: width * height,
    distinctColors: colors.size,
    nonBgPixels: nonBg,
    nonBgPct: +(100 * nonBg / (width * height)).toFixed(2),
  };
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

    // Wait for an auto-load to finish: the step log emits "scene ready".
    await expect(
      page.locator('#pss-log-panel .pss-log-row', { hasText: /scene ready/ }).first()
    ).toBeVisible({ timeout: 30_000 });

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
});
