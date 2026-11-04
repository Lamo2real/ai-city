// The core agents must not hold a generic script runner: `osascript` (do shell script), interpreters,
// env/xargs/curl or a bare Bash would let the model walk around the merge gate and the email gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadCorePrompt } from "city";

const DIR = fileURLToPath(new URL("../../agents/core/", import.meta.url));

// Every Bash entry a core agent may hold: dedicated CLIs and fixed read-only subcommands, exactly.
export const ALLOWED_BASH = new Set(["Bash(jarvis-spotify:*)", "Bash(jarvis-mail:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(terraform show:*)"]);
const RUNNERS = /^(osascript|open|sh|bash|zsh|dash|ksh|fish|node|nodejs|deno|bun|npx|npm|python[\d.]*|ruby|perl|php|lua|curl|wget|env|xargs|sudo|eval|exec|osacompile|swift|jxa)$/i;

// Pass this checkout's agents dir: the `city` package may be linked from another worktree.
const AGENTS = fileURLToPath(new URL("../../agents/", import.meta.url));
const toolsOf = (file) => loadCorePrompt(file.replace(/\.md$/, ""), AGENTS).tools;

const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));

test("there are core agents to check", () => {
  assert.ok(files.includes("jarvis.md"));
});

for (const file of files) {
  test(`${file}: no osascript, generic runner or bare Bash in tools`, () => {
    for (const tool of toolsOf(file)) {
      if (!/^Bash\b/.test(tool)) continue;
      assert.notEqual(tool, "Bash", `${file}: bare Bash`);
      const cmd = /^Bash\(\s*([^\s:)*]+)/.exec(tool)?.[1];
      assert.ok(cmd, `${file}: unreadable Bash entry ${tool}`);
      assert.ok(!RUNNERS.test(cmd.split("/").pop()), `${file}: ${tool} is a generic runner`);
      assert.ok(ALLOWED_BASH.has(tool), `${file}: ${tool} is not an approved dedicated CLI`);
    }
  });
}

test("jarvis holds exactly the two dedicated CLIs and no shell, and its prompt never mentions osascript", () => {
  assert.deepEqual(toolsOf("jarvis.md").filter((t) => /^Bash\b/.test(t)).sort(), ["Bash(jarvis-mail:*)", "Bash(jarvis-spotify:*)"]);
  assert.doesNotMatch(readFileSync(join(DIR, "jarvis.md"), "utf8"), /osascript/i);
});

test("the checker rejects what it should", () => {
  for (const bad of ["osascript", "bash", "python3", "node", "curl", "env", "xargs", "open"]) assert.match(bad, RUNNERS);
  assert.doesNotMatch("jarvis-spotify", RUNNERS);
  assert.ok(!ALLOWED_BASH.has("Bash(osascript:*)"));
});
