import { describe, expect, it } from 'vitest';
import { clip, fileToMarkdown, jobTools, publicUrl, readFileTool, z, type MarkdownAi } from '../src/index';

const ctxOf = (values: Record<string, unknown>) => ({ requestContext: { get: (k: string) => values[k] } });

describe('publicUrl', () => {
	it('takes public http(s) addresses', () => {
		expect(publicUrl('https://example.com/a?b=1')?.href).toBe('https://example.com/a?b=1');
		expect(publicUrl('http://8.8.8.8/')).not.toBeNull();
	});
	it('refuses private, local and odd addresses', () => {
		for (const u of [
			'http://localhost/',
			'http://127.0.0.1/',
			'http://10.1.2.3/',
			'http://172.20.0.1/',
			'http://192.168.0.1/',
			'http://169.254.169.254/latest/meta-data',
			'http://100.100.1.1/',
			'http://[::1]/',
			'http://2130706433/',
			'http://0x7f000001/',
			'http://printer.local/',
			'http://db.internal/',
			'http://intranet/',
			'file:///etc/passwd',
			'ftp://example.com/',
			'https://user:pw@example.com/',
			'https://example.com:8443/',
			'not a url',
		])
			expect(publicUrl(u), u).toBeNull();
	});
	it('keeps to the allowed hosts', () => {
		expect(publicUrl('https://docs.example.com/x', ['example.com'])).not.toBeNull();
		expect(publicUrl('https://example.org/', ['example.com'])).toBeNull();
		expect(publicUrl('https://notexample.com/', ['example.com'])).toBeNull();
	});
});

describe('clip', () => {
	it('cuts at a line break near the end', () => {
		const text = `${'a'.repeat(90)}\n${'b'.repeat(50)}`;
		expect(clip(text, 100)).toEqual({ text: 'a'.repeat(90), truncated: true });
		expect(clip('short', 100)).toEqual({ text: 'short', truncated: false });
	});
});

const ai = (data: string): MarkdownAi => ({ toMarkdown: async ([f]) => [{ name: f.name, mimeType: 'application/pdf', format: 'markdown', tokens: 7, data }] });

describe('read_file', () => {
	it('converts and cuts', async () => {
		const out = await fileToMarkdown(ai('x'.repeat(50)), { name: 'a.pdf', bytes: new Uint8Array([1]) }, 10);
		expect(out).toMatchObject({ name: 'a.pdf', markdown: 'x'.repeat(10), truncated: true, tokens: 7 });
	});
	it('refuses when guarded, reports usage otherwise', async () => {
		const used: unknown[] = [];
		const tool = readFileTool({
			ai: () => ai('# Hi'),
			load: async (ref) => (ref === 'mine' ? { name: 'a.pdf', bytes: new Uint8Array([1]) } : null),
			guard: (ctx) => (ctx?.requestContext?.get('broke') ? 'No credit.' : undefined),
			used: (_, u) => void used.push(u),
		});
		expect(await tool.execute!({ file: 'mine' }, ctxOf({ broke: true }) as never)).toEqual({ error: 'No credit.' });
		expect(await tool.execute!({ file: 'theirs' }, ctxOf({}) as never)).toEqual({ error: 'No such file in this conversation.' });
		expect(await tool.execute!({ file: 'mine' }, ctxOf({}) as never)).toMatchObject({ markdown: '# Hi' });
		expect(used).toEqual([{ name: 'a.pdf', tokens: 7, chars: 4 }]);
	});
});

describe('jobTools', () => {
	const runs = new Map<string, { params: unknown; status: string; output?: unknown }>();
	const workflow = {
		create: async ({ id, params }: { id?: string; params?: unknown }) => (runs.set(id!, { params, status: 'complete', output: { ok: 1 } }), { id: id! }),
		get: async (id: string) => {
			const run = runs.get(id);
			if (!run) throw new Error('not found');
			return { status: async () => run };
		},
	};
	const { start, check } = jobTools({
		name: 'crawl',
		description: 'Crawl a site.',
		input: z.object({ url: z.string() }),
		workflow: () => workflow,
		owner: (ctx) => String(ctx?.requestContext?.get('who')),
		waitMs: 0,
	});

	it('starts with the owner, and only the owner can check', async () => {
		const out = (await start.execute!({ url: 'https://example.com' }, ctxOf({ who: 'ana' }) as never)) as { job: string };
		expect(runs.get(out.job)?.params).toEqual({ url: 'https://example.com', owner: 'ana' });
		expect(await check.execute!({ job: out.job }, ctxOf({ who: 'ana' }) as never)).toEqual({ job: out.job, status: 'complete', result: { ok: 1 } });
		expect(await check.execute!({ job: out.job }, ctxOf({ who: 'bob' }) as never)).toEqual({ error: 'No such job.' });
	});
});
