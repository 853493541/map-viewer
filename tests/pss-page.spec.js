// Smoke test for the new PSS-only viewer page (public/pss.html).
//
// The animation player and the PSS page share *one* renderer file
// (public/js/actor-animation-player.js). The PSS page activates a
// dedicated `pss-only` mode via `<body data-page-mode="pss-only">`,
// which:
//   1) Replaces the sidebar with a search box + flat .pss file list.
//   2) Defaults the search to "龙牙" so cold load is useful.
//   3) Auto-clicks the first match so the viewport renders something
//      without manual interaction.
//
// This test verifies all three behaviours, then sanity-checks the
// debug-log copy button — the PSS page's primary inspection surface.

import { test, expect } from '@playwright/test';

test.describe('pss.html (PSS-only viewer)', () => {
  test('loads, defaults search to 龙牙, auto-renders a PSS, debug log + copy work', async ({ page }) => {
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('/pss.html', { waitUntil: 'domcontentloaded' });

    // Body marker that drives the JS into PSS-only mode.
    await expect(page.locator('body')).toHaveAttribute('data-page-mode', 'pss-only');

    // PSS link in the top-bar should be marked current.
    await expect(page.locator('a.gh-link.current[href="pss.html"]')).toHaveCount(1);

    // Sidebar should be replaced by the PSS list UI (the JS swaps it on init).
    const search = page.locator('#pss-search');
    await expect(search).toBeVisible({ timeout: 10_000 });
    await expect(search).toHaveValue('龙牙');

    // List should populate with at least one match.
    const items = page.locator('#pss-list li.item');
    await expect(items.first()).toBeVisible({ timeout: 15_000 });
    expect(await items.count()).toBeGreaterThan(0);

    // First item should auto-activate (initPssOnlyMode does .click() at end).
    await expect(page.locator('#pss-list li.item.active').first()).toBeVisible({ timeout: 30_000 });

    // Renderer status should reflect emitter counts (e.g. "Renderer: 19S 23M 4T | …").
    const statusRenderer = page.locator('#status-renderer');
    await expect(statusRenderer).toHaveText(/Renderer:\s+\d+S\s+\d+M\s+\d+T/, { timeout: 30_000 });

    // The new PSS log panel must be visible by default in PSS-only mode.
    await expect(page.locator('#pss-log-panel')).toBeVisible();

    // It has exactly two tabs: "Things went right" and "Things went wrong".
    await expect(page.locator('#pss-log-panel .pss-log-tab[data-tab="right"]')).toBeVisible();
    await expect(page.locator('#pss-log-panel .pss-log-tab[data-tab="wrong"]')).toBeVisible();

    // Log body should accumulate at least one entry after a PSS loads.
    const logBody = page.locator('#pss-log-panel .pss-log-body .pss-log-row');
    await expect(logBody.first()).toBeVisible({ timeout: 30_000 });

    // Copy button works: click it without throwing.
    const copyBtn = page.locator('#pss-log-copy');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    // No uncaught page errors during the flow.
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  });

  test('search filters the PSS list', async ({ page }) => {
    await page.goto('/pss.html');
    const search = page.locator('#pss-search');
    await expect(search).toBeVisible({ timeout: 10_000 });

    // Wait for the auto-clicked initial load to finish — addPssEffect
    // is CPU-heavy (~2s for the default 龙牙 hit) and would otherwise
    // delay the debounced refresh and API response triggered by the
    // upcoming search fills, exceeding the assertion timeout.
    await expect(
      page.locator('#pss-log-panel .pss-log-row', { hasText: /scene ready/ }).first()
    ).toBeVisible({ timeout: 30_000 });

    // Type an obviously-unmatched query.
    await search.fill('zzz_no_such_pss_token_xyz');
    await expect(page.locator('#pss-list-badge')).toHaveText('0', { timeout: 10_000 });

    // Clear and re-type 龙牙: list should come back populated.
    await search.fill('龙牙');
    const badge = page.locator('#pss-list-badge');
    await expect(badge).not.toHaveText('0', { timeout: 15_000 });
  });
});

test.describe('regression: top-bar PSS link is on every page', () => {
  for (const page_ of [
    'index.html',
    'export-reader.html',
    'mesh-inspector.html',
    'collision-test-mode.html',
    'actor-viewer.html',
    'actor-animation-player.html',
    'pss.html',
  ]) {
    test(`PSS nav link present on ${page_}`, async ({ page }) => {
      await page.goto(`/${page_}`, { waitUntil: 'domcontentloaded' });
      const pssLink = page.locator('a.gh-link[href="pss.html"]');
      await expect(pssLink.first()).toBeVisible();
    });
  }
});

test.describe('regression: server APIs the PSS page depends on', () => {
  test('GET /api/pss/find returns 龙牙 results', async ({ request }) => {
    const r = await request.get('/api/pss/find?q=' + encodeURIComponent('龙牙'));
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const it of body.items) {
      expect(it.fileName.endsWith('.pss')).toBeTruthy();
      expect(typeof it.sourcePath).toBe('string');
    }
  });

  test('GET /api/pss/analyze on first 龙牙 hit returns emitters', async ({ request }) => {
    const find = await (await request.get('/api/pss/find?q=' + encodeURIComponent('龙牙'))).json();
    expect(find.items.length).toBeGreaterThan(0);
    const target = find.items[0].sourcePath;
    const r = await request.get('/api/pss/analyze?sourcePath=' + encodeURIComponent(target));
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.emitters)).toBe(true);
    expect(body.emitters.length).toBeGreaterThan(0);
  });
});
