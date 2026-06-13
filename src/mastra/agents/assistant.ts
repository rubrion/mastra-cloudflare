// A general-purpose assistant agent with conversation memory in D1.
//
// `env` (from cloudflare:workers) is read only inside functions — the
// binding is undefined at module load. The memory is a lazily-built
// singleton so D1 init runs once per isolate, not once per request.
import { env } from "cloudflare:workers";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { D1Store } from "@mastra/cloudflare-d1";

import { currentTimeTool } from "../tools/current-time";

let memory: Memory | undefined;
function getMemory(): Memory {
  if (!memory) {
    memory = new Memory({
      storage: new D1Store({ id: "assistant-memory", binding: env.DB }),
      // No semantic recall in the starter (no vector store / embedder).
      vector: false,
      options: { lastMessages: 20 },
    });
  }
  return memory;
}

export const assistant = new Agent({
  id: "assistant",
  name: "Assistant",
  description: "A general-purpose AI assistant with conversation memory.",

  // Dynamic instructions: resolved per request, with access to values placed
  // in the request context by server middleware (see ../index.ts).
  instructions: async ({ requestContext }) => {
    const userId = (requestContext?.get("userId") as string) || "anonymous";
    return [
      "You are a helpful, concise assistant.",
      "When the user asks about the current date or time, call the",
      "current_time tool instead of guessing.",
      `You are currently assisting user: ${userId}.`,
    ].join(" ");
  },

  // Model-router id from the MODEL var; point OPENAI_BASE_URL at any
  // OpenAI-compatible endpoint to swap providers without code changes.
  model: () => env.MODEL || "openai/gpt-4o-mini",

  tools: { current_time: currentTimeTool },

  memory: () => getMemory(),
});
