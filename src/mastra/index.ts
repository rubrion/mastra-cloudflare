// Mastra instance for the Worker.
//
// No CloudflareDeployer here — this template deploys as a plain Worker
// (root wrangler.jsonc + src/index.ts entry) so `wrangler dev/deploy/types`
// work directly. The `env` binding is read inline; Workers populate it by
// the time this module is evaluated within a request.
import { Mastra } from "@mastra/core/mastra";

import { assistant } from "./agents/assistant";

// Note: we do NOT set a Mastra-level `storage` here. Mastra would eagerly
// initialize it when the server boots — which on Workers runs in global scope,
// where async I/O (the D1 CREATE TABLE) is disallowed. Instead the agent owns a
// lazily-built Memory (see agents/assistant.ts) whose D1 init runs on first
// request, inside a handler where I/O is allowed.
export const mastra = new Mastra({
  agents: { assistant },

  server: {
    middleware: [
      // Example: forward an end-user id from a request header into the
      // request context, so agent instructions/tools/memory can scope by
      // user. Delete or adapt for your own auth.
      async (context, next) => {
        const userId = context.req.header("X-User-Id");
        if (userId) context.get("requestContext").set("userId", userId);
        await next();
      },
    ],
  },
});
