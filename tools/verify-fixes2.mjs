import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1600, height: 900 });
const url = "http://localhost:3015/pss.html?pss=" + encodeURIComponent("data/source/other/HD特效/技能/Pss/发招/T_天策龙牙.pss");
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(7000);
const r = await page.evaluate(() => {
  const dbg = window.__pssDebug ? window.__pssDebug() : null;
  // Total scene bbox via three (use eval to find scene from window or via dbg already)
  let sceneBox = null;
  if (window.THREE && window.__threeScene) {
    const s = window.__threeScene;
    const box = new THREE.Box3().setFromObject(s);
    const size = new THREE.Vector3(); box.getSize(size);
    sceneBox = {
      min: box.min.toArray().map(v=>+v.toFixed(2)),
      max: box.max.toArray().map(v=>+v.toFixed(2)),
      size: size.toArray().map(v=>+v.toFixed(2)),
    };
  }
  return { dbg, sceneBox };
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
