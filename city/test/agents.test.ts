import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCorePrompt, parsePrompt, renderTemplate } from "../src/agents.ts";

test("the four core prompts load with model, effort and tools", () => {
  const jarvis = loadCorePrompt("jarvis");
  assert.equal(jarvis.model, "claude-haiku-5-5");
  assert.equal(jarvis.effort, "low");
  assert.ok(jarvis.tools.includes("mcp__jarvis__send_ticket"));
  assert.match(jarvis.body, /^You are Jarvis/);
  assert.equal(loadCorePrompt("orchestrator").model, "claude-opus-5-5");
  assert.equal(loadCorePrompt("secretary").model, "claude-sonnet-5-5");
  assert.equal(loadCorePrompt("reviewer").model, "claude-fable-5-1");
});

test("frontmatter needs name, model and tools", () => {
  assert.throws(() => parsePrompt("no frontmatter"), /no frontmatter/);
  assert.throws(() => parsePrompt("---\nname: x\n---\nbody"), /missing model/);
  const p = parsePrompt('---\nname: "x"\nmodel: claude-haiku-5-5\ntools: "A, B"\n---\nbody');
  assert.deepEqual(p.tools, ["A", "B"]);
  assert.equal(p.effort, "medium");
});

test("templates fill every placeholder and refuse a missing one", () => {
  const text = renderTemplate("worker", { id: "ios-dev", specialty: "iOS", parent: "app-manager", tools: "Read, Edit" });
  const p = parsePrompt(text);
  assert.equal(p.name, "ios-dev");
  assert.deepEqual(p.tools, ["mcp__jarvis__report", "mcp__jarvis__ask_user", "mcp__jarvis__remember", "mcp__jarvis__recall", "mcp__jarvis__read_skill", "mcp__jarvis__ask_colleague", "Read", "Edit"]);
  assert.match(p.body, /@ios-dev/);
  assert.throws(() => renderTemplate("manager", { id: "m" }), /needs \{\{department\}\}/);
});
