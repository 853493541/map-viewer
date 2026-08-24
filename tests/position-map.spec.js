import { test, expect } from '@playwright/test';

test('position map page loads, renders layers, toggles, and marks', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/position-map.html');
  await page.waitForTimeout(4000);

  for (const id of ['ly-entities', 'ly-npcs', 'ly-containers', 'ly-doodads', 'ly-doodadpos', 'ly-marks']) {
    await expect(page.locator('#' + id)).toBeVisible();
  }

  for (const [id, min] of [['c-entities', 4800], ['c-npcs', 1200], ['c-containers', 450], ['c-doodads', 140], ['c-doodadpos', 140]]) {
    const txt = await page.locator('#' + id).textContent();
    const n = Number(txt.replace(/[^\d]/g, ''));
    expect(n).toBeGreaterThan(min);
  }

  const wrap = page.locator('#map-wrap');
  const box = await wrap.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await page.click('#mode-mark');
  page.once('dialog', (d) => d.accept('TestMark'));
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);

  await page.waitForTimeout(500);
  const marks = await page.locator('.mark-row').count();
  expect(marks).toBeGreaterThanOrEqual(1);

  page.once('dialog', (d) => d.accept());
  await page.click('#clear-marks');
  await page.waitForTimeout(300);

  expect(errors.filter((e) => !e.includes('favicon') && !e.includes('map.png'))).toEqual([]);
});
