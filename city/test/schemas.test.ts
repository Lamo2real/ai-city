import assert from "node:assert/strict";
import { test } from "node:test";
import { SchemaError, errors, loadSchema, validate } from "../src/schemas.ts";

const spec = { id: "ios-dev", role: "iOS Developer", kind: "worker", parent: "app-manager", model: "claude-sonnet-5-5", mission: "Build it", tools: ["Read", "Edit"], lifecycle: "persistent", budget_usd_per_day: 5 };

test("a good agent spec passes; bad ones name the problem", () => {
  assert.deepEqual(validate("agent_spec", spec), spec);
  assert.throws(() => validate("agent_spec", { ...spec, extra: 1 }), (e: SchemaError) => /unknown field extra/.test(e.message));
  assert.throws(() => validate("agent_spec", { ...spec, id: "iOS Dev" }), /does not match/);
  assert.throws(() => validate("agent_spec", { ...spec, model: "gpt-5" }), /must be one of/);
  assert.throws(() => validate("agent_spec", { ...spec, tools: [] }), /fewer than 1/);
  const { tools: _t, ...noTools } = spec;
  assert.throws(() => validate("agent_spec", noTools), /missing tools/);
  assert.throws(() => validate("agent_spec", { ...spec, budget_usd_per_day: -1 }), /below 0/);
  assert.throws(() => validate("agent_spec", { ...spec, mission: "x".repeat(601) }), /longer than 600/);
});

test("tickets and questions use their schemas", () => {
  const t = { id: "t1", from: "jarvis", to: "orchestrator", kind: "task", goal: "g", status: "open", created_at: "2026-01-01T00:00:00Z", parent_id: null, cc: ["x"] };
  assert.deepEqual(validate("ticket", t), t);
  assert.throws(() => validate("ticket", { ...t, status: "pending" }), /must be one of/);
  assert.throws(() => validate("ticket", { ...t, cc: "x" }), /expected array/);
  const q = { ticket_id: "t1", asked_by: "ios-dev", path: "App Manager › iOS Developer", questions: [{ text: "Swift?", default: "yes", options: ["yes", "no"] }] };
  assert.deepEqual(validate("question", q), q);
  assert.throws(() => validate("question", { ...q, questions: [] }), /fewer than 1/);
  assert.throws(() => validate("question", { ...q, questions: [{ text: "no default" }] }), /missing default/);
  assert.throws(() => validate("question", { ...q, questions: Array(5).fill(q.questions[0]) }), /more than 4/);
});

test("the validator reports every problem, with paths", () => {
  const problems = errors(loadSchema("ticket"), { id: 1, kind: "nope" });
  assert.ok(problems.some((p) => p.startsWith("$.id: expected string")));
  assert.ok(problems.some((p) => p.startsWith("$.kind: must be one of")));
  assert.ok(problems.some((p) => p === "$: missing goal"));
});
