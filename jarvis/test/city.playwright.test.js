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
import { cityBusy, cityEmpty, cityCosts, cityHealth, cityIntegrations, cityParked, citySnapshot, cityTrace, cityWorkforce } from "./fixtures/city.js";

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
  browser = await chromium.launch({ channel: "chrome", headless: true });
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
  assert.match(await page.textContent("#cityinbox"), /1 waiting/, "the corner summarises what waits");
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

test("a dropped live stream is shown, and on reconnect the error clears and the snapshot reloads", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // A controllable stand-in for EventSource: the test fires error and open itself.
  await page.addInitScript(() => {
    window.__streams = [];
    window.EventSource = class { constructor(url) { this.url = url; window.__streams.push(this); } close() { this.closed = true; } };
  });
  let snapshots = 0;
  await page.route("**/api/city", (r) => { snapshots++; return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(citySnapshot()) }); });
  await page.goto(`http://localhost:${port}/`);
  await page.click("#citybtn");
  await page.waitForSelector("#citylist button[data-building='HQ']", { state: "attached", timeout: 15000 });
  const cityStream = () => page.evaluate(() => window.__streams.filter((s) => !s.closed && typeof s.onopen === "function").length);
  await page.waitForFunction(() => window.__streams.some((s) => typeof s.onopen === "function"));
  const base = snapshots; // the board and the inbox share one snapshot request, the city loads its own
  assert.equal(base, 2);
  // An open with no drop before it changes nothing.
  await page.evaluate(() => window.__streams.findLast((s) => s.onopen).onopen());
  assert.equal(snapshots, base, "no reload without a drop");
  await page.evaluate(() => window.__streams.findLast((s) => s.onerror).onerror());
  await page.waitForSelector("#cityerror:not([hidden])");
  assert.match(await page.textContent("#cityerror"), /Live updates from Jarvis stopped/);
  await page.evaluate(() => window.__streams.findLast((s) => s.onopen).onopen());
  await page.waitForFunction(() => document.querySelector("#cityerror").hidden);
  await page.waitForFunction(() => window.__streams.filter((s) => !s.closed && s.onopen).length === 1);
  assert.equal(snapshots, base + 1, "one fresh snapshot after the reconnect");
  // The new stream opening does not loop into another reload.
  await page.evaluate(() => window.__streams.findLast((s) => s.onopen).onopen());
  assert.equal(snapshots, base + 1);
  assert.equal(await cityStream(), 1);
  assert.equal(await page.evaluate(() => window.__streams.length), 1, "one EventSource for the whole page, never reopened");
  await page.close();
});

test("when /state.json fails, Status shows an offline state, never fake data", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/state.json", (r) => r.abort());
  await page.goto(`http://localhost:${port}/`);
  await page.click("#statusbtn");
  await page.click("#tab-booqy"); // the Booqy dashboard is the second tab now
  await page.waitForSelector("#offline:not([hidden])");
  assert.equal(await page.textContent("#datatag"), "OFFLINE");
  assert.match(await page.textContent("#offline"), /Can't reach Jarvis/);
  assert.equal(await page.textContent("#features"), "unavailable");
  assert.doesNotMatch(await page.content(), /demo/i, "nothing demo on the page");
  await page.close();
});

// ---- Needs you ----
const SHOTS = process.env.JARVIS_SHOTS_DIR ?? mkdtempSync(join(tmpdir(), "jarvis-shots-")); // never the owner's ~/.jarvis
const jsonRoute = (page, snap = citySnapshot()) => page.route("**/api/city", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snap) }));
const CONFIRM = { id: "c-fx1", repo: "booqy/app", number: 42, title: "Fix the habit screen", url: "https://github.com/booqy/app/pull/42", ci: "all passed", mergeable: "MERGEABLE", expiresInMs: 120000 };
const streamDone = (page, confirm) => page.route("**/api/chat/stream", (r) => r.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "done", reply: "Ready to merge.", confirm }) + "\n" }));
async function ask(page, text = "merge it") { await page.fill("#say", text); await page.press("#say", "Enter"); }

test("Needs you: the dock badge counts, and the inbox lists the question with one button per option", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await jsonRoute(page);
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => document.querySelector("#inboxcnt")?.textContent === "1" && !document.querySelector("#inboxcnt").hidden);
  assert.match(await page.getAttribute("#inboxbtn", "aria-label"), /1 waiting/);
  await page.click("#inboxbtn");
  await page.waitForSelector("body.view-inbox #inbox form.q");
  const card = page.locator("#inbox form.q");
  assert.ok((await card.textContent()).includes("Marketing Manager › Ads Writer"));
  assert.ok((await card.textContent()).includes("Daily budget: 20 or 40 euro?"));
  assert.deepEqual(await card.locator(".opts button").allTextContents(), ["20 (default)", "40"]);
  assert.equal(await page.getAttribute("#inboxlist", "aria-live"), "polite");
  for (const b of await page.locator("#inbox button:visible").all()) assert.ok((await b.boundingBox()).height >= 39.5, "touch targets are at least 40px");
  await page.screenshot({ path: join(SHOTS, "phaseB-desktop.png") });
  await page.close();
});

test("Needs you: an option click posts exactly {id, text}; an empty free text cannot be sent", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await jsonRoute(page);
  const posts = [];
  await page.route("**/api/city/answer", (r) => { posts.push(r.request().postDataJSON()); return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }); });
  await page.goto(`http://localhost:${port}/`);
  await page.click("#inboxbtn");
  await page.waitForSelector("#inbox form.q");
  const send = page.locator("#inbox form.q button[type=submit]");
  assert.ok(await send.isDisabled(), "Send is disabled while the text is empty");
  await page.fill("#inbox form.q input", "   ");
  assert.ok(await send.isDisabled(), "blank text cannot be sent");
  await page.press("#inbox form.q input", "Enter");
  await page.waitForTimeout(150);
  assert.deepEqual(posts, [], "nothing is sent without a click on something with content");
  await page.click("#inbox form.q .opts button[data-option='40']");
  await page.waitForFunction(() => document.querySelector("#inbox .q .note").textContent === "Sent.");
  assert.deepEqual(posts, [{ id: "q-fx1", text: "40" }]);
  assert.ok(await page.locator("#inbox .opts button").first().isDisabled(), "one answer, one POST");
  await page.close();
});

test("Needs you: free text posts {id, text} on Send", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await jsonRoute(page);
  const posts = [];
  await page.route("**/api/city/answer", (r) => { posts.push(r.request().postDataJSON()); return r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
  await page.goto(`http://localhost:${port}/`);
  await page.click("#inboxbtn");
  await page.fill("#inbox form.q input", "30 euro");
  await page.click("#inbox form.q button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#inbox .q .note").textContent === "Sent.");
  assert.deepEqual(posts, [{ id: "q-fx1", text: "30 euro" }]);
  await page.close();
});

test("Needs you opens from the City view, whose corner shows a summary instead of a form", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await jsonRoute(page);
  await page.goto(`http://localhost:${port}/?view=city`);
  await page.waitForSelector("#city[data-city-ready='1']", { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector("#citysum").textContent === "1 waiting");
  assert.ok(await page.isVisible("#inboxbtn"), "the dock is visible in the City view");
  assert.equal(await page.$("#cityinbox input"), null, "no silent-default form in the corner");
  await page.click("#cityopeninbox");
  await page.waitForSelector("body.view-inbox #inbox form.q");
  await page.click("#citybtn");
  await page.waitForSelector("body.view-city");
  await page.click("#inboxbtn");
  await page.waitForSelector("body.view-inbox #inbox form.q");
  await page.close();
});

test("Needs you: a merge confirmation opens the inbox, CANCEL posts {sessionId, id, action}, and chat only gets a pointer", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await jsonRoute(page);
  await streamDone(page, CONFIRM);
  const posts = [];
  await page.route("**/api/confirm", (r) => { posts.push(r.request().postDataJSON()); return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ reply: "Cancelled. Nothing was merged." }) }); });
  await page.goto(`http://localhost:${port}/`);
  await page.click("#chatbtn");
  await ask(page);
  await page.waitForSelector("body.view-inbox #inboxmerge [role=alertdialog]");
  const card = page.locator("#inboxmerge .confirm");
  assert.ok((await card.textContent()).includes("app#42") && (await card.textContent()).includes("Fix the habit screen"));
  assert.equal(await card.locator("a").getAttribute("href"), CONFIRM.url);
  assert.deepEqual(await card.locator("button").allTextContents(), ["MERGE", "CANCEL"]);
  assert.match(await card.textContent(), /Or say exactly "I confirm"\. Expires in \d+ s/);
  assert.equal(await page.locator("#log .confirm").count(), 0, "the card is not in the chat log");
  assert.ok((await page.textContent("#log")).includes("Merge confirmation waiting in Needs you."));
  assert.match(await page.getAttribute("#inboxbtn", "aria-label"), /2 waiting/, "the merge and the question");
  await page.screenshot({ path: join(SHOTS, "phaseB-merge-desktop.png") });
  await page.click("#inboxmerge button:text-is('CANCEL')");
  await page.waitForFunction(() => document.querySelector("#inboxmerge").children.length === 0);
  assert.equal(posts.length, 1);
  assert.equal(Object.keys(posts[0]).includes("sessionId") && posts[0].id === "c-fx1" && posts[0].action === "cancel", true);
  assert.match(await page.textContent("#inboxnote"), /Nothing was merged/);
  await page.close();
});

test("Needs you: MERGE is disarmed for ~800 ms after the card appears, so an immediate click does not merge", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await jsonRoute(page);
  await streamDone(page, CONFIRM);
  const posts = [];
  await page.route("**/api/confirm", (r) => { posts.push(r.request().postDataJSON()); return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ reply: "Merged (test double)." }) }); });
  await page.goto(`http://localhost:${port}/`);
  await page.click("#chatbtn");
  await ask(page);
  // Click the instant the card exists, from inside the page, before anything can re-enable it.
  await page.waitForFunction(() => {
    const go = [...document.querySelectorAll("#inboxmerge .confirm button")].find((b) => b.textContent === "MERGE");
    if (!go) return false;
    window.__armedAtArrival = !go.disabled;
    go.click();
    return true;
  }, null, { polling: "raf" });
  assert.equal(await page.evaluate(() => window.__armedAtArrival), false, "MERGE starts disabled");
  await page.waitForTimeout(300);
  assert.deepEqual(posts.filter((p) => p.action === "merge"), [], "an immediate click posts no merge");
  assert.equal(await page.locator("#inboxmerge .confirm").count(), 1, "the card is still waiting");
  await page.waitForFunction(() => [...document.querySelectorAll("#inboxmerge .confirm button")].find((b) => b.textContent === "MERGE")?.disabled === false, null, { timeout: 3000 });
  await page.click("#inboxmerge button:text-is('MERGE')");
  await page.waitForFunction(() => document.querySelector("#inboxmerge").children.length === 0);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].action, "merge", "once armed, an explicit click posts the merge (to the intercepted route)");
  await page.close();
});

test("Needs you: an expired merge says so honestly and leaves the list", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await jsonRoute(page);
  await streamDone(page, { ...CONFIRM, expiresInMs: 1500 });
  await page.route("**/api/confirm", (r) => r.abort());
  await page.goto(`http://localhost:${port}/`);
  await page.click("#chatbtn");
  await ask(page);
  await page.waitForSelector("#inboxmerge .confirm");
  await page.waitForFunction(() => document.querySelector("#inboxmerge").children.length === 0, null, { timeout: 8000 });
  assert.equal(await page.textContent("#inboxnote"), "Expired. Nothing was merged. Ask Jarvis again if you still want it.");
  await page.close();
});

test("Needs you: mobile layout with the fixture data", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await jsonRoute(page);
  await page.goto(`http://localhost:${port}/`);
  await page.click("#inboxbtn");
  await page.waitForSelector("#inbox form.q");
  await page.screenshot({ path: join(SHOTS, "phaseB-mobile.png") });
  await page.close();
});

// ---- Status board ----
const HOUR = 3600 * 1000;
const boardSnap = () => { const s = citySnapshot(); s.spend = { App: 0.91, Marketing: 7.5 }; s.tickets.find((t) => t.id === "t-fx1").updated_at = new Date(Date.now() - 3 * HOUR).toISOString(); return s; };

test("Status opens on the AI City board: limits with a department over cap in red, usage with tokens first", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await jsonRoute(page, boardSnap());
  await page.goto(`http://localhost:${port}/`);
  await page.click("#statusbtn");
  await page.waitForSelector("#ailimits .dept.over");
  assert.equal(await page.getAttribute("#tab-aicity", "aria-selected"), "true");
  assert.ok(await page.isHidden("#booqytab"));
  const limitsText = await page.textContent("#ailimits");
  assert.match(limitsText, /AGENTS ACTIVE \(no total cap; per department below\)\s*9 active/);
  assert.match(limitsText, /AGENTS PER DEPARTMENT/);
  assert.match(limitsText, /App\s*3 \/ 5/);
  assert.match(limitsText, /WORKERS PER MANAGER \(MOST\)\s*2 \/ 4/);
  assert.match(limitsText, /31 turns · 184,200 tokens/);
  assert.match(limitsText, /est\. \$1\.73 \(API list price, not a charge\)/);
  assert.ok(limitsText.indexOf("tokens") < limitsText.indexOf("est. $1.73"), "tokens and turns come before dollars");
  assert.match(limitsText, /Estimated value at API list prices\. On the Claude subscription this is not a charge\./);
  const over = page.locator("#ailimits .dept.over");
  assert.equal(await over.count(), 1);
  assert.match(await over.textContent(), /Marketing.*OVER CAP.*est\. \$7\.50/);
  assert.equal(await over.locator(".amt").evaluate((e) => getComputedStyle(e).color), "rgb(255, 59, 46)", "red");
  assert.equal(await page.locator("#ailimits .dept:not(.over)").count(), 1);
  // Agents: retired hidden, core grouped, goal truncated with a title.
  const ios = page.locator("#aiagents [data-agent='ios-dev']");
  assert.match(await ios.textContent(), /iOS Developer.*active.*Sonnet · App/);
  assert.equal(await ios.locator(".goal").getAttribute("title"), "Build the habit tracker screen");
  assert.equal(await page.locator("#aiagents .core [data-agent]").count(), 4);
  await page.screenshot({ path: join(SHOTS, "phaseC-status-desktop.png") });
  await page.close();
});

test("Status board: tickets are grouped by status with age, and only the old one is tagged stale", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await jsonRoute(page, boardSnap());
  await page.goto(`http://localhost:${port}/`);
  await page.click("#statusbtn");
  await page.waitForSelector("#aitickets .grp");
  assert.deepEqual(await page.locator("#aitickets h4").allTextContents(), ["In progress (3)", "In review (1)", "Waiting on you (1)"]);
  assert.equal(await page.locator("#aitickets .tag.stale").count(), 1);
  assert.equal(await page.locator("#aitickets [data-ticket='t-fx1'] .tag.stale").count(), 1);
  assert.match(await page.textContent("#aitickets [data-ticket='t-fx2']"), /qa-tester.*(<1 min|\d+ min).*Run the simulator tests/);
  await page.close();
});

test("the Booqy dashboard is still there behind its tab and renders state.json", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await jsonRoute(page);
  await page.route("**/state.json", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ generatedAt: new Date().toISOString(), features: [{ id: "F1", name: "Gift cards", status: "production" }], prs: [], ci: [], actions: [], log: [] }) }));
  await page.goto(`http://localhost:${port}/`);
  await page.click("#statusbtn");
  await page.click("#tab-booqy");
  assert.ok(await page.isVisible("#features"));
  await page.waitForFunction(() => document.querySelector("#features").textContent.includes("Gift cards"));
  assert.ok(await page.isHidden("#aicity"));
  assert.equal(await page.getAttribute("#tab-booqy", "aria-selected"), "true");
  await page.click("#tab-aicity");
  assert.ok(await page.isVisible("#ailimits"));
  await page.close();
});

test("the page opens exactly one /api/events stream, even after the City view mounts", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await jsonRoute(page);
  let streams = 0;
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/events") streams++; });
  await page.goto(`http://localhost:${port}/`);
  await page.click("#citybtn");
  await page.waitForSelector("#city[data-city-ready='1']", { timeout: 15000 });
  await page.click("#inboxbtn");
  await page.click("#statusbtn");
  await page.waitForTimeout(500);
  assert.equal(streams, 1);
  await page.close();
});

test("a pending merge found by GET /api/confirm/pending shows in Needs you with MERGE disarmed, no chat turn needed", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await jsonRoute(page);
  const reads = [];
  await page.route("**/api/confirm/pending**", (r) => { reads.push(r.request().url()); return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ confirm: CONFIRM }) }); });
  await page.route("**/api/chat**", (r) => r.abort());
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector("body.view-inbox #inboxmerge [role=alertdialog]");
  assert.match(reads[0], /sessionId=owner/);
  assert.ok(await page.locator("#inboxmerge button.go").isDisabled(), "MERGE is disarmed at first");
  await page.waitForFunction(() => !document.querySelector("#inboxmerge button.go").disabled, null, { timeout: 3000 });
  assert.deepEqual(await page.locator("#inboxmerge button").allTextContents(), ["MERGE", "CANCEL"]);
  // The same id does not re-render the card on the next read.
  await page.evaluate(() => { window.__card = document.querySelector("#inboxmerge .confirm"); window.dispatchEvent(new Event("focus")); });
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => window.__card === document.querySelector("#inboxmerge .confirm")), "same card");
  await page.waitForFunction(() => /2 waiting/.test(document.querySelector("#inboxbtn").getAttribute("aria-label")));
  await page.close();
});

test("a pending merge that is gone clears its card", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await jsonRoute(page);
  let gone = false;
  await page.route("**/api/confirm/pending**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ confirm: gone ? null : CONFIRM }) }));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector("#inboxmerge .confirm");
  gone = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => document.querySelector("#inboxmerge").children.length === 0);
  assert.equal(await page.textContent("#inboxnote"), "Resolved elsewhere or expired. Nothing was merged here.");
  await page.close();
});

test("Status on a phone: the board stacks under the core", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await jsonRoute(page, boardSnap());
  await page.goto(`http://localhost:${port}/`);
  await page.click("#statusbtn");
  await page.waitForSelector("#ailimits .dept.over");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll");
  await page.screenshot({ path: join(SHOTS, "phaseC-status-mobile.png") });
  await page.close();
});

// ---- Old server (no Jarvis restart yet): the HUD degrades honestly ----
test("old server: a 404 on the pending GET is silent, polling stops, and the chat path still shows a merge", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await jsonRoute(page);
  let reads = 0;
  await page.route("**/api/confirm/pending**", (r) => { reads++; return r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }); });
  await streamDone(page, CONFIRM);
  await page.clock.install();
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => document.querySelector("#inboxcnt")?.textContent === "1");
  assert.equal(reads, 1, "one read on load");
  await page.clock.fastForward(60_000); // twelve 5 s ticks
  await page.waitForTimeout(200);
  assert.equal(reads, 1, "no polling after the 404");
  assert.equal(await page.locator('#city [role=alert]:not([hidden]), #inbox .err:not([hidden]), #aierr:not([hidden])').count(), 0, "no error banner");
  assert.ok(!(await page.textContent("body")).match(/not found/i), "the 404 is not shown anywhere");
  // One attempt per focus, and it stays quiet when it fails again.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(200);
  assert.equal(reads, 2);
  await page.clock.fastForward(30_000);
  assert.equal(reads, 2);
  // The chat-driven merge confirmation still works.
  await page.click("#chatbtn");
  await ask(page);
  await page.waitForSelector("body.view-inbox #inboxmerge [role=alertdialog]");
  assert.deepEqual(await page.locator("#inboxmerge button").allTextContents(), ["MERGE", "CANCEL"]);
  await page.close();
});

test("old server: a snapshot without caps shows plain values and 'cap: unknown until Jarvis restarts', never a number", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const snap = citySnapshot(); delete snap.caps; snap.spend = { App: 456.73 };
  await jsonRoute(page, snap);
  await page.goto(`http://localhost:${port}/`);
  await page.click("#statusbtn");
  await page.waitForSelector("#ailimits .dept");
  const text = await page.textContent("#ailimits");
  assert.match(text, /AGENTS ACTIVE\s*9 active/);
  assert.match(text, /est\. \$456\.73 today/);
  assert.match(text, /cap: unknown until Jarvis restarts/);
  assert.doesNotMatch(text, /\d+ \/ \d+|OVER CAP/, "no invented cap, no over-cap");
  assert.equal(await page.locator("#ailimits .dept .bar").count(), 0, "no bar without a cap");
  assert.equal(await page.locator("#ailimits .dept.over").count(), 0);
  await page.screenshot({ path: join(SHOTS, "phaseC-status-nocaps.png") });
  await page.close();
});

// ---- Navigation and mobile ----
const SIZES = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const VIEWS = { home: "", chat: "#chatbtn", status: "#statusbtn", inbox: "#inboxbtn", city: "#citybtn" };
async function openView(page, name) {
  if (VIEWS[name]) await page.click(VIEWS[name]);
  if (name === "city") await page.waitForSelector("#city[data-city-ready='1']", { timeout: 15000 });
  if (name === "status") await page.waitForSelector("body.view-status #status");
  if (name === "inbox") await page.waitForSelector("#inbox form.q");
  await page.waitForTimeout(250);
}
const viewName = (page) => page.evaluate(() => [...document.body.classList].find((c) => c.startsWith("view-"))?.slice(5) ?? "home");

test("walk: screenshots of every view at both sizes (before/after the nav work: NAV_SHOT=before)", { skip }, async () => {
  const prefix = process.env.NAV_SHOT ?? "after";
  for (const [size, viewport] of Object.entries(SIZES)) {
    for (const name of Object.keys(VIEWS)) {
      const page = await browser.newPage({ viewport });
      await jsonRoute(page);
      await page.goto(`http://localhost:${port}/`);
      await openView(page, name);
      await page.screenshot({ path: join(SHOTS, `nav-${prefix}-${size}-${name}.png`) });
      await page.close();
    }
  }
});

const overflow = (page) => page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, wide: [...document.querySelectorAll("body *")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && e.checkVisibility?.() && (r.right > innerWidth + 1 || r.left < -1) && !e.closest("#citytop,#citydepts,.srlist,canvas,.scan,.vignette,svg,#wave"); }).map((e) => `${e.tagName}#${e.id}.${e.className}`).slice(0, 5) }));

test("phone: no sideways scroll in any view, and the dock is visible and reachable in every one", { skip }, async () => {
  for (const name of Object.keys(VIEWS)) {
    const page = await browser.newPage({ viewport: SIZES.mobile });
    await jsonRoute(page);
    await page.goto(`http://localhost:${port}/`);
    await openView(page, name);
    const o = await overflow(page);
    assert.ok(o.scroll <= 390, `${name}: scrollWidth ${o.scroll}`);
    assert.deepEqual(o.wide, [], `${name}: nothing sticks out of the screen`);
    for (const id of ["chatbtn", "citybtn", "inboxbtn", "statusbtn", "mic"]) {
      const box = await page.locator(`#dock #${id}`).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, `${name}: ${id} is on screen`);
      assert.ok(box.width >= 40 && box.height >= 40, `${name}: ${id} is a 40px target`);
    }
    const dock = await page.locator("#dock").boundingBox();
    for (const sel of ["#cityinbox", "#cityfeed"]) {
      if (name !== "city" || !(await page.isVisible(sel))) continue;
      const b = await page.locator(sel).boundingBox();
      assert.ok(b.y + b.height <= dock.y + 1, `${name}: ${sel} does not sit on the dock`);
    }
    await page.close();
  }
});

test("desktop: the dock is visible in every view", { skip }, async () => {
  for (const name of Object.keys(VIEWS)) {
    const page = await browser.newPage({ viewport: SIZES.desktop });
    await jsonRoute(page);
    await page.goto(`http://localhost:${port}/`);
    await openView(page, name);
    assert.ok(await page.isVisible("#dock"), name);
    for (const id of ["chatbtn", "citybtn", "inboxbtn", "statusbtn"]) assert.ok(await page.isVisible(`#dock #${id}`), `${name}: ${id}`);
    await page.close();
  }
});

test("phone Chat and Status: inputs are at least 16px and every control is a 40px target", { skip }, async () => {
  for (const name of ["chat", "status", "inbox"]) {
    const page = await browser.newPage({ viewport: SIZES.mobile });
    await jsonRoute(page);
    await page.goto(`http://localhost:${port}/`);
    await openView(page, name);
    const bad = await page.evaluate((view) => {
      const root = document.querySelector({ chat: "#talk", status: "#status", inbox: "#inbox" }[view]);
      const out = [];
      for (const e of root.querySelectorAll("button,input,a[href]")) {
        if (!e.checkVisibility?.()) continue;
        const r = e.getBoundingClientRect();
        if (e.tagName === "A") continue; // inline links sit in text
        if (r.height < 39.5 || r.width < 39.5) out.push(`${e.tagName}#${e.id}.${e.className} ${Math.round(r.width)}x${Math.round(r.height)}`);
        if (e.tagName === "INPUT" && parseFloat(getComputedStyle(e).fontSize) < 16) out.push(`${e.id} font ${getComputedStyle(e).fontSize}`);
      }
      return out;
    }, name);
    assert.deepEqual(bad, [], name);
    await page.close();
  }
});

test("Esc closes what is open on top, then goes Home", { skip }, async () => {
  const page = await browser.newPage({ viewport: SIZES.mobile });
  await jsonRoute(page);
  await page.goto(`http://localhost:${port}/`);
  for (const name of ["chat", "status", "inbox"]) {
    await openView(page, name);
    assert.equal(await viewName(page), name);
    await page.keyboard.press("Escape");
    assert.equal(await viewName(page), "home", `${name}: Esc goes Home`);
    await page.keyboard.press("Escape");
    assert.equal(await viewName(page), "home");
  }
  // City: detail panel first, then Home.
  await openView(page, "city");
  await page.click("#citydepts .dept[data-building='HQ']");
  await page.waitForSelector("#citypanel:not([hidden])");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#citypanel[hidden]", { state: "attached" });
  assert.equal(await viewName(page), "city", "first Esc closes the panel only");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  assert.equal(await viewName(page), "home", "second Esc is Home");
  await page.close();
});

test("long labels are cut with a title, never overflowing", { skip }, async () => {
  const page = await browser.newPage({ viewport: SIZES.mobile });
  const snap = citySnapshot(); snap.agents.push({ ...snap.agents.find((a) => a.id === "ios-dev"), id: "x-department-agent", department: "A-very-long-department-name-that-goes-on-and-on-and-on-forever", state: "active" });
  await jsonRoute(page, snap);
  await page.route("**/state.json", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ generatedAt: new Date().toISOString(), features: [{ id: "F-LONG", name: "A feature with a name so long it cannot possibly fit on one line of a phone", status: "production, with a very long note about its state" }], prs: [], ci: [], actions: [], log: [] }) }));
  await page.goto(`http://localhost:${port}/`);
  await openView(page, "status");
  if (await page.$("#tab-booqy")) await page.click("#tab-booqy");
  await page.waitForFunction(() => document.querySelector("#features").textContent.includes("F-LONG"));
  const label = page.locator("#features .n").first();
  assert.match(await label.getAttribute("title"), /F-LONG/);
  assert.ok((await label.boundingBox()).x + (await label.boundingBox()).width <= 390);
  const o = await overflow(page);
  assert.ok(o.scroll <= 390, `scrollWidth ${o.scroll}`);
  await page.close();
  const city = await browser.newPage({ viewport: SIZES.mobile });
  await jsonRoute(city, snap);
  await city.goto(`http://localhost:${port}/?view=city`);
  await city.waitForSelector("#city[data-city-ready='1']", { timeout: 15000 });
  assert.equal(await city.getAttribute("#citydepts .dept[data-building='HQ']", "title"), "HQ");
  await city.close();
});

// ---- What the backend now reports, in the City view ----
const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NOTE = "Estimated value at API list prices. On the Claude subscription this is not a charge.";
// Opens the City view on a snapshot the test can change. Everything else under /api/city is left to the test's own routes.
async function openCity(snap = citySnapshot(), viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  const box = { snap };
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  await page.route("**/api/city", (r) => r.fulfill(json(box.snap)));
  await page.goto(`http://localhost:${port}/?view=city`);
  await page.waitForSelector("#city[data-city-ready='1']", { timeout: 15000 });
  await page.waitForSelector("#citylist button[data-building='HQ']", { state: "attached" });
  page.snap = box;
  return page;
}
const fire = (page, event) => page.evaluate((e) => document.dispatchEvent(new CustomEvent("jarvis-sse", { detail: { type: "city", event: e } })), event);
const openRecord = (page, view) => page.click(`#citydepts [data-view='${view}']`);
const panelText = (page) => page.textContent("#citypanel");
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("paused banner: from the snapshot with the reset time and the gate's counters; an event starts and ends it", { skip }, async () => {
  const until = new Date(Date.now() + 2 * HOUR).toISOString();
  const page = await openCity({ ...citySnapshot(), city: { paused_until: until, turns_running: 0, turns_waiting: 3 } });
  await page.waitForSelector("#citypaused:not([hidden])");
  const stockholm = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" }).format(new Date(until));
  const text = await page.textContent("#citypaused");
  assert.ok(text.includes(`City paused until ${stockholm} Stockholm`), text);
  assert.match(text, /0 turns running, 3 waiting/);
  // An open panel never hides the banner or the top bar's numbers.
  await openRecord(page, "parked");
  const [panelBox, bannerBox, topBox] = await Promise.all(["#citypanel", "#citypaused", "#citytop"].map((s) => page.locator(s).boundingBox()));
  const apart = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
  assert.ok(apart(panelBox, bannerBox), "the panel sits beside the banner");
  assert.ok(apart(panelBox, topBox), "the panel sits under the top bar");
  await page.keyboard.press("Escape");
  assert.match(await page.textContent("#citytop"), /TURNS\s*0 running · 3 waiting/);
  await page.screenshot({ path: join(SHOTS, "city-paused-desktop.png") });
  page.snap.snap = { ...citySnapshot(), city: { paused_until: null, turns_running: 1, turns_waiting: 0 } };
  await fire(page, { type: "city.resumed" });
  await page.waitForSelector("#citypaused[hidden]", { state: "attached" });
  await page.waitForFunction(() => /TURNS\s*1 running · 0 waiting/.test(document.querySelector("#citytop").textContent), null, { timeout: 5000 });
  await fire(page, { type: "city.paused", until, reason: "You've hit your 5-hour limit" });
  await page.waitForSelector("#citypaused:not([hidden])");
  assert.match(await page.textContent("#citypaused"), /5-hour limit/);
  assert.match(await page.textContent("#cityfeed"), /City paused until/);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("a pause whose reset has passed shows no banner, and an old server shows no gate numbers", { skip }, async () => {
  const page = await openCity({ ...citySnapshot(), city: { paused_until: new Date(Date.now() - 1000).toISOString(), turns_running: 0, turns_waiting: 0 } });
  await page.waitForSelector("#citytop .stat");
  assert.ok(await page.isHidden("#citypaused"));
  await page.close();
  const snap = citySnapshot(); delete snap.city; delete snap.parked; delete snap.departments;
  const old = await openCity(snap);
  assert.match(await old.textContent("#citytop"), /TURNS\s*—/, "never a made-up zero");
  assert.ok((await old.$$("#citydepts .dept:not(.rec)")).length >= 4, "a server from before the registry still draws its departments");
  assert.deepEqual(old.errors, []);
  await old.close();
});

test("parked inbox: resume one, cancel with a second click, all; the agent's text stays text", { skip }, async () => {
  const page = await openCity({ ...citySnapshot(), parked: cityParked() });
  const posts = [];
  await page.route("**/api/city/tickets/resume", (r) => { const b = r.request().postDataJSON(); posts.push(["resume", b]); return r.fulfill(json({ resumed: b.ids })); });
  await page.route("**/api/city/tickets/cancel", (r) => { const b = r.request().postDataJSON(); posts.push(["cancel", b]); return r.fulfill(json({ cancelled: b.ids })); });
  await page.waitForSelector("#cityparked:not([hidden])");
  assert.match(await page.textContent("#cityparkedsum"), /2 parked tickets wait for you/);
  assert.match(await page.textContent("#citytop"), /PARKED\s*2/);
  await page.click("#cityparkedbtn");
  await page.waitForSelector("#citypanel[data-kind='parked']");
  assert.match(await panelText(page), /Parked tickets \(2\)/);
  assert.deepEqual(await page.locator("#citypanel [data-parked]").evaluateAll((els) => els.map((e) => e.dataset.parked)), ["t-pk2", "t-pk1"], "oldest first");
  // Agent text goes in as text.
  assert.match(await page.textContent("#citypanel [data-parked='t-pk2']"), /<img src=x onerror=window\.__xss=1>/);
  assert.equal(await page.locator("#citypanel img").count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await page.screenshot({ path: join(SHOTS, "city-parked-desktop.png") });
  // Resume one: one click, exactly that id. The server's answer is what is reported.
  page.snap.snap = { ...citySnapshot(), parked: cityParked().filter((t) => t.id !== "t-pk1") };
  await page.locator("#citypanel [data-parked='t-pk1'] button", { hasText: "Resume" }).click();
  await page.waitForFunction(() => /Resumed 1 of 1/.test(document.querySelector("#citypanel").textContent));
  assert.deepEqual(posts, [["resume", { ids: ["t-pk1"] }]]);
  await page.waitForFunction(() => document.querySelectorAll("#citypanel [data-parked]").length === 1);
  assert.match(await panelText(page), /Resumed 1 of 1/, "the note survives the redraw");
  // Cancel: the first click only asks.
  const cancel = page.locator("#citypanel [data-parked='t-pk2'] button", { hasText: "Cancel" });
  await cancel.click();
  assert.deepEqual(posts.length, 1, "one click cancels nothing");
  assert.equal(await cancel.textContent(), "Sure? Cancel it");
  page.snap.snap = { ...citySnapshot(), parked: [] };
  await cancel.click();
  await page.waitForFunction(() => /Nothing is parked/.test(document.querySelector("#citypanel").textContent));
  assert.deepEqual(posts[1], ["cancel", { ids: ["t-pk2"] }]);
  await page.waitForSelector("#cityparked[hidden]", { state: "attached" });
  // All, both ways, from a fresh list.
  page.snap.snap = { ...citySnapshot(), parked: cityParked() };
  await fire(page, { type: "tickets.parked", ids: ["t-pk1", "t-pk2"] });
  await page.waitForFunction(() => document.querySelectorAll("#citypanel [data-parked]").length === 2, null, { timeout: 5000 });
  await page.click("#citypanel button:text-is('Resume all (2)')");
  assert.equal(posts.length, 2);
  await page.click("#citypanel button:text-is('Sure? Resume 2')");
  await page.waitForFunction(() => /Resumed 2 of 2/.test(document.querySelector("#citypanel").textContent));
  assert.deepEqual(posts[2], ["resume", { ids: ["t-pk2", "t-pk1"] }]);
  await page.click("#citypanel button:text-is('Cancel all (2)')");
  await page.click("#citypanel button:text-is('Sure? Cancel 2')");
  await page.waitForFunction(() => /Cancelled 2 of 2/.test(document.querySelector("#citypanel").textContent));
  assert.deepEqual(posts[3], ["cancel", { ids: ["t-pk2", "t-pk1"] }]);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("parked inbox: ticket events move tickets in and out, and a server refusal is reported", { skip }, async () => {
  const page = await openCity();
  assert.ok(await page.isHidden("#cityparked"), "no corner when nothing is parked");
  await openRecord(page, "parked");
  assert.match(await panelText(page), /Nothing is parked/);
  const [p] = cityParked();
  page.snap.snap = { ...citySnapshot(), parked: [p] };
  await fire(page, { type: "ticket.status", ticket: p, previous: "open" });
  await page.waitForSelector("#citypanel [data-parked='t-pk1']");
  await page.route("**/api/city/tickets/resume", (r) => r.fulfill(json({ error: "cannot resume: App is at its cap of 5" }, 400)));
  await page.click("#citypanel [data-parked='t-pk1'] button:text-is('Resume')");
  await page.waitForFunction(() => /Nothing changed: cannot resume: App is at its cap of 5/.test(document.querySelector("#citypanel").textContent));
  await page.close();
});

test("workforce panel: every lifecycle word from the server, released workers as findable history, costs as estimates", { skip }, async () => {
  const page = await openCity();
  await page.route("**/api/city/workforce", (r) => r.fulfill(json(cityWorkforce())));
  await openRecord(page, "workforce");
  await page.waitForSelector("#citypanel [data-worker='ios-dev']");
  const text = await panelText(page);
  assert.match(text, /3 hired ever · 2 active · 1 working · 0 in review · 1 blocked · 0 failed · 1 released/);
  assert.ok(text.includes(NOTE), "the note is visible");
  const ios = await page.textContent("#citypanel [data-worker='ios-dev']");
  assert.match(ios, /working/);
  assert.match(ios, /iOS Developer · App · sdk · Sonnet/);
  assert.match(ios, /Build the habit tracker screen/);
  assert.match(ios, /3 done · 1 failed · 75% success · median 4 min · busy 12 min · est\. \$0\.420/);
  assert.match(await page.textContent("#citypanel [data-worker='ads-writer']"), /blocked.*openclaw/s);
  assert.deepEqual(await page.locator("#citypanel h4").allTextContents(), ["Current (2)", "Released (1)"]);
  assert.match(await page.textContent("#citypanel [data-worker='old-writer']"), /released.*no current assignment.*100% success/s);
  await page.screenshot({ path: join(SHOTS, "city-workforce-desktop.png") });
  // A live worker opens its agent panel with the lifecycle word.
  await page.click("#citypanel [data-worker='ios-dev'] button.link");
  await page.waitForSelector("#citypanel[data-kind='agent']");
  await fire(page, { type: "worker.state", id: "ios-dev", state: "review", previous: "working" });
  await page.waitForFunction(() => document.querySelector("#citypanel [data-status] .v")?.textContent === "review");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("workforce panel: nothing hired says so", { skip }, async () => {
  const page = await openCity();
  await page.route("**/api/city/workforce", (r) => r.fulfill(json({ totals: {}, workers: [] })));
  await openRecord(page, "workforce");
  await page.waitForFunction(() => /No workers have been hired yet/.test(document.querySelector("#citypanel").textContent));
  await page.close();
});

test("cost panel: the note is visible and every dollar figure is an estimate, here and everywhere else in the city", { skip }, async () => {
  const page = await openCity();
  await page.route("**/api/city/costs", (r) => r.fulfill(json(cityCosts())));
  await page.route("**/api/city/trace**", (r) => r.fulfill(json(cityTrace())));
  await openRecord(page, "costs");
  await page.waitForSelector("#citypanel table.costs");
  const text = await panelText(page);
  assert.ok(text.includes(NOTE));
  for (const part of ["Today", "This month", "per done ticket", "est. $2.50", "Sonnet", "App", "ios-dev", "t-fx1"]) assert.ok(text.includes(part), part);
  assert.deepEqual(await page.locator("#citypanel table.costs").first().locator("th").allTextContents(), ["", "Est. value", "Tokens", "Turns"]);
  await page.screenshot({ path: join(SHOTS, "city-costs-desktop.png") });
  const bareDollars = (t) => t.replace(/est\. \$[\d.]+/g, "").match(/\$[\d.]+/g);
  assert.equal(bareDollars(text), null, "no dollar figure without its label");
  const top = page.locator("#citytop");
  assert.match(await top.textContent(), /EST\. VALUE, NOT A CHARGE\s*est\. \$1\.73/);
  assert.equal(bareDollars(await top.textContent()), null);
  // A ticket row leads to its story, and Back returns.
  await page.click("#citypanel button.link:text-is('t-fx1')");
  await page.waitForSelector("#citypanel[data-kind='story'] .story");
  await page.click("#citypanel button:text-is('Back')");
  await page.waitForSelector("#citypanel[data-kind='costs'] table.costs");
  // The agent and department panels carry the label and the note too.
  await page.locator("#citylist button[data-agent='ios-dev']").dispatchEvent("click");
  await page.waitForSelector("#citypanel[data-kind='agent']");
  const agentText = await panelText(page);
  assert.match(agentText, /cost so far\s*est\. \$0\.420/);
  assert.ok(agentText.includes(NOTE));
  assert.equal(bareDollars(agentText), null);
  await page.locator("#citylist button[data-building='App']").dispatchEvent("click");
  const deptText = await panelText(page);
  assert.match(deptText, /est\. \$0\.91/);
  assert.ok(deptText.includes(NOTE));
  assert.equal(bareDollars(deptText), null);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("health and integrations: what was checked and when; only a probe's word says it works", { skip }, async () => {
  const page = await openCity();
  await page.route("**/api/city/health", (r) => r.fulfill(json(cityHealth())));
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route("**/api/city/integrations", async (r) => { await held; return r.fulfill(json(cityIntegrations())); });
  await openRecord(page, "health");
  await page.waitForFunction(() => /2 running · 1 waiting/.test(document.querySelector("#citypanel").textContent));
  assert.match(await panelText(page), /Probing integrations/, "a slow probe holds back only its own section");
  assert.match(await panelText(page), /Read from the ledger at \d\d:\d\d:\d\d/);
  release();
  await page.waitForSelector("#citypanel [data-integration='GitHub CLI']");
  const text = await panelText(page);
  assert.match(text, /Probed at \d\d:\d\d:\d\d \(1 min ago\)/);
  const row = (name) => page.textContent(`#citypanel [data-integration='${name}']`);
  assert.match(await row("GitHub CLI"), /operational.*gh auth status succeeded.*checked: gh auth status/s);
  assert.match(await row("OpenClaw gateway"), /available.*nothing listening on 18789.*checked: port 18789.*Only needed for Telegram/s);
  assert.match(await row("Meta Ads"), /needs owner.*Keychain item jarvis\.meta is missing/s);
  assert.match(await row("Blender"), /unavailable.*blender is not installed/s);
  assert.match(await row("Mystery"), /unknown.*no check defined/s);
  assert.doesNotMatch(text, /connected/i, "the HUD adds no such word of its own");
  assert.equal(await page.locator("#citypanel [data-integration='OpenClaw gateway'] .tag.good").count(), 0, "available is not shown as working");
  assert.equal(await page.locator("#citypanel [data-integration='GitHub CLI'] .tag.good").count(), 1);
  await page.screenshot({ path: join(SHOTS, "city-health-desktop.png") });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("ticket story: offered from the agent, department and parked panels, and it says when there is none", { skip }, async () => {
  const page = await openCity({ ...citySnapshot(), parked: cityParked() });
  const asked = [];
  await page.route("**/api/city/trace**", (r) => { const id = new URL(r.request().url()).searchParams.get("ticket"); asked.push(id); return r.fulfill(json(id === "t-fx1" ? cityTrace() : [])); });
  await page.locator("#citylist button[data-agent='ios-dev']").dispatchEvent("click");
  await page.waitForSelector("#citypanel[data-kind='agent']");
  await page.click("#citypanel button:text-is('Story of this ticket')");
  await page.waitForSelector("#citypanel .story .line");
  assert.deepEqual(asked, ["t-fx1"]);
  const story = await page.locator("#citypanel .story .line").allTextContents();
  assert.equal(story.length, 5, "the question once");
  assert.match(story[0], /app-manager sent ios-dev: Build the habit tracker screen/);
  assert.match(story[2], /est\. \$0\.031/);
  await page.screenshot({ path: join(SHOTS, "city-story-desktop.png") });
  await page.click("#citypanel button:text-is('Back')");
  await page.waitForSelector("#citypanel[data-kind='agent']");
  await page.locator("#citylist button[data-building='App']").dispatchEvent("click");
  await page.locator("#citypanel li", { hasText: "qa-tester" }).locator("button:text-is('Story')").click();
  await page.waitForFunction(() => /No events recorded for this ticket/.test(document.querySelector("#citypanel").textContent));
  await page.click("#citypanel button:text-is('Back')");
  await page.waitForSelector("#citypanel[data-kind='department']");
  await page.click("#cityparkedbtn");
  await page.locator("#citypanel [data-parked='t-pk1'] button:text-is('Story')").click();
  await page.waitForFunction(() => document.querySelector("#citypanel").dataset.kind === "story");
  assert.equal(asked.at(-1), "t-pk1");
  await page.close();
});

test("a department's released workers stay findable, and the registry decides what stands in the city", { skip }, async () => {
  const snap = citySnapshot();
  const ads = snap.agents.find((a) => a.id === "ads-writer");
  snap.tickets = snap.tickets.filter((t) => t.to !== "ads-writer");
  snap.agents.push({ ...ads, id: "old-writer", role: "Copywriter", state: "retired", worker_state: "released", lifecycle: "temporary" });
  snap.departments.push({ ...snap.departments[0], key: "video", name: "Video", state: "archived", manager_id: null });
  const page = await openCity(snap);
  assert.equal(await page.textContent("#citydepts button[data-building='Video']"), "Video (archived)");
  await page.locator("#citylist button[data-building='Marketing']").dispatchEvent("click");
  assert.match(await panelText(page), /Released \(1\).*old-writer: Copywriter/s);
  assert.match(await panelText(page), /ads-writer \(blocked\)/);
  await page.locator("#citypanel li", { hasText: "old-writer" }).locator("button:text-is('Details')").click();
  await page.waitForFunction(() => document.querySelector("#citypanel [data-status] .v")?.textContent === "released");
  await page.click("#citydepts button[data-building='Video']");
  assert.match(await panelText(page), /Archived\. It has no building/);
  assert.equal(await page.locator("#citypanel button:text-is('Zoom in')").count(), 0);
  // Real events change the registry: a rename and a new department.
  await fire(page, { type: "department.created", department: { ...snap.departments[0], key: "ops", name: "Ops", state: "active" } });
  await page.waitForSelector("#citydepts button[data-building='Ops']");
  await fire(page, { type: "department.updated", department: { ...snap.departments[0], key: "operations", name: "Operations", state: "active" }, previous_key: "ops" });
  await page.waitForSelector("#citydepts button[data-building='Operations']");
  assert.equal(await page.locator("#citydepts button[data-building='Ops']").count(), 0);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("a ticket between two agents moves a courier, and only then", { skip }, async () => {
  const page = await openCity();
  const couriers = () => page.getAttribute("#city", "data-couriers");
  const t = { id: "t-new", from: "app-manager", to: "ios-dev", kind: "task", goal: "Next screen", status: "open", created_at: "", updated_at: "" };
  await fire(page, { type: "ticket.status", ticket: { ...t, status: "in_progress" }, previous: "open" });
  assert.equal(await couriers(), null, "a status change on one desk carries nothing");
  await fire(page, { type: "ticket.status", ticket: { ...t, from: "owner" }, previous: null });
  assert.equal(await couriers(), null, "the owner has no figure in the city");
  await fire(page, { type: "ticket.status", ticket: t, previous: null });
  assert.equal(await couriers(), "1");
  await fire(page, { type: "ticket.status", ticket: { ...t, status: "done" }, previous: "in_review" });
  assert.equal(await couriers(), "2", "the result goes back");
  assert.match(await page.textContent("#cityfeed"), /ios-dev got a ticket from app-manager: Next screen/);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("phone width: panels answer 403 honestly, nothing overflows, and departments and records stay reachable", { skip }, async () => {
  const forbidden = { error: "not available from the phone" };
  const page = await openCity({ ...citySnapshot(), parked: cityParked(), city: { paused_until: new Date(Date.now() + HOUR).toISOString(), turns_running: 0, turns_waiting: 2 } }, { width: 390, height: 844 });
  await page.route(/\/api\/city\/(workforce|costs|health|integrations|trace|tickets\/)/, (r) => r.fulfill(json(forbidden, 403)));
  await page.waitForSelector("#citypaused:not([hidden])");
  assert.ok(await noSideways(page), "no sideways scroll");
  assert.ok(await page.isVisible("#citydepts"), "the row of departments and records is there");
  await page.screenshot({ path: join(SHOTS, "city-paused-mobile.png") });
  for (const [view, what] of [["workforce", "Workforce"], ["costs", "Costs"], ["health", "Health"]]) {
    await page.locator(`#citydepts [data-view='${view}']`).click();
    await page.waitForFunction((w) => document.querySelector("#citypanel").textContent.includes(`${w} is not available from the phone`), what);
    assert.ok(await noSideways(page));
    await page.click("#citypanel header button");
  }
  await page.locator("#citylist button[data-agent='ios-dev']").dispatchEvent("click");
  await page.waitForSelector("#citypanel[data-kind='agent']");
  await page.click("#citypanel button:text-is('Story of this ticket')");
  await page.waitForFunction(() => /story is not available from the phone/.test(document.querySelector("#citypanel").textContent));
  await page.click("#citypanel header button");
  // The snapshot is allowed, so parked tickets are listed; the actions say why they can't run.
  await page.locator("#cityparkedbtn").click();
  await page.waitForSelector("#citypanel [data-parked='t-pk1']");
  await page.screenshot({ path: join(SHOTS, "city-parked-mobile.png") });
  await page.locator("#citypanel [data-parked='t-pk1'] button:text-is('Resume')").click();
  await page.waitForFunction(() => /not available from the phone/.test(document.querySelector("#citypanel").textContent));
  assert.ok(await page.locator("#citypanel [data-parked='t-pk1'] button:text-is('Resume')").isDisabled(), "no point pressing it again");
  assert.ok(await page.locator("#citypanel [data-parked='t-pk1'] button:text-is('Story')").isEnabled());
  for (const b of await page.locator("#citypanel .acts button:visible").all()) assert.ok((await b.boundingBox()).height >= 39.5, "touch targets are at least 40px");
  assert.ok(await noSideways(page));
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("the panels against the real backend routes, with the fake runner: real shapes, real events, real resume", { skip }, async () => {
  const now = new Date().toISOString();
  const row = { id: "e2e-past", role: "Past worker", kind: "worker", department: "E2E Dept", parent: "mgr-e2e-dept", model: "claude-sonnet-5-5", effort: "medium", tools: [], lifecycle: "temporary", state: "retired", worker_state: "released", session_id: null, prompt_path: "", created_at: now, last_active_at: now, total_cost_usd: 0 };
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // The one route not exercised for real: it would run the Mac's CLIs.
  await page.route("**/api/city/integrations", (r) => r.fulfill(json({ checked_at: now, integrations: [] })));
  await page.goto(`http://localhost:${port}/?view=city`);
  await page.waitForSelector("#citylist button[data-building='HQ']", { state: "attached", timeout: 15000 });
  await page.waitForFunction(() => document.querySelector("#citytop").textContent.includes("running"));
  assert.match(await page.textContent("#citytop"), /TURNS\s*0 running · 0 waiting/, "the real gate");
  assert.match(await page.textContent("#citytop"), /EST\. VALUE, NOT A CHARGE/);
  // A real department over the real event stream.
  city.createDepartment({ name: "E2E Dept", mission: "Prove the wiring" });
  await page.waitForSelector("#citydepts button[data-building='E2E Dept']");
  await page.click("#citydepts button[data-building='E2E Dept']");
  assert.match(await panelText(page), /mission\s*Prove the wiring/);
  assert.match(await panelText(page), /manager\s*mgr-e2e-dept/);
  city.ledger.putAgent(row);
  await openRecord(page, "workforce");
  await page.waitForSelector("#citypanel [data-worker='e2e-past']");
  assert.match(await page.textContent("#citypanel [data-worker='e2e-past']"), /released/);
  await openRecord(page, "costs");
  await page.waitForFunction((n) => document.querySelector("#citypanel").textContent.includes(n), NOTE);
  await openRecord(page, "health");
  await page.waitForFunction(() => /No integrations are configured/.test(document.querySelector("#citypanel").textContent));
  assert.match(await panelText(page), /0 running · 0 waiting/);
  // A real parked ticket: listed by the real snapshot, resumed by the real route; the real events take it off the list.
  city.ledger.putTicket({ id: "t-e2epark", from: "orchestrator", to: "mgr-e2e-dept", kind: "task", goal: "Parked for the end-to-end test", scope: "", acceptance_criteria: [], status: "parked", created_at: now, updated_at: now });
  await page.reload();
  await page.waitForSelector("#cityparked:not([hidden])", { timeout: 15000 });
  await page.click("#cityparkedbtn");
  await page.waitForSelector("#citypanel [data-parked='t-e2epark']");
  await page.click("#citypanel [data-parked='t-e2epark'] button:text-is('Resume')");
  await page.waitForFunction(() => /Resumed 1 of 1|Nothing is parked/.test(document.querySelector("#citypanel").textContent));
  await page.waitForFunction(() => /Nothing is parked/.test(document.querySelector("#citypanel").textContent));
  // The real trace of what just happened, from the agent's panel.
  await page.locator("#citylist button[data-agent='mgr-e2e-dept']").dispatchEvent("click");
  await page.waitForFunction(() => /Recent results|Working on \(1\)/.test(document.querySelector("#citypanel").textContent));
  assert.doesNotMatch(await panelText(page), /Live details did not load/, "the real /api/city/agent answers");
  await page.locator("#citypanel button", { hasText: /^Story of/ }).click();
  await page.waitForFunction(() => /mgr-e2e-dept: parked → in_progress/.test(document.querySelector("#citypanel").textContent));
  assert.deepEqual(errors, []);
  await page.close();
});

// ---- The game ----
// Where a figure stands, read from the running scene: state the tests may look at, never drive.
const person = (page, id) => page.evaluate((who) => { const p = window.__city?.people.get(who); return p ? { x: p.x, y: p.y, key: p.key, moving: !!(p.move || p.route), visual: p.visual } : null; }, id);

test("every agent sits where the real state says, and clicking one on the map opens what it is doing, kept fresh", { skip }, async () => {
  const page = await openCity(cityBusy());
  let reads = 0;
  const live = { id: "ios-dev", role: "iOS Developer", kind: "worker", department: "App", model: "claude-sonnet-5-5", executor: "openclaw", state: "active", worker_state: "working", activity: { activity: "coding", detail: "Sources/Habit.swift", ticket_id: "t-ios-dev", at: "" }, awaiting_merge: null, current: [{ id: "t-ios-dev", status: "in_progress", from: "app-manager", goal: "Build the <b>habit</b> screen" }], recent: [{ id: "t-old", status: "done", goal: "Earlier", result: "Shipped the login", updated_at: "" }], waiting_for: [{ id: "t-w", to: "qa-tester", status: "open" }], questions: [{ id: "q1", text: "Dark mode too?" }], recent_tools: [{ tool: "Edit", decision: "allow" }, { tool: "Bash", decision: "deny" }], last_active_at: "", cost_usd_estimate: 0.5 };
  await page.route("**/api/city/agent?**", (r) => { reads++; return r.fulfill(json(reads > 1 ? { ...live, current: [{ ...live.current[0], goal: "A fresher goal" }] } : live)); });
  await page.waitForFunction(() => document.querySelector("#city").dataset.people === "27");
  // A real mouse click on the figure, wherever it stands on screen.
  const box = await page.evaluate(() => { const p = window.__city.people.get("ios-dev"), v = window.__city.view; return { x: (p.x - v.x) * v.zoom, y: (p.y - 12 - v.y) * v.zoom }; });
  const root = await page.locator("#city").boundingBox();
  await page.mouse.click(root.x + box.x, root.y + box.y);
  await page.waitForSelector("#citypanel[data-kind='agent']");
  await page.waitForFunction(() => /Writing code: Sources\/Habit\.swift/.test(document.querySelector("#citypanel .doing").textContent));
  await page.waitForFunction(() => /Shipped the login/.test(document.querySelector("#citypanel").textContent));
  const text = await panelText(page);
  for (const part of ["iOS Developer", "Sonnet", "App", "openclaw", "qa-tester: open", "Dark mode too?", "Shipped the login", "Edit", "deny: Bash", "est. $0.500", NOTE]) assert.ok(text.includes(part), part);
  assert.equal(await page.locator("#citypanel b").count(), 0, "agent text stays text");
  assert.ok(text.includes("Build the <b>habit</b> screen"));
  // The panel reads again by itself while open, and an event updates the plain words at once.
  await page.waitForFunction(() => /A fresher goal/.test(document.querySelector("#citypanel").textContent), null, { timeout: 6000 });
  await fire(page, { type: "agent.activity", id: "ios-dev", activity: "reading", detail: "notes.md", ticket_id: "t-ios-dev", at: "" });
  await page.waitForFunction(() => /Reading a file: notes\.md/.test(document.querySelector("#citypanel .doing").textContent));
  assert.equal((await person(page, "ios-dev")).visual, "reading");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#citypanel[hidden]", { state: "attached" });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("a page load places everyone with no journeys; a prompt dashes a manager from home in well under a second; done, it walks home", { skip }, async () => {
  const page = await openCity(cityBusy());
  await page.waitForFunction(() => window.__city?.people.size === 27);
  for (const id of ["ios-dev", "web-dev", "old-writer", "travel-manager", "jarvis"]) assert.equal((await person(page, id)).moving, false, id);
  assert.match((await person(page, "ios-dev")).key, /^desk:App:/);
  assert.match((await person(page, "web-dev")).key, /^desk:App:/, "waiting for the merge holds the desk");
  assert.equal((await person(page, "old-writer")).key, "home");
  assert.equal((await person(page, "travel-manager")).key, "home");
  const start = await person(page, "travel-manager");
  const t = { id: "t-trip", from: "orchestrator", to: "travel-manager", kind: "task", goal: "Plan the trip", status: "open", created_at: "", updated_at: "" };
  const t0 = Date.now();
  await fire(page, { type: "ticket.status", ticket: t, previous: null });
  await page.waitForFunction(() => { const p = window.__city.people.get("travel-manager"); return p.key.startsWith("desk:Travel") && !p.move; }, null, { timeout: 2000, polling: 20 });
  assert.ok(Date.now() - t0 < 900, `dash took ${Date.now() - t0} ms`);
  const atDesk = await person(page, "travel-manager");
  assert.notEqual(atDesk.y, start.y);
  await fire(page, { type: "ticket.status", ticket: { ...t, status: "done" }, previous: "in_progress" });
  assert.equal((await person(page, "travel-manager")).key, "home");
  assert.equal((await person(page, "travel-manager")).moving, true, "going home is a walk");
  await page.waitForTimeout(300);
  const walking = await person(page, "travel-manager");
  assert.ok(walking.moving && (walking.x !== atDesk.x || walking.y !== atDesk.y), "relaxed, on its way");
  // Merged: the one who was waiting leaves.
  await fire(page, { type: "worker.merged", id: "web-dev", branch: "feat/web-login" });
  assert.match((await person(page, "web-dev")).key, /^desk:/, "still hired and not released, so it keeps the desk");
  await fire(page, { type: "worker.state", id: "web-dev", state: "released", previous: "completed" });
  await fire(page, { type: "agent.retired", id: "web-dev" });
  assert.equal((await person(page, "web-dev")).key, "home");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("with reduced motion everyone moves instantly and nothing flies", { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.route("**/api/city", (r) => r.fulfill(json(cityBusy())));
  await page.goto(`http://localhost:${port}/?view=city`);
  await page.waitForFunction(() => window.__city?.people.size === 27, null, { timeout: 15000 });
  const t = { id: "t-trip", from: "orchestrator", to: "travel-manager", kind: "task", goal: "Plan", status: "open", created_at: "", updated_at: "" };
  await fire(page, { type: "ticket.status", ticket: t, previous: null });
  const p = await person(page, "travel-manager");
  assert.match(p.key, /^desk:Travel/);
  assert.equal(p.moving, false);
  assert.equal(await page.getAttribute("#city", "data-couriers"), null);
  await ctx.close();
});

test("Jarvis's visit: a dash, a word over its head and back; a repeat within a second is not another visit; an unknown agent is none", { skip }, async () => {
  const page = await openCity(cityBusy());
  await page.waitForFunction(() => window.__city?.people.size === 27);
  const home = await person(page, "jarvis");
  await fire(page, { type: "jarvis.visit", to: "ios-dev", kind: "status" });
  await fire(page, { type: "jarvis.visit", to: "ios-dev", kind: "status" });
  assert.equal(await page.getAttribute("#city", "data-visits"), "1");
  const target = await person(page, "ios-dev");
  await page.waitForFunction((t) => { const j = window.__city.people.get("jarvis"); return !j.move && Math.abs(j.y - t.y) < 1; }, target, { timeout: 2000 });
  assert.match(await page.textContent("#cityfeed"), /Jarvis checks in with ios-dev/);
  await page.waitForFunction((h) => { const j = window.__city.people.get("jarvis"); return !j.move && Math.abs(j.x - h.x) < 1 && Math.abs(j.y - h.y) < 1; }, home, { timeout: 4000 });
  await page.waitForTimeout(1050);
  await fire(page, { type: "jarvis.visit", to: "nobody-here", kind: "ask" });
  assert.equal(await page.getAttribute("#city", "data-visits"), "1");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("the empty city says what is true, the legend lists every mark, and the keyboard list reaches everyone", { skip }, async () => {
  const page = await openCity(cityEmpty());
  await page.waitForSelector("#cityempty:not([hidden])");
  assert.match(await page.textContent("#cityempty"), /No departments yet/);
  assert.equal(await page.locator("#citylist button[data-agent]").count(), 4, "the core and no one else");
  await page.click("#citydepts [data-view='legend']");
  await page.waitForSelector("#citypanel[data-kind='legend']");
  assert.equal(await page.locator("#citypanel [data-visual]").count(), 23);
  for (const word of ["Needs you", "Coding", "Waiting for a merge", "Failed", "Blocked", "Paused"]) assert.ok((await panelText(page)).includes(word), word);
  await page.keyboard.press("Escape");
  await page.locator("#citylist button[data-agent='reviewer']").focus();
  assert.ok(await page.isVisible("#citylist button[data-agent='reviewer']"), "the list shows itself when reached by keyboard");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#citypanel[data-kind='agent']");
  assert.match(await panelText(page), /Reviewer Gate/);
  await page.close();
});

test("the view stops drawing while hidden, and a phone selects by touch with the sheet below the figure", { skip }, async () => {
  const page = await openCity(cityBusy());
  await page.click("#statusbtn");
  await page.waitForTimeout(200);
  const hidden = await page.evaluate(() => new Promise((done) => { const c = document.querySelector("#city canvas"), g = c.getContext("2d"), orig = g.drawImage; let n = 0; g.drawImage = function (...a) { n++; return orig.apply(this, a); }; setTimeout(() => done(n), 500); }));
  assert.equal(hidden, 0, "no drawing while the City view is hidden");
  await page.click("#citybtn");
  await page.waitForFunction(() => { const c = document.querySelector("#city canvas"); return c.width > 10; });
  await page.close();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage();
  await phone.route("**/api/city", (r) => r.fulfill(json(cityBusy())));
  await phone.route("**/api/city/agent?**", (r) => r.fulfill(json({ error: "no such agent" }, 404)));
  await phone.goto(`http://localhost:${port}/?view=city`);
  await phone.waitForFunction(() => window.__city?.people.size === 27, null, { timeout: 15000 });
  assert.ok(await noSideways(phone));
  // Bring the figure into view through the map's own zoom-free pan, then tap it.
  const spot = await phone.evaluate(() => { const c = window.__city, p = c.people.get("ios-dev"), v = c.view; return { x: (p.x - v.x) * v.zoom, y: (p.y - 12 - v.y) * v.zoom }; });
  const r = await phone.locator("#city").boundingBox();
  await phone.touchscreen.tap(r.x + spot.x, r.y + spot.y);
  await phone.waitForSelector("#citypanel[data-kind='agent']");
  assert.match(await phone.textContent("#citypanel"), /iOS Developer/);
  await phone.waitForFunction(() => /Live details did not load/.test(document.querySelector("#citypanel").textContent), null, { timeout: 5000 }); // an unanswered read says so
  assert.ok(await noSideways(phone));
  await ctx.close();
});
