// OpenClaw tool plugin: ask_jarvis. The only tool the OpenClaw agent has.
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { askJarvis, DEFAULTS } from "./relay.js";

export default defineToolPlugin({
  id: "jarvis-relay",
  name: "Jarvis relay",
  description: "Forwards every message to Jarvis, the front door of AI City, and returns the reply. Nothing runs on this Mac through OpenClaw.",
  configSchema: Type.Object({
    server: Type.Optional(Type.String({ description: "The Jarvis server, loopback only.", default: DEFAULTS.server })),
    sessionId: Type.Optional(Type.String({ description: "The shared conversation id.", default: DEFAULTS.sessionId })),
  }),
  tools: (tool) => [
    tool({
      name: "ask_jarvis",
      label: "Ask Jarvis",
      description: "Send the owner's message to Jarvis, word for word, and get the reply to send back.",
      parameters: Type.Object({ message: Type.String({ description: "The owner's message, verbatim." }) }),
      outputSchema: Type.Object({ reply: Type.String() }, { additionalProperties: false }),
      async execute({ message }, config) {
        return { reply: await askJarvis(config, message) };
      },
    }),
  ],
});
