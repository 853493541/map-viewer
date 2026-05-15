import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1600, height: 900 });
const errs = [], logs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
await page.goto("http://localhost:3015/pss.html", { waitUntil: "networkidle" });
await page.waitForTimeout(15000);
const r = await page.evaluate(() => {
  const out = {};
  const dbg = window.__pssDebug ? window.__pssDebug() : null;
  if (dbg) out.counts = dbg.counts;
  if (typeof pssLoadTrace !== 'undefined') {
    out.trace = pssLoadTrace.map(r => `[+${r.dt}ms] ${r.level} ${r.step} :: ${r.detail || ''}`);
  }
  return out;
});
console.log(JSON.stringify({ errs, logs, ...r }, null, 2));
await browser.close();
