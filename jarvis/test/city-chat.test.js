// Jarvis on the city backend, with a scripted runner in place of the Agent SDK.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createCity, loadPolicy } from "city";
import { createCityChat, questionText, resultText } from "../server/city-chat.js";
import { createServer } from "../server/server.js";

// Waits for a condition instead of sleeping a fixed time (fixed sleeps were flaky on a busy machine).
async function waitFor(condition, what = "condition", timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}


const dir = mkdtempSync(join(tmpdir(), "jarvis-city-"));
const policy = loadPolicy();
const turns = [];
let reply = "Eighteen, sir.";
// The fake SDK: records every turn, streams two pieces of text, keeps one session id per conversation.
const runner = async (req) => {
  turns.push(req);
  if (req.agentId === "jarvis") {
    req.onText?.(reply.slice(0, 5));
    req.onText?.(reply.slice(5));
    if (/forward/.test(req.prompt)) await req.tools.find((t) => t.name === "send_ticket").handler({ ticket: { to: "orchestrator", goal: req.prompt } });
    return { text: reply, sessionId: req.resume ?? `sdk-${turns.length}`, costUsd: 0.01 };
  }
  return { text: req.agentId === "secretary" ? "**Done:** the thing." : "", sessionId: `sdk-${req.agentId}`, costUsd: 0 };
};
const city = createCity({ runner, dataDir: dir, ledgerPath: ":memory:", policy });
const chat = createCityChat({ city, runner, dataDir: dir });
let server, port;

function call({ method = "GET", path = "/", body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { Host: `localhost:${port}`, "Content-Type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

before(async () => {
  server = createServer({ booqyDir: dir, dataDir: dir, port: 0, getState: async () => ({}), chat, speak: async (text) => ({ audio: Buffer.from(`spoken:${text}`).toString("base64"), audioType: "audio/mpeg" }), transcribe: async () => "" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => { server.close(); city.close(); });

test("typed and spoken turns share one Jarvis session and memory", async () => {
  const events = [];
  assert.equal(await chat("what's 9+9", "hud", { onEvent: (e) => events.push(e) }), "Eighteen, sir.");
  assert.deepEqual(events.map((e) => e.type), ["text", "text", "flush"]);
  assert.equal(events[0].text + events[1].text, "Eighteen, sir.");
  await chat("and times two?", "hud");
  assert.equal(turns.length, 2);
  assert.equal(turns[0].resume, undefined);
  assert.ok(city.ledger.costReport().by_agent.jarvis, "Jarvis's own turns count in the costs");
  assert.equal(turns[1].resume, "sdk-1", "the second turn resumes the first turn's session");
  assert.equal(turns[1].agentId, "jarvis");
  assert.equal(turns[1].model, "claude-haiku-5-5");
  assert.ok(turns[1].allowedTools.includes("mcp__jarvis__send_ticket"));
  assert.deepEqual(turns[1].tools.map((t) => t.name).sort(), ["agent_status", "ask_agent", "ask_user", "city_status", "recall", "remember", "send_ticket"], "Jarvis carries only the tools its prompt lists");
  await chat("hello from the terminal", "cli");
  assert.equal(turns[2].resume, undefined, "another conversation has its own session");
});

test("the stream route carries the city reply sentence by sentence, with audio only when the turn asks", async () => {
  const typed = await call({ method: "POST", path: "/api/chat/stream", body: { message: "status", sessionId: "hud", voice: false } });
  const lines = typed.text.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ["sentence", "done"]);
  assert.equal(lines[0].text, "Eighteen, sir.");
  assert.equal(lines[0].audio, undefined);
  const spoken = await call({ method: "POST", path: "/api/chat/stream", body: { message: "status", sessionId: "hud", voice: true } });
  assert.ok(JSON.parse(spoken.text.split("\n")[0]).audio);
});

test("questions and results from the city come back as Jarvis messages, pushed to the HUD", async () => {
  const pushed = [];
  const es = request({ host: "127.0.0.1", port, path: "/api/events", headers: { Host: `localhost:${port}` } });
  const opened = new Promise((resolve) => es.on("response", (res) => { res.setEncoding("utf8"); res.on("data", (chunk) => { for (const line of chunk.split("\n")) if (line.startsWith("data: ")) pushed.push(JSON.parse(line.slice(6))); }); resolve(res); }));
  es.end();
  const res = await opened;
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/event-stream/);

  const said = () => pushed.filter((p) => p.type === "jarvis"); // the stream also carries city events
  reply = "On it, sir.";
  await chat("please forward this to the city", "hud");
  const ticket = city.openTickets()[0];
  assert.ok(ticket, "Jarvis sent a ticket");
  reply = "The orchestrator asks: which repo, sir?";
  const ask = city.toolsFor("orchestrator").find((t) => t.name === "ask_user").handler;
  await ask({ question: { ticket_id: ticket.id, questions: [{ text: "Which repo?", default: "a new one" }] } });
  await waitFor(() => turns.some((t) => t.agentId === "jarvis" && /^\[question /.test(t.prompt)) && said().at(-1)?.text === "The orchestrator asks: which repo, sir?", "the question turn and its pushed reply");
  const q = turns.findLast((t) => t.agentId === "jarvis");
  assert.match(q.prompt, /^\[question q-[0-9a-f]+ from orchestrator \(agent orchestrator\) on ticket t-/);
  assert.match(q.prompt, /Which repo\? Default: a new one\./);
  assert.equal(q.resume, "sdk-1", "asked in the conversation that sent the ticket");
  assert.deepEqual(said().at(-1), { type: "jarvis", sessionId: "hud", text: "The orchestrator asks: which repo, sir?", audio: Buffer.from("spoken:The orchestrator asks: which repo, sir?").toString("base64"), audioType: "audio/mpeg" });

  reply = "All done, sir.";
  await city.toolsFor("orchestrator").find((t) => t.name === "report").handler({ ticket_id: ticket.id, status: "done", summary: "built", artifacts: [] });
  await city.idle();
  await waitFor(() => said().at(-1)?.text === "All done, sir.", "the result turn and its pushed reply");
  assert.match(turns.findLast((t) => t.agentId === "jarvis").prompt, /^\[result for ticket t-[0-9a-f]+, done\] \*\*Done:\*\* the thing\./);
  assert.equal(said().at(-1).text, "All done, sir.");
  es.destroy();
});

test("question and result texts carry what Jarvis needs and nothing more", () => {
  const text = questionText({ id: "q-1", ticket_id: "t-1", question: { asked_by: "ios-dev", path: "App Manager › iOS Developer", questions: [{ text: "SwiftData?", default: "yes", options: ["yes", "no"], why: "storage" }] } });
  assert.equal(text, "[question q-1 from App Manager › iOS Developer (agent ios-dev) on ticket t-1] 1. SwiftData? Options: yes / no. Default: yes. (storage) Ask the owner.");
  assert.equal(resultText({ ticket_id: "t-1", status: "failed", summary: "nope" }), "[result for ticket t-1, failed] nope Tell the owner in plain words.");
});

test("chat.idle waits for relayed turns, so a CLI does not exit before Jarvis has told the result", async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const held = createCityChat({ city, runner: async (req) => { await slow; return { text: "told", sessionId: "s", costUsd: 0 }; }, dataDir: mkdtempSync(join(tmpdir(), "jarvis-idle-")) });
  const pending = held("x", "a");
  let settled = false;
  held.idle().then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false);
  release();
  await pending;
  await held.idle();
  assert.equal(settled, true);
});

test("the City View gets a snapshot, an agent's audit tail, and talks back through the bus", async () => {
  const snap = await call({ path: "/api/city" });
  assert.equal(snap.status, 200);
  const s = JSON.parse(snap.text);
  assert.ok(Array.isArray(s.agents) && s.agents.some((a) => a.id === "orchestrator"));
  assert.deepEqual(Object.keys(s).sort(), ["activities", "agents", "caps", "city", "department_agents", "departments", "parked", "questions", "spend", "tickets", "usage"]);
  assert.equal((await call({ path: "/api/city/audit?agent=Bad%20Name" })).status, 400);
  assert.equal((await call({ path: "/api/city/audit?agent=orchestrator" })).status, 200);
  const noAt = await call({ method: "POST", path: "/api/city/instruct", body: { text: "hello" } });
  assert.equal(noAt.status, 400);
  const unknown = await call({ method: "POST", path: "/api/city/instruct", body: { text: "@nobody do it" } });
  assert.equal(unknown.status, 400);
  assert.match(JSON.parse(unknown.text).error, /no agent nobody/);
  const ok = await call({ method: "POST", path: "/api/city/instruct", body: { text: "@orchestrator pause the app work" } });
  assert.equal(ok.status, 200);
  const t = JSON.parse(ok.text).ticket;
  assert.equal(t.kind, "direct_instruction");
  assert.equal(t.to, "orchestrator");
  const badAnswer = await call({ method: "POST", path: "/api/city/answer", body: { id: "q-none", text: "yes" } });
  assert.equal(badAnswer.status, 400);
  await city.idle();
});

test("city events reach the HUD on the same event stream", async () => {
  const pushed = [];
  const es = request({ host: "127.0.0.1", port, path: "/api/events", headers: { Host: `localhost:${port}` } });
  const opened = new Promise((resolve) => es.on("response", (res) => { res.setEncoding("utf8"); res.on("data", (chunk) => { for (const line of chunk.split("\n")) if (line.startsWith("data: ")) pushed.push(JSON.parse(line.slice(6))); }); resolve(); }));
  es.end();
  await opened;
  city.sendTicket({ to: "secretary", goal: "a city event" });
  await city.idle();
  await waitFor(() => pushed.some((e) => e.type === "city" && e.event.type === "cost.update"), "the city events");
  const cityEvents = pushed.filter((e) => e.type === "city").map((e) => e.event.type);
  assert.ok(cityEvents.includes("ticket.status"), JSON.stringify(cityEvents));
  assert.ok(cityEvents.includes("cost.update"));
  assert.ok(!cityEvents.includes("log"));
  es.destroy();
});
