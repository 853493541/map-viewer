import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3015';

test.describe('cdn-download.html', () => {
  test('defaults to Live tab and shows an ordered checklist with a Run Bridge button', async ({ page }) => {
    const apiResponse = page.waitForResponse(
      (r) => r.url().includes('/api/cdn/live-readiness') && r.request().method() === 'GET',
      { timeout: 30000 },
    );
    await page.goto(`${BASE}/cdn-download.html`);
    const resp = await apiResponse;
    expect(resp.status()).toBe(200);

    await expect(page.locator('#tab-live')).toHaveClass(/active/);
    await expect(page.locator('#tab-offline')).not.toHaveClass(/active/);
    await expect(page.locator('#run-bridge')).toBeVisible();
    await expect(page.locator('#reload')).toBeVisible();
    await expect(page.locator('#live-health')).toBeVisible();
    await expect(page.locator('#live-steps .step')).toHaveCount(5);
    await expect(page.locator('#failure-box')).toBeVisible();
  });

  test('Run Bridge button calls start-capture and returns to idle state', async ({ page }) => {
    await page.goto(`${BASE}/cdn-download.html`);
    const apiResponse = page.waitForResponse(
      (r) => r.url().includes('/api/cdn/start-capture') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await page.locator('#run-bridge').click();
    const resp = await apiResponse;
    expect(resp.status()).toBe(200);
    await expect(page.locator('#run-bridge')).toHaveText('Run Bridge', { timeout: 10000 });
  });

  test('clean UI - no decorative noise from old design', async ({ page }) => {
    await page.goto(`${BASE}/cdn-download.html`);
    await page.locator('#tab-offline').click();
    await expect(page.locator('.row').first()).toBeVisible({ timeout: 15000 });

    await expect(page.locator('.eyebrow')).toHaveCount(0);
    await expect(page.locator('.summary')).toHaveCount(0);
    await expect(page.locator('.hero')).toHaveCount(0);
    await expect(page.locator('.entry-index')).toHaveCount(0);
    await expect(page.locator('.source-line')).toHaveCount(0);
    await expect(page.locator('text=RENDERED ON SCREEN')).toHaveCount(0);

    await expect(page.locator('#search')).toBeVisible();
    await expect(page.locator('#tab-live')).toBeVisible();
    await expect(page.locator('#tab-offline')).toBeVisible();

    const dlButtons = page.locator('.row [data-role="dl"]');
    expect(await dlButtons.count()).toBeGreaterThan(0);
    await expect(dlButtons.first()).toHaveText(/download/i);
  });

  test('Offline tab: search filters the list', async ({ page }) => {
    await page.goto(`${BASE}/cdn-download.html`);
    await page.locator('#tab-offline').click();
    await expect(page.locator('.row').first()).toBeVisible({ timeout: 15000 });

    await page.fill('#search', 'anitable.txt');
    await page.waitForTimeout(500);

    const paths = await page.locator('.row .path').allTextContents();
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.toLowerCase()).toContain('anitable.txt');
    }
  });

  test('clicking Download triggers /api/cdn/download and updates status', async ({ page }) => {
    await page.goto(`${BASE}/cdn-download.html`);
    await page.locator('#tab-offline').click();
    await expect(page.locator('.row').first()).toBeVisible({ timeout: 15000 });

    await page.fill('#search', 'anitable.txt');
    await page.waitForTimeout(500);
    const row = page.locator('.row').first();
    await expect(row).toBeVisible();

    const apiResponse = page.waitForResponse(
      (r) => r.url().includes('/api/cdn/download') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await row.locator('[data-role="dl"]').click();
    const resp = await apiResponse;
    expect([200, 502]).toContain(resp.status());

    const status = row.locator('[data-role="status"]');
    await expect(status).not.toHaveText('downloading...', { timeout: 30000 });
    await expect(status).toHaveClass(/(ok|fail)/);

    const text = (await status.textContent()) || '';
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/undefined is not|TypeError|\[object Object\]/);
  });
});
