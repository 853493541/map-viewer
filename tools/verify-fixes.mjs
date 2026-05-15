import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1600, height: 900 });
const consoleMsgs = [];
page.on('console', m => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => consoleMsgs.push(`[pageerror] ${e.message}`));
const url = "http://localhost:3015/pss.html?pss=" + encodeURIComponent("data/source/other/HD特效/技能/Pss/发招/T_天策龙牙.pss");
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(7000);

const result = await page.evaluate(() => {
  const out = { errors: [], traceErrorRows: 0, traceAllRows: 0 };
  // Count mesh-error rows in pssLoadTrace
  if (typeof pssLoadTrace !== 'undefined') {
    out.traceAllRows = pssLoadTrace.length;
    out.traceErrorRows = pssLoadTrace.filter(r => r.level === 'error' || r.level === 'warn').length;
    out.meshErrorSteps = pssLoadTrace.filter(r => r.step === 'mesh-error').map(r => r.detail);
    out.ribbonSkipSteps = pssLoadTrace.filter(r => r.detail && r.detail.includes && r.detail.includes('ribbon-mesh')).length;
  }
  // Camera & scene size
  if (typeof camera !== 'undefined' && typeof controls !== 'undefined' && typeof scene !== 'undefined') {
    out.camPos = camera.position.toArray().map(v=>+v.toFixed(2));
    out.target = controls.target.toArray().map(v=>+v.toFixed(2));
    out.distance = +camera.position.distanceTo(controls.target).toFixed(2);
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    out.sceneSize = size.toArray().map(v=>+v.toFixed(2));
    out.sceneCenter = center.toArray().map(v=>+v.toFixed(2));
    out.sceneMin = box.min.toArray().map(v=>+v.toFixed(2));
    out.sceneMax = box.max.toArray().map(v=>+v.toFixed(2));
  }
  // Inventory
  if (typeof window.__pssRuntimeSnapshot === 'function') {
    const snap = window.__pssRuntimeSnapshot();
    out.counts = snap.counts;
  }
  // Verify removed buttons are gone
  out.btnDebugExists = !!document.getElementById('btn-debug');
  out.btnIssuesExists = !!document.getElementById('btn-issues');
  out.btnTraceExists = !!document.getElementById('btn-trace');
  return out;
});
console.log(JSON.stringify(result, null, 2));
await page.screenshot({ path: "tools/pss-after-fix-k.png", fullPage: false });
await browser.close();
