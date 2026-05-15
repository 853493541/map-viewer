import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1600, height: 900 });
const url = "http://localhost:3015/pss.html?pss=" + encodeURIComponent("data/source/other/HD特效/技能/Pss/发招/T_天策龙牙.pss");
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(6000);
const cam = await page.evaluate(() => {
  if (typeof camera !== "undefined" && typeof controls !== "undefined") {
    return { camPos: camera.position.toArray().map(v=>+v.toFixed(2)), target: controls.target.toArray().map(v=>+v.toFixed(2)), distance: camera.position.distanceTo(controls.target).toFixed(2) };
  }
  return null;
});
console.log("cam:", JSON.stringify(cam));
await page.screenshot({ path: "tools/pss-after-skip.png", fullPage: false });
await browser.close();
