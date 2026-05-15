import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1600, height: 900 });
await page.goto("http://localhost:3015/pss.html", { waitUntil: "networkidle" });
await page.waitForTimeout(5000);
// Move timeline to a later moment to see effects
await page.evaluate(() => {
  const sc = document.getElementById('tl-scrubber');
  if (sc) {
    sc.value = 6500;
    sc.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
await page.waitForTimeout(2000);
await page.screenshot({ path: "tools/pss-final.png", fullPage: false });
await browser.close();
