import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3015';

test('sounds.html plays Play_AiLi_At01 (currentTime advances)', async ({ page }) => {
  await page.goto(`${BASE}/sounds.html`);
  await expect(page.locator('#wwise-direct-meta')).toContainText(/playable/, { timeout: 30000 });
  await page.fill('#wwise-direct-search', 'AiLi_At01');
  await expect(page.locator('[data-wwise-event="Play_AiLi_At01"]').first()).toBeVisible({ timeout: 30000 });
  await page.locator('[data-wwise-event="Play_AiLi_At01"]').first().click();

  const advanced = await page.waitForFunction(() => {
    const a = document.getElementById('audio-player');
    return a && !a.error && a.currentTime > 0.1 && a.readyState >= 2;
  }, null, { timeout: 15000 }).catch(() => null);

  const state = await page.evaluate(() => {
    const a = document.getElementById('audio-player');
    return { currentTime: a?.currentTime, error: a?.error?.message || null, src: a?.src };
  });
  console.log('AiLi state:', state);
  expect(state.error).toBeNull();
  expect(advanced).not.toBeNull();
  expect(state.currentTime).toBeGreaterThan(0.1);
});

test('sounds.html plays Play_BeHit_Flesh_Sword01 (combat hit SFX)', async ({ page }) => {
  await page.goto(`${BASE}/sounds.html`);
  await expect(page.locator('#wwise-direct-meta')).toContainText(/playable/, { timeout: 30000 });
  await page.fill('#wwise-direct-search', 'Sword01');
  await expect(page.locator('[data-wwise-event="Play_BeHit_Flesh_Sword01"]').first()).toBeVisible({ timeout: 30000 });
  await page.locator('[data-wwise-event="Play_BeHit_Flesh_Sword01"]').first().click();

  const advanced = await page.waitForFunction(() => {
    const a = document.getElementById('audio-player');
    return a && !a.error && a.currentTime > 0.1 && a.readyState >= 2;
  }, null, { timeout: 15000 }).catch(() => null);

  const state = await page.evaluate(() => {
    const a = document.getElementById('audio-player');
    return { currentTime: a?.currentTime, error: a?.error?.message || null };
  });
  console.log('BeHit state:', state);
  expect(state.error).toBeNull();
  expect(advanced).not.toBeNull();
  expect(state.currentTime).toBeGreaterThan(0.1);
});

test('Bank filter narrows the list to Behit (14 events)', async ({ page }) => {
  await page.goto(`${BASE}/sounds.html`);
  await expect(page.locator('#wwise-direct-meta')).toContainText(/playable/, { timeout: 30000 });
  await expect(page.locator('#wwise-bank-filter option[value="Behit"]')).toHaveCount(1, { timeout: 60000 });
  await page.selectOption('#wwise-bank-filter', 'Behit');
  await expect(page.locator('#wwise-direct-meta')).toContainText(/14 \/ /);
  await expect(page.locator('[data-wwise-event^="Play_BeHit_"]').first()).toBeVisible();
});

test('TANI catalog UI is gone', async ({ page }) => {
  await page.goto(`${BASE}/sounds.html`);
  await expect(page.locator('#tani-list')).toHaveCount(0);
  await expect(page.locator('#tani-search')).toHaveCount(0);
});

test('Search box and list are visible at 1280x800', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${BASE}/sounds.html`);
  await expect(page.locator('#wwise-direct-meta')).toContainText(/playable/, { timeout: 30000 });
  const bounds = await page.evaluate(() => {
    const search = document.getElementById('wwise-direct-search').getBoundingClientRect();
    const list = document.getElementById('wwise-direct-list').getBoundingClientRect();
    return { sTop: search.top, sBot: search.bottom, lTop: list.top, lBot: list.bottom, vh: window.innerHeight };
  });
  expect(bounds.sTop).toBeGreaterThanOrEqual(0);
  expect(bounds.sBot).toBeLessThanOrEqual(bounds.vh);
  expect(bounds.lTop).toBeGreaterThan(bounds.sBot - 5);
  expect(bounds.lBot).toBeLessThanOrEqual(bounds.vh + 1);
});
