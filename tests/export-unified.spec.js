import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import os from 'os';

const DESKTOP = join(os.homedir(), 'Desktop');
const EXPORT_ROOT = join(DESKTOP, 'MapViewerExports');
const SINGLE_SOUNDS = join(EXPORT_ROOT, 'single-sounds');
const ABILITY_PACKAGES = join(EXPORT_ROOT, 'ability-sound-packages');
const FULL_EXPORTS = join(EXPORT_ROOT, 'full-exports');

const KNOWN_WEM = '1087407';
const createdArtifacts = [];

function cleanup() {
  for (const p of createdArtifacts) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* noop */ }
  }
  createdArtifacts.length = 0;
}

test.describe('unified exports (Desktop/MapViewerExports)', () => {
  test('invalid export payloads are rejected', async ({ request }) => {
    let res = await request.post('/api/export-regional-with-collision', { data: {} });
    expect(res.status()).toBe(400);

    res = await request.post('/api/ability-matcher/wwise-export', { data: { wem: 'abc' } });
    expect(res.status()).toBe(400);

    res = await request.post('/api/ability-matcher/wwise-export', { data: { wem: '999999999', openFolder: false } });
    expect(res.status()).toBe(404);

    res = await request.post('/api/ability-matcher/tani-sound-export-package', { data: {} });
    expect(res.status()).toBe(400);
  });

  test('single WEM export lands in single-sounds/', async ({ request }) => {
    const res = await request.post('/api/ability-matcher/wwise-export', {
      data: { wem: KNOWN_WEM, name: 'export-test', openFolder: false },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.folder).toBe(SINGLE_SOUNDS);

    const filePath = join(SINGLE_SOUNDS, `export-test_${KNOWN_WEM}.ogg`);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath).subarray(0, 4).toString('ascii')).toBe('OggS');
    createdArtifacts.push(filePath);
  });

  test('tani package export lands in ability-sound-packages/', async ({ request }) => {
    const res = await request.post('/api/ability-matcher/tani-sound-export-package', {
      data: { scope: 'export-test', rows: [{ name: 'ExportTestAbility', wems: [KNOWN_WEM] }] },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.counts.abilities).toBe(1);
    expect(body.outputPath.startsWith(ABILITY_PACKAGES)).toBe(true);
    expect(existsSync(body.outputPath)).toBe(true);
    createdArtifacts.push(body.outputPath);
  });

  test('full exports list points at unified root', async ({ request }) => {
    const res = await request.get('/api/full-exports');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.root).toBe(FULL_EXPORTS);
    expect(Array.isArray(body.exports)).toBe(true);
  });

  test('export reader page loads without JS errors', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(`pageerror: ${err.message}`));
    await page.goto('/export-reader.html', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test.afterAll(() => {
    cleanup();
  });
});
