# @rubrion/mastra-cloudflare

[Mastra](https://mastra.ai) agents on Cloudflare Workers, without the boilerplate:

- **`createAgentServer`**: an OpenAI-compatible server (`/v1/models`, `/v1/chat/completions` with real SSE streaming) for your agents, as a Worker `fetch` handler, with no HTTP framework and a small startup cost. `model: "auto"` routes each message to the right agent, or splits it across up to three.
- **`defineAgents`**: agents as plain config, built lazily once per isolate (bindings and secrets are only readable inside a request).
- **`d1Memory`**: Mastra Memory on D1, no vector store to pay for.
- **`workersAI`**, **`openAICompatible`**, **`providerModel`**: models from Workers AI, any OpenAI-compatible endpoint, or the provider each request carries.
- Re-exports `Agent`, `createTool`, `z` and `RequestContext`, so a project needs only this package.

The [rubry template](https://github.com/rubrion/rubry) puts it to work: agents plus a middleware with API keys and a settings page.

## Install

```bash
npm install @rubrion/mastra-cloudflare
```

`wrangler.jsonc` needs `"compatibility_flags": ["nodejs_compat"]`.

## A Worker in 20 lines

```ts
import { env } from 'cloudflare:workers';
import { createAgentServer, createTool, d1Memory, defineAgents, z } from '@rubrion/mastra-cloudflare';

const time = createTool({
	id: 'current_time',
	description: 'The current date and time.',
	inputSchema: z.object({}),
	execute: async () => ({ now: new Date().toISOString() }),
});

const agents = defineAgents(
	[
		{ id: 'writer', name: 'Writer', description: 'Writes and edits text.', instructions: 'Write what is asked, briefly.' },
		{ id: 'helper', name: 'Helper', description: 'General questions; knows the time.', instructions: 'Be useful.', tools: { current_time: time } },
	],
	{ memory: d1Memory(() => env.MEMORY) },
);

export default createAgentServer({
	agents,
	apiKey: (e: Env) => e.API_KEY,
	provider: (e: Env) => ({ baseURL: 'https://api.openai.com/v1', apiKey: e.OPENAI_API_KEY, model: 'gpt-5-mini' }),
});
```

```bash
curl -N http://localhost:8787/v1/chat/completions -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"What time is it?"}]}'
```

## Server

`createAgentServer({ agents, name?, apiKey?, provider?, planner?, maxSteps?, maxAgents? })` returns `{ fetch(request, env) }`. `maxSteps` (tool rounds per reply, default 5) and `maxAgents` (how many agents `auto` may split a request across, default 3) take a number or `(env) => number`.

Replies carry OpenAI's `usage` (prompt, completion and total tokens over the planner, every agent and every tool round): in the JSON body, or on the final chunk when streaming.

| Route | |
|---|---|
| `GET /` | health: name and agent ids |
| `GET /v1/models` | `auto` (when it can route) and each agent, with its description |
| `POST /v1/chat/completions` | `model`: agent id or `auto`; `stream: true` for SSE; text and `image_url` content |

Per-request headers, for a middleware in front (see `HEADERS`):

| Header | |
|---|---|
| `X-Provider-Base-URL` / `X-Provider-Key` / `X-Provider-Model` | the model for this request (else `provider(env)`) |
| `X-Agents: a,b` | only these agents are on |
| `X-Session-Id` | memory per (session, agent): send only the new message. Needs `memory` on `defineAgents` |

## Agents

```ts
interface AgentSpec {
	id: string;
	name: string;
	description: string; // the router picks agents by it
	instructions: string | ((args: { requestContext }) => string);
	model?: (requestContext) => Model; // default: providerModel (the request's provider)
	tools?: Record<string, Tool>;
	maxOutputTokens?: number;
	enabled?: () => boolean; // off when its configuration is missing
}
```

`defineAgents(specs, { memory })` returns `{ list(), find(id), get(id) → { agent, spec }, mastra() }`. Specs can carry extra fields of your own (`defineAgents<MySpec>(…)`). `buildAgent(spec)` builds one uncached Agent, e.g. per request.

## Models

```ts
openAICompatible({ baseURL, apiKey, model }); // OpenAI, OpenRouter, LiteLLM, vLLM, Ollama, another agent server…
workersAI(env.AI, '@cf/google/gemma-4-26b-a4b-it', { thinking: true }); // with providerOptions: workersAIOptions(true)
providerModel(requestContext, fallback?); // the provider the request carries
```

`workersAI` with `thinking` drops `reasoning_effort` from the binding call: Mastra sends the AI SDK's unified `reasoning` option, and reasoning models such as Gemma 4 stop thinking whenever it is present.

## License

GPL-3.0-only
