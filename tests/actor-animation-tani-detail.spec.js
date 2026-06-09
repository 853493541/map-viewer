import { test, expect } from '@playwright/test';

test.describe('actor-animation-player TANI detail modal', () => {
  test('right-clicking a TANI catalog row opens parsed TANI and PSS detail', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/actor-animation-player.html', { waitUntil: 'domcontentloaded' });

    await page.locator('.sidebar-tab[data-tab="tab-tani-catalog"]').click();
    const search = page.locator('#tani-search');
    await expect(search).toBeVisible({ timeout: 15_000 });
    await search.fill('龙牙');

    const firstTani = page.locator('#tani-list li.is-tani').first();
    await expect(firstTani).toBeVisible({ timeout: 20_000 });
    await firstTani.click({ button: 'right' });

    const menu = page.locator('#tani-context-menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('button', { name: 'Show detail' }).click();

    const modal = page.locator('#tani-detail-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#tani-detail-body')).toContainText('Referenced PSS Files', { timeout: 60_000 });
    await expect(modal.locator('summary', { hasText: '.pss' }).first()).toBeVisible({ timeout: 60_000 });
    await expect(modal.locator('summary', { hasText: 'Full PSS Parse JSON' }).first()).toBeVisible();
    await expect(modal.locator('summary', { hasText: '32-bit Word Table' })).toBeVisible();
    await expect(modal.locator('summary', { hasText: 'Full TANI Hex Dump' })).toBeVisible();

    const detail = await page.evaluate(async () => {
      const sourcePath = 'data/source/player/f1/动作/F1s04tc技能13_龙牙8尺HD_AOE.tani';
      const response = await fetch(`/api/player-anim/tani-parse?detail=1&path=${encodeURIComponent(sourcePath)}`);
      return response.json();
    });
    const readableTexts = detail.detail.strings.map((row) => row.text);
    const lengthPrefixedTexts = detail.detail.lengthPrefixedStrings.map((row) => row.text);
    expect(readableTexts).toContain('data\\source\\other\\hd特效\\技能\\pss\\发招\\t_天策尖刺02.pss');
    expect(readableTexts).not.toContain('her\\hd特效\\技能\\pss\\发招\\t_天策尖刺02.pss');
    expect(readableTexts).not.toContain('f2s04tcJiNeng13_LongYa8Chihd');
    expect(lengthPrefixedTexts).not.toContain('f2s04tcJi');
    expect(readableTexts.join('\n')).not.toMatch(/[疊呅媚吙圚檇]/u);

    expect(pageErrors).toEqual([]);
  });
});
