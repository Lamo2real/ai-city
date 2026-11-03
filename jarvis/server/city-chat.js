// Jarvis as the front door of AI City: one conversation per HUD session shared by
// typed and spoken turns, with the Agent SDK session resumed each turn. Same contract
// as chat.js: chat(message, sessionId, { onEvent, signal }) → reply text. Questions
// and results from the city come back through Jarvis as unprompted messages (chat.on).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorePrompt } from "city";

// Jarvis's own tools (jarvis-spotify) live in jarvis/bin. Put it on the agents' PATH however
// the process was started: launchd runs `node server/server.js` directly, not through jarvis-env.
export const JARVIS_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
export const withJarvisBin = (env) => ({ ...env, PATH: [JARVIS_BIN, ...String(env.PATH ?? "").split(delimiter).filter((p) => p && p !== JARVIS_BIN)].join(delimiter) });

export function questionText(e) {
  const q = e.question;
  const lines = q.questions.map((x, i) => `${i + 1}. ${x.text}${x.options?.length ? ` Options: ${x.options.join(" / ")}.` : ""} Default: ${x.default}.${x.why ? ` (${x.why})` : ""}`);
  return `[question ${e.id} from ${q.path} (agent ${q.asked_by}) on ticket ${e.ticket_id}] ${lines.join(" ")} Ask the owner.`;
}

export const resultText = (e) => `[result for ticket ${e.ticket_id}, ${e.status}] ${e.summary} Tell the owner in plain words.`;

export function createCityChat({ city, runner, dataDir, logger = () => {} }) {
  const prompt = loadCorePrompt("jarvis");
  const file = join(dataDir, "city-sessions.json");
  let sessions = {};
  try { sessions = JSON.parse(readFileSync(file, "utf8")); } catch { /* first run */ }
  const queues = new Map();
  const listeners = new Set();
  const owners = new Map(); // ticket id → HUD session that started it
  let lastSession = Object.keys(sessions)[0] ?? "hud";

  function remember(sessionId, sdkId) {
    sessions[sessionId] = sdkId;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, JSON.stringify(sessions), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  async function turn(message, sessionId, { onEvent, signal } = {}) {
    lastSession = sessionId;
    const before = new Set(city.openTickets().map((t) => t.id));
    let result;
    try {
      result = await runner({
        agentId: "jarvis", systemPrompt: prompt.body, model: prompt.model, effort: prompt.effort, allowedTools: prompt.tools, tools: city.toolsFor("jarvis"),
        prompt: message, resume: sessions[sessionId], signal,
        onText: (text) => onEvent?.({ type: "text", text }),
        onTool: (name, input) => onEvent?.({ type: "tool", name, input }),
      });
    } catch (err) {
      // A conversation the SDK no longer has is not worth failing over.
      if (!sessions[sessionId] || !/no conversation found/i.test(err.message)) throw err;
      logger("session expired, starting a new conversation");
      delete sessions[sessionId];
      return turn(message, sessionId, { onEvent, signal });
    }
    onEvent?.({ type: "flush" });
    if (result.sessionId) remember(sessionId, result.sessionId);
    for (const t of city.openTickets()) if (!before.has(t.id)) owners.set(t.id, sessionId);
    return result.text.trim();
  }

  // One turn at a time per conversation, so resume never races itself.
  const chat = function chat(message, sessionId, options) {
    const next = (queues.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(() => turn(message, sessionId, options));
    queues.set(sessionId, next);
    return next;
  };
  chat.on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  chat.city = city; // for the City View's snapshot, events and bus endpoints
  chat.idle = () => Promise.allSettled([...queues.values()]);

  // The city speaks through Jarvis: its question or result becomes a Jarvis turn, told unprompted.
  async function relay(text, ticketId) {
    const sessionId = owners.get(ticketId) ?? lastSession;
    try {
      const reply = await chat(text, sessionId);
      if (reply) for (const fn of listeners) fn({ sessionId, text: reply });
    } catch (err) {
      logger(`relay failed: ${err.message}`);
    }
  }
  city.on((e) => {
    if (e.type === "question") relay(questionText(e), e.ticket_id);
    else if (e.type === "result") relay(resultText(e), e.ticket_id);
    else if (e.type === "log") logger(`city: ${e.text}`);
  });
  return chat;
}
