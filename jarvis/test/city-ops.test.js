// The organization's routes, the phone's limits, and the two commands schedules use.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttp, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { createCity, loadPolicy } from "city";
import { PassThrough } from "node:stream";
import { createServer, handleCity } from "../server/server.js";

const run = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
const dir = mkdtempSync(join(tmpdir(), "jarvis-ops-"));
const policy = { ...loadPolicy(), audit_log: join(dir, "audit.jsonl") };
const city = createCity({ runner: async () => ({ text: "", sessionId: "s", costUsd: 0, tokens: 0 }), dataDir: dir, ledgerPath: ":memory:", policy });
const chat = Object.assign(async () => "ok", { city, on: () => {} });
let server, port;
before(async () => {
  server = createServer({ booqyDir: dir, dataDir: dir, port: 0, getState: async () => ({}), chat, speak: async () => null, transcribe: async () => "" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => { server.closeAllConnections(); server.close(); city.close(); });

const api = (method, path, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : undefined;
  const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: `localhost:${port}`, ...(data && { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }) } }, (res) => {
    let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
  });
  req.on("error", reject);
  req.end(data);
});

test("the organization can be read and run over the local routes", async () => {
  const made = await api("POST", "/api/city/departments", { name: "Research", mission: "find things out" });
  assert.equal(made.status, 200);
  assert.equal(made.body.department.name, "Research");
  const again = await api("POST", "/api/city/departments", { name: "research", mission: "find things out" });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /"Research" already covers this/, "no second department for the same work");
  assert.ok((await api("GET", "/api/city/departments")).body.some((d) => d.name === "Research"));
  for (const path of ["/api/city/costs", "/api/city/workforce", "/api/city/health", "/api/city/workflows", "/api/city/memory?q=x"]) assert.equal((await api("GET", path)).status, 200, path);
  const skills = (await api("GET", "/api/city/skills")).body;
  assert.ok(skills.some((s) => s.name === "aws" && s.description && s.version));
  assert.equal((await api("GET", "/api/city/trace?ticket=../../etc")).status, 400);
  assert.equal((await api("POST", "/api/city/tickets/cancel", { ids: "t-1" })).status, 400);
  assert.equal((await api("POST", "/api/city/workflows/start", { name: "nope" })).status, 400, "a bad workflow is refused, not a crash");
});

test("an unrouted event starts nothing, and a routed one starts one ticket", async () => {
  assert.deepEqual((await api("POST", "/api/city/events", { source: "x", type: "nobody.owns.this", summary: "s" })).body, { routed: false });
  const r = await api("POST", "/api/city/events", { source: "c", type: "briefing.daily", summary: "s", idempotency_key: "k1" });
  assert.equal(r.body.routed, true);
  assert.equal((await api("POST", "/api/city/events", { source: "c", type: "briefing.daily", summary: "s", idempotency_key: "k1" })).body.duplicate, true);
});

test("the phone keeps its view, answers and instructions, and cannot run the organization", async () => {
  const fake = (method, url) => {
    const res = { code: 0, setHeader() {}, writeHead(c) { this.code = c; return this; }, end() {} };
    return [Object.assign(new PassThrough(), { method, url, headers: {} }), res];
  };
  for (const [method, path] of [["POST", "/api/city/events"], ["POST", "/api/city/departments"], ["POST", "/api/city/workflows/start"], ["POST", "/api/city/tickets/cancel"], ["POST", "/api/city/tickets/resume"], ["GET", "/api/city/integrations"], ["GET", "/api/city/memory"], ["GET", "/api/city/trace"], ["GET", "/api/city/costs"]]) {
    const [req, res] = fake(method, path);
    await handleCity(req, res, city, path, true);
    assert.equal(res.code, 403, path);
  }
  const [req, res] = fake("GET", "/api/city");
  await handleCity(req, res, city, "/api/city", true);
  assert.equal(res.code, 200);
  const [one, oneRes] = fake("GET", "/api/city/agent?id=orchestrator");
  await handleCity(one, oneRes, city, "/api/city/agent", true);
  assert.equal(oneRes.code, 200, "the status panel works on the phone");
});

test("an approval cannot be decided from the phone; an ordinary answer can", async () => {
  const post = async (body) => {
    const req = Object.assign(new PassThrough(), { method: "POST", url: "/api/city/answer", headers: { "content-type": "application/json" } });
    const res = { code: 0, setHeader() {}, writeHead(c) { this.code = c; return this; }, end() {} };
    const done = handleCity(req, res, city, "/api/city/answer", true);
    req.end(JSON.stringify(body));
    await done;
    return res.code;
  };
  const t = city.sendTicket({ to: "orchestrator", goal: "g" });
  await city.idle();
  city.ledger.updateTicket(t.id, { status: "in_progress" });
  city.guardForTicket("orchestrator", t.id)("Bash", { command: "terraform destroy" });
  const q = city.ledger.openQuestions().find((o) => o.question.asked_by === "orchestrator" && city.ledger.approvalByQuestion(o.id));
  assert.equal(await post({ id: q.id, text: "approve" }), 403);
  assert.equal(city.ledger.getQuestion(q.id).status, "open");
});

function recorder() {
  const seen = [];
  const http = createHttp((req, res) => {
    let d = ""; req.on("data", (c) => { d += c; }); req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST") { seen.push(JSON.parse(d)); return res.end('{"routed":true,"ticket":"t-9"}'); }
      if (req.url === "/api/city/health") return res.end(JSON.stringify({ failed_today: http.failed ?? 0 }));
      res.end(JSON.stringify({ today: 1.5 }));
    });
  });
  return new Promise((r) => http.listen(0, "127.0.0.1", () => r({ http, seen, url: `http://127.0.0.1:${http.address().port}` })));
}

test("city-event: checks cost nothing unless something happened; failures become events with stable keys", async () => {
  const rec = await recorder();
  const fake = mkdtempSync(join(tmpdir(), "fake-bin-"));
  const runs = [
    { databaseId: 7, conclusion: "failure", name: "CI", headBranch: "main", url: "u", updatedAt: new Date().toISOString() },
    { databaseId: 8, conclusion: "success", name: "CI", headBranch: "main", url: "u", updatedAt: new Date().toISOString() },
    { databaseId: 9, conclusion: "failure", name: "Old", headBranch: "main", url: "u", updatedAt: "2020-01-01T00:00:00Z" },
  ];
  writeFileSync(join(fake, "gh"), `#!/bin/sh\necho '${JSON.stringify(runs)}'\n`);
  chmodSync(join(fake, "gh"), 0o755);
  const cfg = join(fake, "a.json");
  writeFileSync(cfg, JSON.stringify({ github_repos: ["o/r"] }));
  const env = { ...process.env, JARVIS_URL: rec.url, CITY_AUTOMATIONS: cfg, PATH: `${fake}:${process.env.PATH}` };
  const event = (...a) => run(process.execPath, [join(BIN, "city-event"), ...a], { env });

  await event("watch-failures");
  assert.equal(rec.seen.length, 0, "nothing failed, so nothing is sent");
  rec.http.failed = 3;
  await event("watch-failures");
  assert.equal(rec.seen.at(-1).type, "city.tickets_failed");

  rec.seen.length = 0;
  await event("watch-github");
  assert.deepEqual(rec.seen.map((e) => e.idempotency_key), ["gh-o/r-7"], "only a recent failure");

  rec.seen.length = 0;
  await event("briefing");
  assert.equal(rec.seen[0].type, "briefing.daily");
  assert.equal(rec.seen[0].data.costs.estimated, true);
  await event("emit", "stripe", "stripe.paid", "paid", "p1");
  assert.equal(rec.seen.at(-1).idempotency_key, "p1");
  await assert.rejects(event("nonsense"), /unknown command/);
  await assert.rejects(event("emit", "only-source"), /usage/);
  rec.http.closeAllConnections(); rec.http.close();
});

test("city-automations: every schedule starts off, and enable and disable only touch the city's own jobs", async () => {
  const fake = mkdtempSync(join(tmpdir(), "fake-oc-"));
  const log = join(fake, "log"), jobs = join(fake, "jobs.json");
  writeFileSync(jobs, JSON.stringify({ jobs: [{ id: "other", name: "owner-job" }] }));
  writeFileSync(join(fake, "cli"), `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$2" = "list" ]; then cat "${jobs}"; fi\n`);
  chmodSync(join(fake, "cli"), 0o755);
  const cfg = join(fake, "a.json");
  writeFileSync(cfg, JSON.stringify({ schedules: [{ id: "daily", cron: "0 7 * * *", command: ["jarvis/bin/city-event", "briefing"] }] }));
  const env = { ...process.env, JARVIS_OPENCLAW_CLI: join(fake, "cli"), CITY_AUTOMATIONS: cfg };
  const auto = (...a) => run(process.execPath, [join(BIN, "city-automations"), ...a], { env }).then((r) => r.stdout);

  assert.match(await auto("list"), /^off\s+daily/);
  assert.match(await auto("disable", "daily"), /already off/);
  assert.match(await auto("enable", "daily"), /daily is on/);
  const added = readFileSync(log, "utf8").split("\n").find((l) => l.startsWith("cron add"));
  assert.match(added, /--name city-daily --cron 0 7 \* \* \* --command-argv \[".*jarvis\/bin\/city-event","briefing"\]/);
  writeFileSync(jobs, JSON.stringify({ jobs: [{ id: "other", name: "owner-job" }, { id: "j1", name: "city-daily" }] }));
  assert.match(await auto("list"), /^on\s+daily/);
  assert.match(await auto("enable", "daily"), /already on/);
  assert.match(await auto("disable", "daily"), /daily is off/);
  assert.ok(readFileSync(log, "utf8").includes("cron rm j1"));
  assert.ok(!readFileSync(log, "utf8").includes("rm other"));
  await assert.rejects(auto("enable", "nope"), /no schedule/);
});
