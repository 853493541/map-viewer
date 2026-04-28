import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1600, height: 900 });
const errs = [];
page.on("pageerror", e => errs.push("ERR: " + e.message));
page.on("console", m => { if (m.type() === "error") errs.push("CON: " + m.text()); });
await page.goto("http://localhost:3015/pss.html", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
// open trace panel
await page.click("#btn-trace");
await page.waitForTimeout(300);
// search for and click a pss
await page.fill("#pss-search", "T_天策龙牙");
await page.waitForTimeout(800);
const items = await page.$$("#pss-list li.item");
console.log("items:", items.length);
if (items.length) await items[0].click();
await page.waitForTimeout(5000);
const traceTextErrors = await page.$eval("#trace-body", e => e.innerText);
console.log("--- trace-body (errors tab) ---");
console.log(traceTextErrors.slice(0, 1500));
// switch to All Steps
await page.click("[data-trace-tab='all']");
await page.waitForTimeout(300);
const traceTextAll = await page.$eval("#trace-body", e => e.innerText);
console.log("--- trace-body (all steps tab) line count:", traceTextAll.split("\n").length);
console.log(traceTextAll.slice(0, 3500));
await page.screenshot({ path: "tools/pss-trace-panel.png" });
console.log("errs:", errs.length, errs.slice(0,5));
await browser.close();
