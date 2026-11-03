# @rubrion/mastra-cloudflare

[Mastra](https://mastra.ai) agents on Cloudflare Workers, without the boilerplate:

- **`createAgentServer`**: an OpenAI-compatible server (`/v1/models`, `/v1/chat/completions` with real SSE streaming) for your agents, as a Worker `fetch` handler, with no HTTP framework and a small startup cost. `model: "auto"` routes each message to the right agent, or splits it across up to three.
- **`defineAgents`**: agents as plain config, built lazily once per isolate (bindings and secrets are only readable inside a request).
- **`d1Memory`**: Mastra Memory on D1, no vector store to pay for.
- **`workersAI`**, **`openAICompatible`**, **`providerModel`**: models from Workers AI, any OpenAI-compatible endpoint, or the provider each request carries.
- **`readFileTool`**, **`browseTool`**, **`jobTools`**: opt-in tools to read attached files, read web pages in a headless browser, and run long work in a Workflow. Each reports what it used, so you can charge whoever asked.
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
	capabilities?: ('files' | 'images')[]; // listed in /v1/models: what a chat may send it (see Tools)
	inputProcessors?: Processor[]; // Mastra processors, e.g. forgetResults(['browse'])
}
```

`defineAgents(specs, { memory })` returns `{ list(), find(id), get(id) → { agent, spec }, mastra() }`. Specs can carry extra fields of your own (`defineAgents<MySpec>(…)`). `buildAgent(spec)` builds one uncached Agent, e.g. per request.

## Models

```ts
openAICompatible({ baseURL, apiKey, model }); // OpenAI, OpenRouter, LiteLLM, vLLM, Ollama, another agent server…
openAICompatible({ baseURL, apiKey, model, headers: { 'X-Person': id } }); // extra headers on every call
workersAI(env.AI, '@cf/google/gemma-4-26b-a4b-it', { thinking: true }); // with providerOptions: workersAIOptions(true)
providerModel(requestContext, fallback?); // the provider the request carries
```

`workersAI` with `thinking` drops `reasoning_effort` from the binding call: Mastra sends the AI SDK's unified `reasoning` option, and reasoning models such as Gemma 4 stop thinking whenever it is present.

## Tools

Opt-in, each with `guard(ctx)` (return a sentence to refuse, e.g. no credit left) and `used(ctx, usage)` (charge whoever asked).

```ts
import { jobTools, readFileTool, z } from '@rubrion/mastra-cloudflare';
import { browseTool, readPages } from '@rubrion/mastra-cloudflare/browser'; // needs @cloudflare/puppeteer

// The text of an attached file (PDF, Word, Excel, CSV, HTML, XML, images), via Workers AI's toMarkdown.
readFileTool({ ai: () => env.AI, load: async (ref, ctx) => ({ name, bytes }) /* or null: not theirs */, maxChars: 20_000 });

// Public pages in a real browser ("browser": { "binding": "BROWSER" }): text and links, up to 3 pages a call.
// Private addresses, redirects to them and subresources on them are blocked. usage.ms is billed browser time.
browseTool({ browser: () => env.BROWSER, allow: ['example.com'] /* optional */, used: (ctx, { ms }) => charge(ctx, ms) });

// Long work: start_<name> returns a job id at once, check_<name> waits a little and returns the result.
// The job id carries a tag of its owner, so only they can check it.
const crawl = jobTools({ name: 'crawl', description: 'Read a list of pages.', input: z.object({ urls: z.array(z.string()) }),
	workflow: () => env.CRAWL, owner: (ctx) => String(ctx?.requestContext?.get('visitor')) });
// and the Workflow: step.do('read', () => readPages(this.env.BROWSER, event.payload.urls))
```

Never point the browser at logins or captchas.

`read_file` keeps costs where they belong: pictures (alone or inside documents) are not described by an AI model unless `images: true`, since Workers AI bills that; `cache: { get, put }` keeps the converted text (e.g. next to the file in R2) so a file is converted once; and `forgetResults(['read_file', 'browse'])` in an agent's `inputProcessors` sends a file's or page's text only with the turn that read it, not with every message after.

### What an agent takes

`capabilities` on a spec says what clients may send it besides text, and `/v1/models` lists it (`auto` takes what any agent takes). rubry.ai offers the paperclip only to an agent with `files`, and sends a document's text:

```ts
{ id: 'analyst', name: 'Analyst', description: '…', instructions: '…', capabilities: ['files'] }
```

Leave out what the agent has no use for: no `files`, no paperclip; no `browseTool`, no browser bundled or billed.

## Releases

Every push to `main` is released by CI (`.github/workflows/release.yml`, semantic-release): commit messages follow [Conventional Commits](https://www.conventionalcommits.org), and `fix:` publishes a patch, `feat:` a minor, a breaking change (`feat!:` or a `BREAKING CHANGE:` footer) a major. `docs:`, `chore:`, `ci:`, `test:` and `refactor:` publish nothing. npm trusts the workflow (trusted publishing), so there is no token and each version carries provenance. The version lives in git tags (`v0.3.0`) and on npm, not in `package.json`.

## License

GPL-3.0-only
