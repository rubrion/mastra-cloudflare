// Gemma 4 on Workers AI sometimes writes its chat template's thought channel into
// the answer, even with thinking off: `<|channel>thought\n<channel|>`, empty or
// with reasoning inside. These strip that block from the model's text, whole or
// streamed in pieces.
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { Model } from './models.js';

const OPEN = '<|channel>';
const CLOSE = '<channel|>';

/** Remove every thought-channel block from a whole text. */
export const stripChannels = (text: string) => text.replace(/<\|channel>[\s\S]*?<channel\|>/g, '');

/** Strips blocks across pieces: holds back what could still become one. */
export function channelStripper() {
	let held = '';
	let inside = false;
	return {
		push(piece: string) {
			held += piece;
			let out = '';
			for (;;) {
				if (inside) {
					const end = held.indexOf(CLOSE);
					if (end < 0) {
						// Keep only what could be the start of the closing tag.
						held = held.slice(-(CLOSE.length - 1));
						return out;
					}
					held = held.slice(end + CLOSE.length);
					inside = false;
					continue;
				}
				const start = held.indexOf(OPEN);
				if (start >= 0) {
					out += held.slice(0, start);
					held = held.slice(start + OPEN.length);
					inside = true;
					continue;
				}
				// No tag: send all but a tail that could be the start of one.
				let keep = 0;
				for (let n = Math.min(OPEN.length - 1, held.length); n > 0; n--)
					if (OPEN.startsWith(held.slice(-n))) {
						keep = n;
						break;
					}
				out += held.slice(0, held.length - keep);
				held = held.slice(held.length - keep);
				return out;
			}
		},
		/** What's left at the end: a held tail that never became a tag. */
		end() {
			const rest = inside ? '' : held;
			held = '';
			return rest;
		},
	};
}

/** The model with thought-channel blocks removed from its text, in generate and stream. */
export function withoutChannels(model: Model): Model {
	// A proxy, not a copy: the provider's model is a class whose fields are getters.
	const wrapped: Pick<Model, 'doGenerate' | 'doStream'> = {
		doGenerate: async (options) => {
			const result = await model.doGenerate(options);
			return { ...result, content: result.content.map((part) => (part.type === 'text' ? { ...part, text: stripChannels(part.text) } : part)) };
		},
		doStream: async (options) => {
			const result = await model.doStream(options);
			const strippers = new Map<string, ReturnType<typeof channelStripper>>();
			const of = (id: string) => strippers.get(id) ?? strippers.set(id, channelStripper()).get(id)!;
			const stream = result.stream.pipeThrough(
				new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
					transform(part, controller) {
						if (part.type === 'text-delta') {
							const delta = of(part.id).push(part.delta);
							if (delta) controller.enqueue({ ...part, delta });
							return;
						}
						if (part.type === 'text-end') {
							const rest = of(part.id).end();
							if (rest) controller.enqueue({ type: 'text-delta', id: part.id, delta: rest });
						}
						controller.enqueue(part);
					},
				}),
			);
			return { ...result, stream };
		},
	};
	return new Proxy(model, {
		get: (target, key) => (key === 'doGenerate' || key === 'doStream' ? wrapped[key] : Reflect.get(target, key, target)),
	});
}
