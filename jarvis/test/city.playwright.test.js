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
const SHOTS = join(process.env.HOME ?? "", ".jarvis/work/ui-audit/shots");
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
  assert.match(limitsText, /\$1\.73 \(SDK cost estimate\)/);
  assert.ok(limitsText.indexOf("tokens") < limitsText.indexOf("SDK cost estimate"), "tokens and turns come before dollars");
  const over = page.locator("#ailimits .dept.over");
  assert.equal(await over.count(), 1);
  assert.match(await over.textContent(), /Marketing.*OVER CAP.*\$7\.50/);
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
  assert.match(text, /\$456\.73 today/);
  assert.match(text, /cap: unknown until Jarvis restarts/);
  assert.doesNotMatch(text, /\d+ \/ \d+|OVER CAP/, "no invented cap, no over-cap");
  assert.equal(await page.locator("#ailimits .dept .bar").count(), 0, "no bar without a cap");
  assert.equal(await page.locator("#ailimits .dept.over").count(), 0);
  await page.screenshot({ path: join(SHOTS, "phaseC-status-nocaps.png") });
  await page.close();
});
