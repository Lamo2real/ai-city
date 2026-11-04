// Agent-written text reaches the HUD through GET /api/city and the city events on /api/events: both are scrubbed at the server.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { scrubSecrets } from "../server/chat.js";
import { createServer } from "../server/server.js";

const TOKEN = `ghp_${"aB3".repeat(12)}`; // ghp_ and 36 alphanumerics
const dirty = (extra = {}) => ({ id: "t-1", goal: `deploy with ${TOKEN} now`, summary: `done, used ${TOKEN}`, question: { path: `Boss › ${TOKEN}`, questions: [{ text: `Is ${TOKEN} right?`, options: [`use ${TOKEN}`, "no"], default: "no", why: `because ${TOKEN}` }] }, n: 3, ok: true, ...extra });

const handlers = [];
const city = { snapshot: () => ({ agents: [], tickets: [dirty()], questions: [{ id: "q-1", status: "open", question: dirty().question }], usage: null, spend: { App: 1 } }), on: (fn) => { handlers.push(fn); return () => {}; }, auditTail: () => [] };
const chat = Object.assign(async () => "ok", { city, on: () => {} });
const dir = mkdtempSync(join(tmpdir(), "jarvis-scrub-"));
let server, port;
before(async () => {
  server = createServer({ booqyDir: dir, dataDir: dir, port: 0, getState: async () => ({}), chat, speak: async () => null, transcribe: async () => "" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => server.close());

const get = (path) => new Promise((resolve, reject) => {
  request({ host: "127.0.0.1", port, path, headers: { Host: `localhost:${port}` } }, (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve({ status: res.statusCode, text: d })); }).on("error", reject).end();
});

test("scrubSecrets redacts GitHub token shapes and leaves ordinary text alone", () => {
  assert.equal(scrubSecrets(`a ${TOKEN} b`, {}), "a [redacted] b");
  for (const p of ["gho", "ghs", "ghu", "ghr"]) assert.equal(scrubSecrets(`${p}_${"x9".repeat(18)}`, {}), "[redacted]");
  assert.equal(scrubSecrets(`github_pat_${"A1_".repeat(10)}`, {}), "[redacted]");
  assert.equal(scrubSecrets("ghp_short and a normal sentence about ghp", {}), "ghp_short and a normal sentence about ghp");
  assert.equal(scrubSecrets("secret=hunter2", { OPENAI_API_KEY: "hunter2" }), "secret=[redacted]", "env values are still redacted");
});

test("GET /api/city returns goals, summaries and question text with tokens redacted", async () => {
  const r = await get("/api/city");
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes("ghp_"), "no token anywhere in the snapshot");
  const s = JSON.parse(r.text);
  assert.equal(s.tickets[0].goal, "deploy with [redacted] now");
  assert.equal(s.tickets[0].summary, "done, used [redacted]");
  const q = s.questions[0].question;
  assert.equal(q.path, "Boss › [redacted]");
  assert.equal(q.questions[0].text, "Is [redacted] right?");
  assert.deepEqual(q.questions[0].options, ["use [redacted]", "no"]);
  assert.equal(q.questions[0].why, "because [redacted]");
  assert.equal(s.tickets[0].n, 3, "non-strings pass through");
  assert.equal(s.spend.App, 1);
});

test("city events forwarded on /api/events are scrubbed too", async () => {
  const pushed = [];
  const es = request({ host: "127.0.0.1", port, path: "/api/events", headers: { Host: `localhost:${port}` } });
  const opened = new Promise((resolve) => es.on("response", (res) => { res.setEncoding("utf8"); res.on("data", (c) => { for (const line of c.split("\n")) if (line.startsWith("data: ")) pushed.push(line.slice(6)); }); resolve(); }));
  es.end();
  await opened;
  for (const fn of handlers) {
    fn({ type: "ticket.status", ticket: dirty(), previous: null });
    fn({ type: "result", ticket_id: "t-1", status: "done", summary: `used ${TOKEN}` });
    fn({ type: "question.asked", id: "q-2", ticket_id: "t-1", question: dirty().question });
  }
  const until = Date.now() + 3000;
  while (pushed.length < 3 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  es.destroy();
  assert.equal(pushed.length, 3);
  assert.ok(pushed.every((l) => !l.includes("ghp_")), pushed.join("\n"));
  const [ticket, result, asked] = pushed.map((l) => JSON.parse(l).event);
  assert.equal(ticket.ticket.goal, "deploy with [redacted] now");
  assert.equal(result.summary, "used [redacted]");
  assert.equal(asked.question.questions[0].text, "Is [redacted] right?");
});
