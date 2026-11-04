// The gate every turn passes: concurrency, usage-limit pause, retries, timeouts, cancellation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGate, isTransient, parseReset } from "../src/scheduler.ts";
import { UsageLimit, isPausableLimit, isUsageLimit } from "../src/sdk.ts";

const tick = () => new Promise((r) => setImmediate(r));

test("the real usage-limit text is recognised, inside the SDK's own sentence", () => {
  const real = "Claude Code returned an error result: You've hit your 5-hour limit · resets 6:30am (Europe/Stockholm)";
  assert.ok(isUsageLimit(real));
  assert.ok(isPausableLimit(real));
  assert.ok(isUsageLimit("Your seat type doesn't include usage credits"));
  assert.ok(!isPausableLimit("Your seat type doesn't include usage credits"), "that one never passes with time");
  assert.ok(!isUsageLimit("the tests passed"));
});

test("the reset time is read from the message in its own time zone, and waiting never goes backwards", () => {
  const at = Date.parse("2026-11-04T01:36:00Z"); // 02:36 in Stockholm
  const until = parseReset("You've hit your 5-hour limit · resets 6:30am (Europe/Stockholm)", at);
  assert.equal(new Date(until).toISOString(), "2026-11-04T05:31:00.000Z", "06:30 Stockholm plus a minute's margin");
  assert.equal(parseReset("You've hit your limit", at), at + 30 * 60_000, "no time in the message: half an hour");
  assert.equal(parseReset("resets 6am (Not/AZone)", at), at + 30 * 60_000);
  const pm = parseReset("resets 3pm (UTC)", Date.parse("2026-11-04T16:00:00Z"));
  assert.equal(new Date(pm).toISOString(), "2026-11-05T00:00:00.000Z", "already past today: capped at eight hours");
});

test("no more than the limit run at once; the rest wait their turn in order", async () => {
  const gate = createGate({ maxConcurrent: 2 });
  let running = 0, peak = 0;
  const order: number[] = [];
  const release: Array<() => void> = [];
  const job = (i: number) => gate.run(async () => { running++; peak = Math.max(peak, running); order.push(i); await new Promise<void>((r) => release.push(r)); running--; return i; });
  const all = [0, 1, 2, 3].map(job);
  await tick();
  assert.equal(peak, 2);
  assert.equal(gate.active, 2);
  assert.equal(gate.waiting, 2);
  while (release.length || running) { release.shift()?.(); await tick(); }
  assert.deepEqual(await Promise.all(all), [0, 1, 2, 3]);
  assert.deepEqual(order, [0, 1, 2, 3]);
  assert.equal(gate.active, 0);
});

test("a usage limit pauses the whole city and the same turn runs again after the reset; nothing fails", async () => {
  let clock = 1_000_000;
  const slept: number[] = [];
  const events: string[] = [];
  const gate = createGate({ maxConcurrent: 2, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; }, onPause: () => events.push("pause"), onResume: () => events.push("resume") });
  let calls = 0;
  const result = await gate.run(async () => { calls++; if (calls === 1) throw new UsageLimit("You've hit your 5-hour limit"); return "done"; });
  assert.equal(result, "done");
  assert.equal(calls, 2);
  assert.deepEqual(slept, [30 * 60_000]);
  assert.deepEqual(events, ["pause", "resume"]);
  assert.equal(gate.paused, 0);
});

test("a limit that never passes is a failure, not an endless wait", async () => {
  const gate = createGate({ maxConcurrent: 1, sleep: async () => {} });
  await assert.rejects(gate.run(async () => { throw new UsageLimit("Your seat type doesn't include usage"); }), /seat type/);
  assert.equal(gate.active, 0);
});

test("a provider hiccup is retried with its attempt number, a real error is not", async () => {
  const slept: number[] = [];
  const gate = createGate({ maxConcurrent: 1, retries: 2, backoffMs: [5, 30], sleep: async (ms) => { slept.push(ms); } });
  const attempts: number[] = [];
  const ok = await gate.run(async ({ attempt }) => { attempts.push(attempt); if (attempt < 2) throw new Error("529 overloaded"); return "ok"; });
  assert.equal(ok, "ok");
  assert.deepEqual(attempts, [0, 1, 2]);
  assert.deepEqual(slept, [5, 30]);
  let tries = 0;
  await assert.rejects(gate.run(async () => { tries++; throw new Error("overloaded for good 529"); }), /overloaded/);
  assert.equal(tries, 3, "gives up after the retries");
  tries = 0;
  await assert.rejects(gate.run(async () => { tries++; throw new Error("the file does not exist"); }), /does not exist/);
  assert.equal(tries, 1);
  assert.ok(isTransient("fetch failed") && isTransient("socket hang up") && !isTransient("syntax error"));
  assert.equal(gate.active, 0);
});

test("a turn past its deadline is stopped and its signal fires; cancelling does the same", async () => {
  const gate = createGate({ maxConcurrent: 1, timeoutMs: 20 });
  let aborted = false;
  await assert.rejects(gate.run(({ signal }) => new Promise((_, reject) => { signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted by signal")); }); })), /timed out|aborted/);
  assert.ok(aborted);
  assert.equal(gate.active, 0);
  const ctrl = new AbortController();
  const cancelled = gate.run(() => new Promise(() => {}), ctrl.signal);
  ctrl.abort(new Error("ticket cancelled"));
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(gate.active, 0);
  const gone = new AbortController();
  gone.abort(new Error("x"));
  await assert.rejects(gate.run(async () => "never", gone.signal), /cancelled/);
});
