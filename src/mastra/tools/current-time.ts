// A trivial example tool. Tools extend an agent with callable functions; the
// model decides when to invoke them based on the description.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const currentTimeTool = createTool({
  id: "current_time",
  description:
    "Returns the current UTC date and time as an ISO 8601 string. Use when " +
    "the user asks what time or date it is.",
  inputSchema: z.object({}),
  outputSchema: z.object({ iso: z.string() }),
  execute: async () => ({ iso: new Date().toISOString() }),
});
