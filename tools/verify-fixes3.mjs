import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1600, height: 900 });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto("http://localhost:3015/pss.html", { waitUntil: "networkidle" });
await page.waitForTimeout(8000);
const r = await page.evaluate(() => {
  const out = {};
  out.activeFile = document.querySelector('li.item.active')?.dataset?.sourcePath || null;
  out.tracePanelVisible = !!document.getElementById('trace-panel') &&
    !document.getElementById('trace-panel').classList.contains('hidden');
  const tp = document.getElementById('trace-panel');
  out.tracePanelRect = tp ? tp.getBoundingClientRect() : null;
  const ra = document.getElementById('right-area');
  out.rightAreaRect = ra ? ra.getBoundingClientRect() : null;
  const dbg = window.__pssDebug ? window.__pssDebug() : null;
  if (dbg) {
    out.cameraDist = dbg.orbit?.dist;
    out.cameraTarget = [dbg.orbit?.targetX, dbg.orbit?.targetY, dbg.orbit?.targetZ];
    out.canvas = dbg.canvas;
    out.counts = dbg.counts;
  }
  if (typeof pssLoadTrace !== 'undefined') {
    out.traceErrorCount = pssLoadTrace.filter(r => r.level === 'error' || r.level === 'warn').length;
    out.traceTotalCount = pssLoadTrace.length;
  }
  return out;
});
console.log(JSON.stringify({ errs, ...r }, null, 2));
await page.screenshot({ path: "tools/pss-after-fix-l.png", fullPage: false });
await browser.close();
