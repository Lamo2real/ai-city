#!/usr/bin/env node
// PreToolUse hook for the headless Jarvis. Default deny: a tool call runs only
// if it matches a rule here. Enforces SPEC.md: read files, gh reads and writes,
// git fetch, git push to a branch other than main, and curl to the Orchestrator
// fire URL. A merge to main is never run from here: see merge.js.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ciSummary } from "./merge.js";

const RELAY_CHECK = ': "${ORCHESTRATOR_FIRE_URL:?ORCHESTRATOR_FIRE_URL is not set}" "${ORCHESTRATOR_TOKEN:?ORCHESTRATOR_TOKEN is not set}"\n';
// Copied from the /jarvis skill. The quoted heredoc keeps the instruction literal.
const RELAY_HEAD = `jq -Rs '{text: rtrimstr("\\n")}' <<'INSTRUCTION' | curl -sS -o /dev/null -w '%{http_code}\\n' --max-time 30 -X POST "$ORCHESTRATOR_FIRE_URL" -H "Authorization: Bearer $ORCHESTRATOR_TOKEN" -H "anthropic-version: 2023-06-01" -H "anthropic-beta: experimental-cc-routine-2026-04-01" -H "Content-Type: application/json" --data-binary @-\n`;
const MAX_INSTRUCTION = 4000;

const GH_READ = {
  pr: ["list", "view", "checks", "diff", "status"],
  run: ["list", "view"],
  issue: ["list", "view", "status"],
  repo: ["list", "view"],
  release: ["list", "view"],
  workflow: ["list", "view"],
  search: ["prs", "issues", "commits", "repos"],
};
const GH_WRITE = {
  pr: ["create", "edit", "comment", "close", "reopen", "ready"],
  issue: ["create", "edit", "comment", "close", "reopen"],
  run: ["rerun", "cancel"],
};
// Local files must not end up in a comment, dev must not lose its branch, and
// branch protection stays on.
const GH_WRITE_DENIED_FLAGS = new Set(["--body-file", "-F", "--web", "-w", "--editor", "-e", "--hostname", "--jq", "-q", "--template", "--delete-branch", "--admin", "--recover", "--fill", "--fill-first", "--fill-verbose"]);
const MERGE_VALUE_FLAGS = new Set(["-R", "--repo", "-b", "--body", "-t", "--subject", "-A", "--author-email", "--match-head-commit"]);
const MERGE_SWITCHES = new Set(["-s", "--squash", "-m", "--merge", "-r", "--rebase", "--auto", "--disable-auto"]);
const ORG_REPO = /^BookingSystemAdvancedOrg\/[\w.-]+$/;
const PROTECTED_BRANCH = /^(refs\/heads\/)?(main|master)$/;
const GH_DENIED_FLAGS = new Set(["--web", "--hostname", "--input", "--verbose", "--editor", "--output"]);
const SECRET_FILE = /^(\.env(\..*)?|.*\.(pem|key|p12|tfvars|tfstate)|id_(rsa|ed25519|ecdsa)|credentials|\.npmrc|\.netrc)$/i;
const SAFE_WORD = /^[\w./:=,@%+?-]+$/;

export function isRelay(command) {
  let rest = command.replace(/\s+$/, "");
  if (rest.startsWith(RELAY_CHECK)) rest = rest.slice(RELAY_CHECK.length);
  if (!rest.startsWith(RELAY_HEAD)) return false;
  rest = rest.slice(RELAY_HEAD.length);
  const lines = rest.split("\n");
  if (lines.pop() !== "INSTRUCTION") return false;
  const body = lines.join("\n");
  return body.trim().length > 0 && body.length <= MAX_INSTRUCTION && !lines.includes("INSTRUCTION");
}

// Splits a command into statements on ; && and newlines, outside quotes, and
// each statement into words. Returns null if it contains any other shell syntax.
export function parseShell(command) {
  const statements = [];
  let words = [];
  let word = null;
  const endWord = () => { if (word !== null) { words.push(word); word = null; } };
  const endStatement = () => { endWord(); if (words.length) statements.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      const end = command.indexOf('"', i + 1);
      if (end < 0) return null;
      const inner = command.slice(i + 1, end);
      if (/[$`\\!]/.test(inner)) return null;
      word = (word ?? "") + inner;
      i = end;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === ";" || c === "\n") {
      endStatement();
    } else if (c === "&" && command[i + 1] === "&") {
      endStatement();
      i++;
    } else if (SAFE_WORD.test(c)) {
      word = (word ?? "") + c;
    } else {
      return null;
    }
  }
  endStatement();
  return statements;
}

function checkGitPush(args) {
  const [remote, branch] = args;
  if (args.length !== 2 || remote !== "origin") return "git push takes exactly: origin <branch>";
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith("-") || branch === "HEAD") return "git push must name one branch, without force";
  return PROTECTED_BRANCH.test(branch) ? "main only changes through a merge the owner confirms" : null;
}

function checkGit(argv, root) {
  let i = 1;
  if (argv[i] === "-C") {
    if (!argv[i + 1] || !isInside(resolve(root, argv[i + 1]), root)) return "git -C must stay in the Booqy folder";
    i += 2;
  }
  if (argv[i] === "push") return checkGitPush(argv.slice(i + 1));
  if (argv[i] !== "fetch") return "only git fetch and git push are allowed";
  const positional = [];
  for (const arg of argv.slice(i + 1)) {
    if (["--quiet", "-q", "--prune", "-p", "--all"].includes(arg)) continue;
    if (arg.startsWith("-") || !/^[\w./-]+$/.test(arg)) return `git fetch argument not allowed: ${arg}`;
    positional.push(arg);
  }
  return positional.length <= 2 && (positional.length === 0 || positional[0] === "origin") ? null : "git fetch may only use origin";
}

function checkGhApi(args) {
  let path = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--paginate" || arg === "--slurp" || arg === "-i" || arg === "--include") continue;
    if (["-q", "--jq", "-t", "--template", "--cache"].includes(arg)) { i++; continue; }
    if (["-H", "--header"].includes(arg)) {
      if (!/^(accept|x-github-api-version):/i.test(args[++i] ?? "")) return "gh api may only set Accept headers";
      continue;
    }
    if (["-X", "--method"].includes(arg)) {
      if (args[++i]?.toUpperCase() !== "GET") return "gh api is read only";
      continue;
    }
    if (arg.startsWith("-")) return `gh api flag not allowed: ${arg}`;
    if (path !== null) return "gh api takes one path";
    path = arg;
  }
  if (path === null || path === "graphql" || path.includes("://") || path.includes("..")) return "gh api path not allowed";
  return null;
}

function repoFlag(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-R" || args[i] === "--repo") return args[i + 1];
    if (args[i].startsWith("--repo=")) return args[i].slice(7);
  }
  return null;
}

function checkGhWrite(group, sub, args) {
  for (const arg of args) {
    const flag = arg.split("=")[0];
    if (GH_WRITE_DENIED_FLAGS.has(flag)) return `gh flag not allowed: ${flag}`;
    if (flag === "-d" && sub === "close") return "deleting branches is not allowed";
  }
  return ORG_REPO.test(repoFlag(args) ?? "") ? null : `gh ${group} ${sub} needs -R BookingSystemAdvancedOrg/<repo>`;
}

function lookupPr(repo, number) {
  const out = execFileSync("gh", ["pr", "view", number, "-R", repo, "--json", "number,title,url,baseRefName,headRefOid,state,isDraft,mergeable,statusCheckRollup"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out);
}

function checkMerge(args, ctx) {
  const numbers = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (MERGE_VALUE_FLAGS.has(arg)) i++;
    else if (arg.startsWith("--repo=")) continue;
    else if (MERGE_SWITCHES.has(arg)) continue;
    else if (arg.startsWith("-")) return `gh pr merge flag not allowed: ${arg}`;
    else numbers.push(arg);
  }
  const repo = repoFlag(args);
  if (!ORG_REPO.test(repo ?? "")) return "gh pr merge needs -R BookingSystemAdvancedOrg/<repo>";
  if (numbers.length !== 1 || !/^\d+$/.test(numbers[0])) return "gh pr merge takes one PR number";
  let pr;
  try {
    pr = (ctx.lookup ?? lookupPr)(repo, numbers[0]);
  } catch {
    return "could not read the PR, so it was not merged";
  }
  if (!PROTECTED_BRANCH.test(pr.baseRefName ?? "main")) return null;
  const file = ctx.requestFile ?? process.env.JARVIS_MERGE_REQUEST_FILE;
  if (!file) return "merges to main are not available here";
  if (pr.state !== "OPEN" || pr.isDraft) return "that PR is not open and ready, so it was not merged";
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ repo, number: pr.number, title: pr.title, url: pr.url, head: pr.headRefOid, mergeable: pr.mergeable, ci: ciSummary(pr.statusCheckRollup) }), { mode: 0o600 });
  return "Not merged. A merge to main needs the owner's confirmation and the server is now asking for it. Do not retry or try another route.";
}

function checkGh(argv, ctx) {
  const [, group, sub] = argv;
  const args = argv.slice(group === "api" ? 2 : 3);
  if (group === "pr" && sub === "merge") return checkMerge(args, ctx);
  if (GH_WRITE[group]?.includes(sub)) return checkGhWrite(group, sub, args);
  // gh's --jq can read the environment, which holds the Orchestrator token.
  if (args.some((a) => /\benv\b|\$ENV|ORCHESTRATOR/.test(a))) return "reading the environment is not allowed";
  if (group === "api") return checkGhApi(args);
  if (!GH_READ[group]?.includes(sub)) return `gh ${group ?? ""} ${sub ?? ""} is not a read command`;
  for (const arg of args) {
    const flag = arg.split("=")[0];
    if (GH_DENIED_FLAGS.has(flag)) return `gh flag not allowed: ${flag}`;
    if (arg === "-w" && !(group === "run" && sub === "list")) return "gh flag not allowed: -w";
    if (arg.includes("://") && !arg.startsWith("https://github.com/BookingSystemAdvancedOrg/")) return "URL not allowed";
  }
  return null;
}

function checkStatement(argv, root, ctx) {
  // Dropping stderr is harmless and common.
  const words = argv.filter((w) => w !== "2>/dev/null");
  if (words[0] === "echo") return null;
  if (words[0] === "git") return checkGit(words, root);
  if (words[0] === "gh") return checkGh(words, ctx);
  return `${words[0]} is not allowed`;
}

// for r in a b c; do <statements>; done, as the /jarvis skill writes it.
function expandLoop(command) {
  const m = command.trim().match(/^for (\w+) in ([\w. -]+?)\s*;\s*do\s+([\s\S]+?)\s*;?\s*done$/);
  if (!m) return null;
  const [, name, values, body] = m;
  const variable = new RegExp(`\\$\\{?${name}\\}?(?!\\w)`, "g");
  return values.trim().split(/\s+/).map((v) => body.replace(variable, v)).join("\n");
}

export function checkBash(command, root, ctx = {}) {
  if (typeof command !== "string" || !command.trim()) return "empty command";
  if (isRelay(command)) return null;
  const cleaned = command.replace(/ 2>\/dev\/null/g, " ");
  const statements = parseShell(expandLoop(cleaned) ?? cleaned);
  if (!statements?.length) {
    return "Only plain gh commands, git fetch, git push, or the exact Orchestrator command from the skill are allowed. No pipes, substitution or redirects; use gh --jq to filter.";
  }
  for (const argv of statements) {
    const problem = checkStatement(argv, root, ctx);
    if (problem) return problem;
  }
  return null;
}

function isInside(path, dir) {
  return path === dir || path.startsWith(dir + sep);
}

function real(path) {
  // A path that does not exist yet resolves through its nearest real parent.
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
}

export function checkPath(path, root, home = homedir()) {
  if (path === undefined || path === null || path === "") return null;
  if (typeof path !== "string") return "bad path";
  const expanded = path.replace(/^~(?=$|\/)/, home);
  const target = real(isAbsolute(expanded) ? expanded : resolve(root, expanded));
  if (SECRET_FILE.test(basename(target))) return "secret files are off limits";
  const slug = real(root).replace(/[^a-zA-Z0-9]/g, "-");
  // Claude Code saves long tool output under its project folder or a temp
  // folder and reads it back from there.
  const allowed = [real(root), join(home, ".claude", "projects", slug), "/tmp/claude-", "/private/tmp/claude-"];
  const ok = allowed.some((dir) => (dir.endsWith("claude-") ? target.startsWith(dir) : isInside(target, dir)));
  return ok ? null : "reads are limited to the Booqy folder";
}

export function checkTool(input, root, home, ctx = {}) {
  const tool = input.tool_name;
  const args = input.tool_input ?? {};
  switch (tool) {
    case "Skill":
      return args.skill === "jarvis" ? null : "only the jarvis skill is allowed";
    case "Read":
      return checkPath(args.file_path, root, home);
    case "Glob":
    case "Grep": {
      const pattern = tool === "Glob" ? args.pattern : args.glob;
      if (typeof pattern === "string" && (pattern.includes("..") || /^[/~]/.test(pattern))) return "patterns must stay in the Booqy folder";
      return checkPath(args.path, root, home);
    }
    case "Bash":
      return checkBash(args.command, root, ctx);
    default:
      return `${tool} is not allowed`;
  }
}

function main() {
  let problem;
  try {
    const root = process.env.JARVIS_BOOQY_DIR;
    if (!root) throw new Error("JARVIS_BOOQY_DIR is not set");
    problem = checkTool(JSON.parse(readFileSync(0, "utf8")), root);
  } catch (err) {
    problem = `guard failed: ${err.message}`;
  }
  const decision = problem ? { permissionDecision: "deny", permissionDecisionReason: problem } : { permissionDecision: "allow", permissionDecisionReason: "Jarvis guard" };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...decision } }));
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
