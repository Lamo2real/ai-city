// Smoke test in a real browser: the City tab loads, HQ is there, clicking an agent opens its panel,
// and when live data is missing the HUD says so instead of showing anything made up.
// Skipped when Google Chrome is not installed.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createCity, loadPolicy } from "city";
import { createCityChat } from "../server/city-chat.js";
import { createServer } from "../server/server.js";
import { citySnapshot } from "./fixtures/city.js";

// Drives the Google Chrome installed on this Mac (no browser download needed).
let chromium = null;
try { ({ chromium } = await import("playwright")); } catch { /* not installed */ }
const CHROME = "/Applications/Google Chrome.app";
const skip = !chromium ? "playwright is not installed" : !existsSync(CHROME) ? "Google Chrome is not installed" : false;

let server, port, browser, city;
before(async () => {
  if (skip) return;
  const dir = mkdtempSync(join(tmpdir(), "jarvis-e2e-"));
  const policy = loadPolicy();
  const runner = async (req) => ({ text: "ok", sessionId: `s-${req.agentId}`, costUsd: 0, tokens: 0 });
  city = createCity({ runner, dataDir: dir, ledgerPath: ":memory:", policy });
  const chat = createCityChat({ city, runner, dataDir: dir });
  server = createServer({ booqyDir: dir, dataDir: dir, port: 0, getState: async () => ({}), chat, speak: async () => null, transcribe: async () => "" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
});
after(async () => { await browser?.close(); server?.close(); city?.close(); });

test("the City tab shows HQ and an agent's panel opens on click", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // A busy city from the test fixture, served as if the backend had sent it.
  await page.route("**/api/city", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(citySnapshot()) }));
  await page.goto(`http://localhost:${port}/`);
  await page.click("#citybtn");
  await page.waitForSelector("#city[data-city-ready='1']", { timeout: 15000 });
  await page.waitForSelector("#citylist button[data-building='HQ']");
  assert.equal(await page.$("#citydemo"), null, "no demo button");
  assert.equal(await page.getAttribute("#cityerror", "hidden"), "", "no error while the backend answers");
  assert.ok((await page.textContent("#citytop")).includes("AGENTS"));
  assert.ok((await page.$$("#citydepts .dept")).length >= 4, "departments listed on the right");
  await page.locator("#citylist button[data-agent='ios-dev']").dispatchEvent("click"); // the keyboard list sits off-screen
  await page.waitForSelector("#citypanel:not([hidden])");
  const panel = await page.textContent("#citypanel");
  assert.ok(panel.includes("iOS Developer") && panel.includes("Sonnet") && panel.includes("App") && panel.includes("app-manager"), panel);
  assert.ok(panel.includes("Build the habit tracker screen"));
  await page.locator("#citylist button[data-building='HQ']").dispatchEvent("click");
  assert.ok((await page.textContent("#citypanel")).includes("Headquarters"));
  await page.keyboard.press("Escape");
  await page.waitForSelector("#citypanel[hidden]", { state: "attached" });
  assert.ok((await page.textContent("#cityinbox")).includes("Daily budget"), "the question waits in the inbox");
  assert.deepEqual(errors, []);
  const fps = Number(await page.getAttribute("#city", "data-fps"));
  assert.ok(Number.isFinite(fps), "the frame loop runs");
  await page.close();
});

test("when the city backend can't be reached, the City view says so and shows no agents", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/api/city", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "the city backend is not running" }) }));
  await page.goto(`http://localhost:${port}/`);
  await page.click("#citybtn");
  await page.waitForSelector("#cityerror:not([hidden])", { timeout: 15000 });
  assert.match(await page.textContent("#cityerror"), /Can't reach Jarvis \(the city backend is not running\)/);
  assert.equal((await page.$$("#citylist button[data-agent]")).length, 0, "no made-up agents");
  await page.close();
});

test("when /state.json fails, Status shows an offline state, never fake data", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/state.json", (r) => r.abort());
  await page.goto(`http://localhost:${port}/`);
  await page.click("#statusbtn");
  await page.waitForSelector("#offline:not([hidden])");
  assert.equal(await page.textContent("#datatag"), "OFFLINE");
  assert.match(await page.textContent("#offline"), /Can't reach Jarvis/);
  assert.equal(await page.textContent("#features"), "unavailable");
  assert.doesNotMatch(await page.content(), /demo/i, "nothing demo on the page");
  await page.close();
});
