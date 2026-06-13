# Mastra AI Agent + D1 Memory

<!-- dash-content-start -->

A starter for building AI agents with the [Mastra](https://mastra.ai) framework
on Cloudflare Workers. It ships a general-purpose **assistant** agent whose
conversation history is persisted in **D1**, an example tool, and Mastra's REST
API mounted via the Hono adapter.

- **Workers** — runs the Mastra server as a plain Worker (no extra build step)
- **D1** — durable, strongly-consistent agent memory (threads + messages)
- **Model-agnostic** — uses Mastra's model router; point `OPENAI_BASE_URL` at
  any OpenAI-compatible endpoint (OpenAI, LiteLLM, vLLM, Ollama, …)

<!-- dash-content-end -->

## What's inside

```
src/
  index.ts                 # Worker entry — mounts Mastra on Hono, exports fetch
  mastra/
    index.ts               # Mastra instance: D1 storage + example middleware
    agents/assistant.ts    # Assistant agent (dynamic instructions + D1 memory)
    tools/current-time.ts  # Example tool
  types/cloudflare.d.ts    # Env binding types
```

The Mastra REST API is served under `/api/*` (e.g. `GET /api/agents`).

## Getting started

1. **Install**

   ```bash
   npm install
   ```

2. **Create a D1 database** and paste the id into `wrangler.jsonc`
   (`d1_databases[0].database_id`). Tables are created automatically on first
   use — no migrations to run.

   ```bash
   npx wrangler d1 create mastra-d1-agent
   ```

3. **Configure the model.** Copy `.dev.vars.example` to `.dev.vars` and set
   `OPENAI_API_KEY` (and optionally `OPENAI_BASE_URL` for a self-hosted /
   OpenAI-compatible endpoint). Change the model with the `MODEL` var in
   `wrangler.jsonc`.

4. **Run locally**

   ```bash
   npm run dev
   # then, in another shell:
   curl http://localhost:8787/api/agents
   ```

5. **Deploy**

   ```bash
   npm run deploy
   ```

   Set production secrets first:

   ```bash
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put OPENAI_BASE_URL
   ```

## Calling the agent

```bash
curl -X POST http://localhost:8787/api/agents/assistant/generate \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: demo-user' \
  -d '{"messages":"What time is it?"}'
```

The `X-User-Id` header is mapped into Mastra's request context by the example
middleware in `src/mastra/index.ts` and surfaced in the agent's instructions —
swap it for your own auth.

## Notes

- `nodejs_compat` + `nodejs_compat_populate_process_env` compatibility flags are
  required: Mastra core uses Node built-ins, and the model router reads
  `OPENAI_*` from `process.env`.
- To add agents, tools, or workflows, create them under `src/mastra/` and
  register them on the `Mastra` instance in `src/mastra/index.ts`.
- No Mastra-level `storage` is set: it would init in global scope, where
  Workers disallow async I/O. The agent owns a lazily-built `Memory` that
  inits D1 on first request instead.
- **Bundle size:** Mastra core is large (~5 MB gzip). That exceeds the Workers
  **Free** plan limit (3 MiB); deploy on the **Standard/paid** plan (10 MiB).
