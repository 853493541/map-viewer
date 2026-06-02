import { test, expect } from '@playwright/test';

const TARGET_SOURCE_PATH = 'data/source/other/HD特效/技能/Pss/发招/T_天策龙牙.pss';

test.describe('pss.html PSS step trace', () => {
  test('defaults to Bad and separates renderer gaps from good steps', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(`/pss.html?pss=${encodeURIComponent(TARGET_SOURCE_PATH)}&v=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((expectedPath) => {
      const snap = window.__pssRuntimeSnapshot && window.__pssRuntimeSnapshot();
      return snap?.renderModel?.sourcePath === expectedPath && snap.counts.sprite > 0 && snap.counts.track > 0;
    }, TARGET_SOURCE_PATH, { timeout: 90_000 });

    await expect(page.locator('#trace-panel .dbg-title')).toHaveText('PSS Step Trace');
    await expect(page.locator('[data-trace-tab="bad"]')).toHaveClass(/active/);
    await expect(page.locator('#trace-body .trace-summary')).toContainText('Bad');
    await expect(page.locator('#trace-body .trace-row', { hasText: 'renderer-partial' }).first()).toBeVisible();
    await expect(page.locator('#trace-body')).toContainText('type2/Sprite');
    await expect(page.locator('#trace-body')).toContainText('no authored .Mesh path');
    await expect(page.locator('#trace-body')).toContainText('class-specific geometry remains partial');
    await expect(page.locator('#trace-body')).toContainText('bucket=');
    await expect(page.locator('#trace-body')).toContainText('textures=');
    await expect(page.locator('#trace-body')).not.toContainText('mesh/Spriteparsed');
    await expect(page.locator('#trace-body')).not.toContainText('socket: no authored socket');

    await page.locator('[data-trace-tab="good"]').click();
    await expect(page.locator('[data-trace-tab="good"]')).toHaveClass(/active/);
    await expect(page.locator('#trace-body .trace-row', { hasText: 'analyze-fetched' })).toBeVisible();
    await expect(page.locator('#trace-body .trace-row', { hasText: 'render-use' }).first()).toBeVisible();

    const counts = await page.evaluate(() => ({
      badRows: Array.from(document.querySelectorAll('#trace-body .trace-row')).length,
      goodActive: document.querySelector('[data-trace-tab="good"]')?.classList.contains('active') || false,
      title: document.querySelector('#trace-panel .dbg-title')?.textContent || '',
    }));
    expect(counts.goodActive).toBe(true);
    expect(counts.badRows).toBeGreaterThan(5);
    expect(counts.title).toBe('PSS Step Trace');
    expect(errors, errors.join('\n')).toEqual([]);
  });
});