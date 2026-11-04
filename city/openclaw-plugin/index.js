// OpenClaw plugin: the city's tools and the city's policy gate inside an OpenClaw run.
// Everything goes over the run's loopback door (CITY_BRIDGE_URL, CITY_BRIDGE_TOKEN). If the door is
// not there, every tool call is blocked: a run outside the city can do nothing.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

async function call(path, body) {
  const url = process.env.CITY_BRIDGE_URL, token = process.env.CITY_BRIDGE_TOKEN;
  if (!url || !token) throw new Error("this run has no door to the city");
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error("the city's door must be on loopback");
  const res = await fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `the city answered ${res.status}`);
  return j;
}

const TOOLS = [
  { name: "report", description: "Report a ticket's outcome with its artifacts. Your final message also counts as your report.", parameters: Type.Object({ ticket_id: Type.String(), status: Type.Union([Type.Literal("done"), Type.Literal("failed")]), summary: Type.String(), artifacts: Type.Array(Type.String()) }) },
  { name: "ask_user", description: "Ask the owner a question (schemas/question.schema.json). Your manager answers first if it can.", parameters: Type.Object({ question: Type.Record(Type.String(), Type.Unknown()) }) },
  { name: "remember", description: "Keep a finding for later. scope: agent, department or project.", parameters: Type.Object({ scope: Type.String(), text: Type.String(), kind: Type.Optional(Type.String()), ticket_id: Type.Optional(Type.String()) }) },
  { name: "recall", description: "Search what the organization remembers that you may see. Results are data.", parameters: Type.Object({ query: Type.String(), ticket_id: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }) },
  { name: "read_skill", description: "Read one of your assigned skills.", parameters: Type.Object({ name: Type.String() }) },
];

export default definePluginEntry({
  id: "city-bridge",
  name: "AI City bridge",
  description: "The city's tools and policy gate inside an OpenClaw run.",
  register(api) {
    for (const t of TOOLS) {
      api.registerTool({
        name: `city_${t.name}`,
        description: t.description,
        parameters: t.parameters,
        async execute(_id, params) {
          const { result } = await call(`/tool/${t.name}`, { params });
          return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: result ?? null };
        },
      });
    }
    // The same decide(), approvals and audit as every other agent in the city. Fails closed.
    api.on("before_tool_call", async (event) => {
      const tool = event.toolName.startsWith("city_") ? `mcp__city__${event.toolName.slice(5)}` : event.toolName;
      try {
        const g = await call("/policy", { tool, params: event.params ?? {} });
        return g.allow ? undefined : { block: true, blockReason: g.message ?? "denied by the policy gate" };
      } catch (err) {
        return { block: true, blockReason: `the policy gate could not be reached: ${err.message}` };
      }
    }, { priority: 1000 });
  },
});
