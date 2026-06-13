// Worker entry. Mounts the Mastra server onto a Hono app and exports it as
// the Worker's fetch handler. Mastra's REST API (agents, tools, memory,
// streaming) is then served under /api/* — browse /api at runtime.
import { Hono } from "hono";
import { HonoBindings, HonoVariables, MastraServer } from "@mastra/hono";

import { mastra } from "./mastra";

const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();

const server = new MastraServer({
  app,
  mastra,
  // Stateless mode — required on serverless runtimes like Cloudflare Workers.
  mcpOptions: { serverless: true },
});

// Top-level await is supported in Workers module syntax. init() registers
// Mastra's context middleware and all agent/tool/memory routes onto `app`.
await server.init();

export default app;
