import { chromium } from "playwright";
import fs from "node:fs";
const which = process.argv[2] || "baseline";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1600, height: 900 });
const logs = [];
page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
await page.goto("http://localhost:3015/pss.html", { waitUntil: "networkidle" });
await page.waitForTimeout(6000);
// Set timeline to mid-life so curves have a non-zero value.
await page.evaluate(() => {
  const sc = document.getElementById("tl-scrubber");
  if (sc) {
    sc.value = 4000;
    sc.dispatchEvent(new Event("input", { bubbles: true }));
  }
});
await page.waitForTimeout(1500);

// Snapshot inventory + per-emitter runtime state.
const snap = await page.evaluate(() => {
  const inv = (typeof window.__pssEmitterInventory === 'function') ? window.__pssEmitterInventory() : null;
  const rt = (typeof window.__pssRuntimeSnapshot === 'function') ? window.__pssRuntimeSnapshot() : null;
  const sprites = (inv?.sprites || []).map((s) => ({
    idx: s.runtimeIndex,
    src: (s.sourcePath || '').split('/').pop(),
    visible: s.visible,
    worldBoxSize: s.worldBoxSize,
    aliveParticles: s.aliveParticles,
    layerCount: s.layerCount,
    repColor: s.layers?.[0]?.materialColor,
    repOpacity: s.layers?.[0]?.materialOpacity,
    sizeCurveAuthored: s.sizeCurveAuthored,
    authoredSizeCurve: s.authoredSizeCurve,
    authoredAlphaCurve: s.authoredAlphaCurve,
    curveInfoKeys: s.curveInfoKeys,
  }));
  return {
    counts: rt?.counts || null,
    timeline: rt?.timeline || null,
    sprites,
  };
});
fs.mkdirSync("tools/snap", { recursive: true });
fs.writeFileSync(`tools/snap/${which}.json`, JSON.stringify(snap, null, 2));
await page.screenshot({ path: `tools/snap/${which}.png`, fullPage: false });
console.log(JSON.stringify(snap, null, 2));
await browser.close();
