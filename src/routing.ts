// Multi-agent routing: a planner agent reads the agents' descriptions and the
// last few turns, and assigns the request to one or more of them (at most 3),
// each with its own slice of the work. Falls back to the first agent.
import { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import type { AgentSpec } from './agents.js';
import { providerModel, type Model } from './models.js';

export const RoutingPlanSchema = z.object({
	slices: z
		.array(
			z.object({
				agent: z.string(),
				/** What this agent delivers, and only that. */
				instructions: z.string(),
			}),
		)
		.min(1)
		.max(3),
});
export type RoutingPlan = z.infer<typeof RoutingPlanSchema>;

export interface ChatMessage {
	role: string;
	content: unknown;
}

const RULES = `You are the routing planner of a multi-agent system.
Pick which agent(s) handle the user's LAST message, using the earlier turns as context.
Rules:
- Only use agents from the list below.
- Prefer one agent. Use several only for clearly distinct deliverables, at most 3.
- Each slice owns exactly one deliverable; its instructions name only that deliverable, never the whole request.
- Repeat shared constraints (dates, names, audience) in every slice that needs them.
Reply with JSON only: {"slices":[{"agent":"<agent id>","instructions":"<what this agent delivers>"}]}`;

/** The planner agent; `candidates` is set per request in its request context. */
export function plannerAgent(model?: (requestContext: RequestContext) => Model, rules = RULES) {
	return new Agent({
		id: 'planner',
		name: 'Routing planner',
		description: 'Assigns a request to the agents that should handle it.',
		instructions: ({ requestContext }) => `${rules}\n\nAgents (JSON):\n${requestContext.get('candidates') ?? '[]'}`,
		model: ({ requestContext }) => (model ?? providerModel)(requestContext) as never,
	});
}

export const candidatesJson = (specs: AgentSpec[]) => JSON.stringify(specs.map((s) => ({ id: s.id, name: s.name, description: s.description })));

/** Keep a model-made plan to known agents; null when nothing usable is left. */
export function sanitizePlan(plan: RoutingPlan | null | undefined, ids: Set<string>, max = 3): RoutingPlan | null {
	const slices = (plan?.slices ?? []).filter((s) => s && ids.has(s.agent)).slice(0, Math.max(1, Math.min(max, 3)));
	return slices.length ? { slices } : null;
}

export const fallbackPlan = (id: string, instructions: string): RoutingPlan => ({ slices: [{ agent: id, instructions }] });

/** The last `n` user turns, each with the replies that followed it. */
export function recentTurns(messages: ChatMessage[], n = 3): ChatMessage[] {
	const users = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
	return users.length <= n ? messages : messages.slice(users[users.length - n]);
}

export function textOf(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) return content.map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : '')).join('\n');
	return '';
}

export function lastUserText(messages: ChatMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return textOf(messages[i].content);
	return '';
}

/** One reply from several agents: their outputs under their names. */
export const mergeReplies = (parts: { name: string; text: string }[]) =>
	parts.length === 1 ? parts[0].text.trim() : parts.map((p) => `**${p.name}**\n\n${p.text.trim()}`).join('\n\n');
