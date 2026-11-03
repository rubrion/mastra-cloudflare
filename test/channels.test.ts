import { describe, expect, it } from 'vitest';
import { channelStripper, stripChannels } from '../src/channels';

const streamed = (pieces: string[]) => {
	const s = channelStripper();
	return pieces.map((p) => s.push(p)).join('') + s.end();
};

describe('thought channels', () => {
	it('strips them from a whole text', () => {
		expect(stripChannels('Iniciando.\n\n<|channel>thought\n<channel|>### Síntese')).toBe('Iniciando.\n\n### Síntese');
		expect(stripChannels('a<|channel>thought\nhmm<channel|>b<|channel>x<channel|>c')).toBe('abc');
	});
	it('strips them across streamed pieces, token by token', () => {
		expect(streamed(['Iniciando.\n\n<|', 'channel', '>', 'thought', '\n', '<channel', '|>', '### Sí', 'ntese'])).toBe('Iniciando.\n\n### Síntese');
		expect(streamed([...'ok <|channel>thought\nlong reasoning<channel|> done'])).toBe('ok  done');
	});
	it('leaves text alone that only looks like a start', () => {
		expect(streamed(['a <', '| b', ' <|chan'])).toBe('a <| b <|chan');
		expect(streamed(['x < y'])).toBe('x < y');
	});
});

describe('withoutChannels', () => {
	it('keeps the model getters and strips its stream', async () => {
		const { withoutChannels } = await import('../src/channels');
		class Fake {
			get provider() {
				return 'workers-ai';
			}
			async doStream() {
				const parts = [
					{ type: 'text-start', id: 't' },
					...['Oi <|chan', 'nel>thought\n<chan', 'nel|>tudo bem'].map((delta) => ({ type: 'text-delta', id: 't', delta })),
					{ type: 'text-end', id: 't' },
				];
				return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
			}
		}
		const model = withoutChannels(new Fake() as never);
		expect(model.provider).toBe('workers-ai');
		const { stream } = await model.doStream({} as never);
		let text = '';
		for await (const part of stream as unknown as AsyncIterable<{ type: string; delta?: string }>) if (part.type === 'text-delta') text += part.delta;
		expect(text).toBe('Oi tudo bem');
	});
});
