// Agents as configuration: a list of specs becomes Mastra Agents, built once
// per isolate on first use (bindings and secrets are only readable then).
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import type { MastraMemory } from '@mastra/core/memory';
import type { RequestContext } from '@mastra/core/request-context';
import { providerModel, type Model } from './models.js';

export interface AgentSpec {
	id: string;
	name: string;
	/** What the agent is for, in one or two sentences. The router picks agents by it. */
	description: string;
	instructions: string | ((args: { requestContext: RequestContext }) => string);
	/** Its model; by default the request's provider (`providerModel`). */
	model?: (requestContext: RequestContext) => Model;
	tools?: Record<string, unknown>;
	/** Cap on each reply, in tokens. */
	maxOutputTokens?: number;
	/** Off when its configuration is missing (e.g. a key that isn't set). */
	enabled?: () => boolean;
}

export interface AgentsOptions {
	/** Memory every agent shares (see `d1Memory`); without it agents are stateless. */
	memory?: () => MastraMemory;
}

/** A Mastra Agent from a spec, not cached: for agents made per request. */
export function buildAgent(spec: AgentSpec, { memory }: AgentsOptions = {}) {
	return new Agent({
		id: spec.id,
		name: spec.name,
		description: spec.description,
		instructions: ({ requestContext }) => (typeof spec.instructions === 'function' ? spec.instructions({ requestContext }) : spec.instructions),
		model: ({ requestContext }) => (spec.model ?? providerModel)(requestContext) as never,
		tools: (spec.tools ?? {}) as never,
		...(memory ? { memory: () => memory() } : {}),
	});
}

/**
 * The registry of a Worker's agents. `T` can carry app-specific fields
 * (a tagline, a price) next to the spec's own.
 */
export function defineAgents<T extends AgentSpec>(specs: T[], options: AgentsOptions = {}) {
	const built = new Map<string, Agent>();
	let mastra: Mastra | undefined;
	const list = () => specs.filter((s) => s.enabled?.() ?? true);
	const find = (id: string) => list().find((s) => s.id === id);
	const agentOf = (spec: T) => {
		let agent = built.get(spec.id);
		if (!agent) {
			agent = buildAgent(spec, options);
			built.set(spec.id, agent);
		}
		return agent;
	};
	return {
		specs,
		memory: options.memory,
		/** The agents that are on. */
		list,
		find,
		/** An agent and its spec, or undefined when unknown or off. */
		get(id: string) {
			const spec = find(id);
			return spec ? { agent: agentOf(spec), spec } : undefined;
		},
		/** A Mastra instance with every enabled agent registered (logger, storage wiring). */
		mastra() {
			mastra ??= new Mastra({ agents: Object.fromEntries(list().map((s) => [s.id, agentOf(s)])) });
			return mastra;
		},
	};
}

export type AgentRegistry<T extends AgentSpec = AgentSpec> = ReturnType<typeof defineAgents<T>>;
