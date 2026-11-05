// Renders jarvis/app/icon.svg to a PNG with the installed Chrome. Run it only when the icon changes; the PNGs are committed.
// Usage: node scripts/make-icon.js <size> <out.png>
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const [size, out] = [Number(process.argv[2]), process.argv[3]];
const svg = readFileSync(new URL("../app/icon.svg", import.meta.url), "utf8").replace("<svg ", `<svg width="${size}" height="${size}" `);
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: size, height: size } });
await page.setContent(`<!doctype html><body style="margin:0;background:transparent">${svg}</body>`);
await page.screenshot({ path: out, omitBackground: true });
await browser.close();
