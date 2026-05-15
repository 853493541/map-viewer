import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1600, height: 900 });
await page.goto("http://localhost:3015/pss.html", { waitUntil: "networkidle" });
await page.waitForTimeout(15000);
const r = await page.evaluate(() => {
  const out = {};
  const dbg = window.__pssDebug ? window.__pssDebug() : null;
  out.dbg = dbg;
  // Read trace panel DOM (All Steps tab)
  const allBtn = document.querySelector('[data-trace-tab="all"]');
  if (allBtn) allBtn.click();
  out.traceText = document.getElementById('trace-body')?.innerText || null;
  return out;
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
