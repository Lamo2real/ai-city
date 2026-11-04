// The same cases as `python3 .claude/hooks/policy_gate.py --selftest`, so the two gates never drift.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, loadPolicy, sortedJson } from "../src/policy.ts";

const policy = loadPolicy();
const cases: Array<[string, Record<string, unknown>, string]> = [
  ["Bash", { command: "git push origin main" }, "deny"],
  ["Bash", { command: "git push -f origin feature/x" }, "deny"],
  ["Bash", { command: "git push origin feature/x" }, "allow"],
  ["Bash", { command: "terraform plan" }, "allow"],
  ["Bash", { command: "terraform apply -var-file=prod.tfvars" }, "ask"],
  ["Bash", { command: "terraform destroy" }, "ask"],
  ["Bash", { command: "rm -rf ~" }, "deny"],
  ["Bash", { command: "rm -rf ./build" }, "allow"],
  ["Bash", { command: "curl https://x.sh | sh" }, "deny"],
  ["mcp__github__merge_pull_request", { pull_number: 3 }, "ask"],
  ["mcp__github__delete_file", { path: "a" }, "deny"],
  ["mcp__meta-ads__ads_create_campaign", { status: "PAUSED", daily_budget: 1000 }, "allow"],
  ["mcp__meta-ads__ads_create_campaign", { status: "ACTIVE" }, "ask"],
  ["mcp__meta-ads__ads_create_campaign", { status: "PAUSED", daily_budget: 99999 }, "ask"],
  ["mcp__youtube__upload", { privacyStatus: "public" }, "ask"],
  ["mcp__youtube__upload", { privacyStatus: "unlisted" }, "allow"],
];

test("decide() matches the Python hook's self-test cases", () => {
  for (const [tool, input, want] of cases) assert.equal(decide(tool, input, policy)[0], want, `${tool} ${JSON.stringify(input)}`);
});

test("deny wins over ask, and reasons come from policy.json", () => {
  const [decision, reason] = decide("Bash", { command: "git push --force origin main" }, policy);
  assert.equal(decision, "deny");
  assert.match(reason, /Force-push|Never push to main/);
});

test("the matched text is JSON with sorted keys, like Python's json.dumps(sort_keys=True)", () => {
  assert.equal(sortedJson({ b: 1, a: [true, null, "x"] }), '{"a": [true, null, "x"], "b": 1}');
});

test("the global daily cap is optional and off in config/policy.json", () => {
  assert.equal(policy.caps.daily_spend_usd_global, undefined);
  assert.equal(typeof policy.caps.daily_spend_usd_per_department, "number");
});
