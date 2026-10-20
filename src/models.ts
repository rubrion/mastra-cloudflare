// Model factories for Workers: any OpenAI-compatible endpoint, Workers AI,
// and the provider a request carries (set by a middleware, see server.ts).
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { RequestContext } from '@mastra/core/request-context';
import { createWorkersAI } from 'workers-ai-provider';

/** An OpenAI-compatible provider: OpenAI, OpenRouter, a LiteLLM/vLLM/Ollama proxy, another agent server. */
export interface ProviderConfig {
	baseURL: string;
	apiKey: string;
	model: string;
	/** Shown in Mastra's logs; defaults to "provider". */
	name?: string;
}

/** The request-context key the server stores the request's provider under. */
export const PROVIDER = 'provider';
/** The request-context key for the model used when a request carries no provider (see `defaultModel`). */
export const DEFAULT_MODEL = 'default-model';

/** What every factory here returns: an AI SDK language model, as Mastra agents take. */
export type Model = LanguageModelV4;

export const openAICompatible = (config: ProviderConfig): Model =>
	createOpenAICompatible({ name: config.name ?? 'provider', baseURL: config.baseURL.replace(/\/+$/, ''), apiKey: config.apiKey }).chatModel(config.model);

/**
 * The model of the request's provider (see `PROVIDER`), else `fallback`, else
 * the server's `defaultModel`. The default of every agent that doesn't name
 * its own model.
 */
export function providerModel(requestContext?: RequestContext, fallback?: ProviderConfig): Model {
	const config = (requestContext?.get(PROVIDER) as ProviderConfig | undefined) ?? fallback;
	if (config?.baseURL && config.model) return openAICompatible(config);
	const model = requestContext?.get(DEFAULT_MODEL) as Model | undefined;
	if (model) return model;
	throw new Error('No model provider configured for this request');
}

/** The slice of the `AI` binding the Workers AI provider calls. */
export interface AiBinding {
	run(model: string, inputs: Record<string, unknown>, options?: unknown): Promise<unknown>;
}

/**
 * A Workers AI model. `thinking` (for reasoning models such as Gemma 4 or
 * Qwen 3) turns their thinking on or off through the chat template; leave it
 * undefined for other models. With thinking on, the binding also drops
 * `reasoning_effort`: Mastra sends the AI SDK's unified `reasoning` option,
 * which the provider turns into `reasoning_effort`, and these models stop
 * thinking whenever it is present at all.
 */
export function workersAI(binding: AiBinding, model: string, { thinking }: { thinking?: boolean } = {}): Model {
	const ai = {
		run: (m: string, inputs: Record<string, unknown>, options?: unknown) => {
			if (thinking === undefined) return binding.run(m, inputs, options);
			const { reasoning_effort: _ignored, ...rest } = inputs;
			const kwargs = { ...(inputs.chat_template_kwargs as object | undefined), enable_thinking: thinking };
			return binding.run(m, { ...(thinking ? rest : inputs), chat_template_kwargs: kwargs }, options);
		},
	};
	return createWorkersAI({ binding: ai as unknown as Ai })(model as Parameters<ReturnType<typeof createWorkersAI>>[0]) as unknown as Model;
}

/** Provider options that switch a Workers AI reasoning model's thinking on or off. */
export const workersAIOptions = (thinking: boolean) => ({ 'workers-ai': { chat_template_kwargs: { enable_thinking: thinking } } });
