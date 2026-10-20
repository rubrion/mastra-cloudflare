// An OpenAI-compatible server for a registry of agents, as a Worker `fetch`
// handler. No HTTP framework: Mastra's own server route table costs most of
// a Worker's startup CPU allowance, and this surface is three routes.
//
//   GET  /                     health: name and agent ids
//   GET  /v1/models            the agents (and "auto" when it can route)
//   POST /v1/chat/completions  OpenAI chat completions, streamed (SSE) or not.
//                              model: an agent id, or "auto" to let the planner
//                              pick one or more agents for the last message.
//
// Request headers (all optional; a middleware in front sets them):
//   Authorization: Bearer <key>     required when `apiKey` returns a key
//   X-Provider-Base-URL / X-Provider-Key / X-Provider-Model
//                                   the OpenAI-compatible model for this request
//   X-Agents: id,id                 only these agents are on for this request
//   X-Session-Id: <id>              keep memory per (session, agent); send only the
//                                   new message. Needs `memory` on the registry.
import { RequestContext } from '@mastra/core/request-context';
import type { AgentRegistry, AgentSpec } from './agents.js';
import { DEFAULT_MODEL, PROVIDER, type Model, type ProviderConfig } from './models.js';
import { candidatesJson, fallbackPlan, lastUserText, mergeReplies, plannerAgent, recentTurns, RoutingPlanSchema, sanitizePlan, textOf, type ChatMessage } from './routing.js';

export const HEADERS = {
	baseURL: 'x-provider-base-url',
	key: 'x-provider-key',
	model: 'x-provider-model',
	agents: 'x-agents',
	session: 'x-session-id',
} as const;

export interface AgentServerOptions<T extends AgentSpec, E> {
	agents: AgentRegistry<T>;
	/** Shown as `owned_by` in /v1/models and in the health check. */
	name?: string;
	/** The bearer key callers must send; none (or empty) leaves the server open. */
	apiKey?: (env: E) => string | undefined;
	/** The provider when the request doesn't carry one (e.g. from env vars). */
	provider?: (env: E) => ProviderConfig | undefined;
	/** The model when there's no provider at all, e.g. `workersAI(env.AI, …)`: works with no keys. */
	defaultModel?: (env: E) => Model;
	/** "auto" routing; false turns it off. The planner uses the request's provider unless given a model. */
	planner?: false | { model?: (requestContext: RequestContext) => Model; rules?: string };
	/** Tool-call rounds per reply. */
	maxSteps?: number;
}

type Input = { role: 'system' | 'user' | 'assistant'; content: unknown };
type Body = { model?: string; messages?: ChatMessage[]; stream?: boolean };

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const fail = (status: number, message: string, code: string) => json({ error: { message, type: 'invalid_request_error', code } }, status);

/** OpenAI message content as Mastra input: text and image parts. */
function toInput(messages: ChatMessage[]): Input[] {
	return messages
		.filter((m) => m.role === 'system' || m.role === 'user' || m.role === 'assistant')
		.map((m) => {
			if (m.role !== 'user' || !Array.isArray(m.content)) return { role: m.role as Input['role'], content: textOf(m.content) };
			const parts = (m.content as Record<string, any>[]).flatMap((p): Record<string, unknown>[] =>
				p?.type === 'text' ? [{ type: 'text', text: String(p.text) }] : p?.type === 'image_url' ? [{ type: 'image', image: p.image_url?.url ?? p.image_url }] : [],
			);
			return { role: 'user', content: parts };
		});
}

export function createAgentServer<T extends AgentSpec, E = unknown>(options: AgentServerOptions<T, E>) {
	const { agents, name = 'agents', maxSteps = 5 } = options;
	let planner: ReturnType<typeof plannerAgent> | undefined;
	const plannerOf = () => (planner ??= plannerAgent(options.planner ? options.planner.model : undefined, options.planner ? options.planner.rules : undefined));

	return {
		async fetch(request: Request, env: E): Promise<Response> {
			const url = new URL(request.url);
			const h = request.headers;
			const key = options.apiKey?.(env);
			if (key && h.get('authorization') !== `Bearer ${key}`) return fail(401, 'Invalid API key', 'invalid_api_key');

			const only = h.get(HEADERS.agents)?.split(',').map((s) => s.trim()).filter(Boolean);
			const candidates = agents.list().filter((s) => !only || only.includes(s.id));
			const routes = options.planner !== false && candidates.length > 1;

			if (request.method === 'GET' && url.pathname === '/') return json({ name, status: 'ok', agents: candidates.map((s) => s.id) });

			if (request.method === 'GET' && url.pathname === '/v1/models') {
				const model = (id: string, title: string, description: string) => ({ id, object: 'model', created: 0, owned_by: name, name: title, description });
				return json({
					object: 'list',
					data: [
						...(routes ? [model('auto', 'Auto', 'Sends each message to the agent(s) best suited for it.')] : []),
						...candidates.map((s) => model(s.id, s.name, s.description)),
					],
				});
			}

			if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') return fail(404, 'Not found', 'not_found');

			let body: Body;
			try {
				body = (await request.json()) as Body;
			} catch {
				return fail(400, 'Body must be JSON', 'invalid_json');
			}
			const messages = Array.isArray(body.messages) ? body.messages : [];
			if (!messages.some((m) => m.role === 'user')) return fail(400, 'messages needs a user message', 'invalid_messages');
			if (!candidates.length) return fail(503, 'No agents are on', 'no_agents');
			const requested = body.model && body.model !== 'auto' ? body.model : routes ? 'auto' : candidates[0].id;
			if (requested !== 'auto' && !candidates.some((s) => s.id === requested)) return fail(404, `Unknown model ${requested}`, 'model_not_found');

			agents.mastra();
			const requestContext = new RequestContext();
			const provider: ProviderConfig | undefined =
				h.get(HEADERS.baseURL) && h.get(HEADERS.model)
					? { baseURL: h.get(HEADERS.baseURL)!, apiKey: h.get(HEADERS.key) ?? '', model: h.get(HEADERS.model)! }
					: options.provider?.(env);
			if (provider) requestContext.set(PROVIDER, provider);
			else if (options.defaultModel) requestContext.set(DEFAULT_MODEL, options.defaultModel(env));

			const session = h.get(HEADERS.session) ?? '';
			const remembers = !!session && !!agents.memory;
			const input = toInput(messages);
			const latest = [...input].reverse().find((m) => m.role === 'user')!;

			/**
			 * Run one agent. With `steer` (its slice of a routed request) the last
			 * user turn becomes that assignment, so it can't drift into another
			 * agent's deliverable; the earlier turns stay as context.
			 */
			const call = (spec: T, steer?: string) => {
				const { agent } = agents.get(spec.id)!;
				const turn: Input = steer
					? {
							role: 'user',
							content: `You are ${spec.name}, one of several agents answering one message. Deliver only your part and nothing owned by the others.\nYour part: ${steer}`,
						}
					: latest;
				const history = remembers ? [] : input.slice(0, input.lastIndexOf(latest));
				return {
					input: [...history, turn] as never,
					options: {
						requestContext,
						maxSteps,
						abortSignal: request.signal,
						...(spec.maxOutputTokens ? { modelSettings: { maxOutputTokens: spec.maxOutputTokens } } : {}),
						...(remembers ? { memory: { thread: `${session}:${spec.id}`, resource: session } } : {}),
					} as never,
					agent,
				};
			};

			// Which agents answer, and with what slice of the request.
			let slices: { spec: T; steer?: string }[];
			if (requested === 'auto') {
				let plan = null;
				try {
					const ctx = new RequestContext();
					if (provider) ctx.set(PROVIDER, provider);
					else if (options.defaultModel) ctx.set(DEFAULT_MODEL, options.defaultModel(env));
					ctx.set('candidates', candidatesJson(candidates));
					const recent = recentTurns(messages).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: textOf(m.content) }));
					const out = await plannerOf().generate(recent as never, {
						requestContext: ctx,
						structuredOutput: { schema: RoutingPlanSchema, jsonPromptInjection: true },
						modelSettings: { temperature: 0 },
					} as never);
					plan = sanitizePlan((out as { object?: unknown }).object as never, new Set(candidates.map((s) => s.id)));
				} catch (e) {
					console.log('[agent-server] planner failed:', String(e));
				}
				plan ??= fallbackPlan(candidates[0].id, lastUserText(messages));
				slices = plan.slices.map((s) => ({ spec: candidates.find((c) => c.id === s.agent)!, steer: plan!.slices.length > 1 ? s.instructions : undefined }));
			} else {
				slices = [{ spec: candidates.find((s) => s.id === requested)! }];
			}
			const model = slices.map((s) => s.spec.id).join('+');
			const id = `chatcmpl-${crypto.randomUUID()}`;
			const created = Math.floor(Date.now() / 1000);

			// Several agents: run them together, answer with their merged replies.
			const several = async () => {
				const parts = await Promise.all(
					slices.map(async ({ spec, steer }) => {
						const run = call(spec, steer);
						try {
							const out = await run.agent.generate(run.input, run.options);
							return { name: spec.name, text: out.text ?? '' };
						} catch (e) {
							console.log(`[agent-server] ${spec.id} failed:`, String(e));
							return { name: spec.name, text: '' };
						}
					}),
				);
				const ok = parts.filter((p) => p.text.trim());
				return ok.length ? mergeReplies(ok) : 'None of the agents could answer right now.';
			};

			if (!body.stream) {
				let text: string;
				if (slices.length > 1) text = await several();
				else {
					const run = call(slices[0].spec);
					try {
						text = (await run.agent.generate(run.input, run.options)).text ?? '';
					} catch (e) {
						console.log(`[agent-server] ${slices[0].spec.id} failed:`, String(e));
						return json({ error: { message: (e as Error).message, type: 'upstream_error', code: 'agent_failed' } }, 502);
					}
				}
				return json({
					id,
					object: 'chat.completion',
					created,
					model,
					choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
				});
			}

			const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
			const writer = writable.getWriter();
			const enc = new TextEncoder();
			const send = (delta: Record<string, unknown>, finish: string | null = null) =>
				writer.write(enc.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`));

			// Not awaited: the response goes out while this keeps writing into it.
			void (async () => {
				try {
					await send({ role: 'assistant', content: '' });
					if (slices.length > 1) await send({ content: await several() });
					else {
						const run = call(slices[0].spec);
						const out = await run.agent.stream(run.input, run.options);
						// fullStream, not textStream: a provider error arrives as a chunk and must surface.
						for await (const chunk of out.fullStream as AsyncIterable<{ type: string; payload?: Record<string, unknown> }>) {
							if (chunk.type === 'text-delta' && chunk.payload?.text) await send({ content: String(chunk.payload.text) });
							if (chunk.type === 'error') throw chunk.payload?.error instanceof Error ? chunk.payload.error : new Error(String(chunk.payload?.error ?? 'error'));
						}
					}
					await send({}, 'stop');
				} catch (e) {
					console.log('[agent-server] stream failed:', String(e));
					await send({ content: `\n\n(The agent failed: ${(e as Error).message})` }, 'stop').catch(() => undefined);
				} finally {
					await writer.write(enc.encode('data: [DONE]\n\n')).catch(() => undefined);
					await writer.close().catch(() => undefined);
				}
			})();

			return new Response(readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
		},
	};
}
