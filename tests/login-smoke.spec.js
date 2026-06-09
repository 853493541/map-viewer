import { test, expect } from '@playwright/test';

test.describe('zhenchuan.renstoolbox.com login smoke', () => {
  test('fills login form with dummy credentials and submits', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('https://zhenchuan.renstoolbox.com', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    await expect(page.locator('body')).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: 'test-results/login-page.png', fullPage: true });

    const account = page.getByPlaceholder(/account|用户名|账号|email/i).first()
      .or(page.locator('input[type="text"]').first())
      .or(page.locator('input:not([type="hidden"])').first());
    await account.waitFor({ state: 'visible', timeout: 10_000 });
    await account.fill('testuser_xyz');

    const password = page.getByPlaceholder(/password|密码/i).first()
      .or(page.locator('input[type="password"]').first());
    await password.fill('wrong_password_123');

    const submit = page.getByRole('button').first()
      .or(page.locator('button[type="submit"]').first())
      .or(page.locator('input[type="submit"]').first());
    await submit.click();
    await page.waitForTimeout(2000);
  });
});
