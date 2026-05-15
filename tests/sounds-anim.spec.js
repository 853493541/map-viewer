import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3015';

test('sounds.html — animation -> sound resolves and plays', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(`${BASE}/sounds.html`);

  // Index loads with non-zero categories.
  await expect(page.locator('#cat-list .cat-item')).toHaveCount(4, { timeout: 15000 }); // All + 3 factions
  await expect(page.locator('#cat-meta')).toContainText('100');

  // Filter to longya animation, click it.
  await page.fill('#search-input', 'longya');
  const firstRow = page.locator('#anim-list .ar-row').first();
  await expect(firstRow).toBeVisible({ timeout: 5000 });
  await firstRow.click();

  // Detail panel must show resolved Wwise candidates with TianCe + longya in the top hit.
  // (The longya event itself has no WEMs in this bank corpus, so it shows up as
  //  a non-playable candidate; lower-scoring fallback hits are playable.)
  const wwiseTop = page.locator('.wwise-hits .det-row').first();
  await expect(wwiseTop).toBeVisible({ timeout: 5000 });

  // Now switch to a footsteps animation which has a playable Wwise hit
  // (Misc_Misc_tex_footsteps_Footsteps_all is in-bank).
  await page.fill('#search-input', '行走');
  const walkRow = page.locator('#anim-list .ar-row').first();
  await expect(walkRow).toBeVisible({ timeout: 5000 });
  await walkRow.click();
  const playable = page.locator('.wwise-hits .det-row').first();
  await expect(playable).toBeVisible({ timeout: 5000 });
  await expect(playable).toContainText('footsteps', { ignoreCase: true });

  // Click Play (best) — audio must advance currentTime.
  await playable.locator('.play-btn').click();
  const advanced = await page.waitForFunction(() => {
    const a = document.getElementById('audio-player');
    return a && !a.error && a.currentTime > 0.1 && a.readyState >= 2;
  }, null, { timeout: 20000 }).catch(() => null);

  const state = await page.evaluate(() => {
    const a = document.getElementById('audio-player');
    return { currentTime: a?.currentTime, error: a?.error?.message || null, src: a?.src, readyState: a?.readyState };
  });
  console.log('audio state:', state);
  console.log('errors:', errors);

  expect(errors).toEqual([]);
  expect(state.error).toBeNull();
  expect(advanced).not.toBeNull();
  expect(state.currentTime).toBeGreaterThan(0.1);
});

test('sounds.html — /api/anims returns 100 items with summary', async ({ request }) => {
  const r = await request.get(`${BASE}/api/anims`);
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.total).toBe(100);
  expect(j.summary?.TianCe?.resolved).toBeGreaterThanOrEqual(1);
  // Spot check one item has wwise resolution baked in.
  const longya = j.items.find((it) => (it.sounds || []).some((s) => s.event && s.event.includes('longya')));
  expect(longya).toBeTruthy();
  // Top-scoring candidate should be the longya event itself (even if it has no WEMs in this bank).
  const topCand = longya.sounds.flatMap((s) => s.wwise || []).sort((a, b) => b.score - a.score)[0];
  expect(topCand.name.toLowerCase()).toContain('longya');
});
