import { describe, expect, it } from 'vitest';
import { clip, createAgentServer, defineAgents, fileToMarkdown, jobTools, publicUrl, readFileTool, z, type FileText, type MarkdownAi } from '../src/index';

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
		expect(used).toEqual([{ name: 'a.pdf', tokens: 7, chars: 4, cached: false }]);
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

describe('read_file costs', () => {
	it('converts a file once when given a cache', async () => {
		let conversions = 0;
		const counting: MarkdownAi = { toMarkdown: async ([f]) => (conversions++, [{ name: f.name, mimeType: 'application/pdf', format: 'markdown', tokens: 3, data: 'text' }]) };
		const store = new Map<string, FileText>();
		const tool = readFileTool({
			ai: () => counting,
			load: async () => ({ name: 'a.pdf', bytes: new Uint8Array([1]) }),
			cache: { get: async (ref) => store.get(ref) ?? null, put: async (ref, text) => void store.set(ref, text) },
		});
		await tool.execute!({ file: 'k' }, ctxOf({}) as never);
		expect(await tool.execute!({ file: 'k' }, ctxOf({}) as never)).toMatchObject({ markdown: 'text' });
		expect(conversions).toBe(1);
	});
	it('asks Workers AI not to describe pictures, and refuses a picture', async () => {
		let options: unknown;
		const spy: MarkdownAi = { toMarkdown: async ([f], o) => ((options = o), [{ name: f.name, mimeType: 'application/pdf', format: 'markdown', tokens: 1, data: 'x' }]) };
		await fileToMarkdown(spy, { name: 'a.pdf', bytes: new Uint8Array([1]) });
		expect(options).toMatchObject({ conversionOptions: { pdf: { images: { convert: false } } } });
		expect(await fileToMarkdown(spy, { name: 'photo.JPG', bytes: new Uint8Array([1]) })).toHaveProperty('error');
		expect(await fileToMarkdown(spy, { name: 'scan', type: 'image/png', bytes: new Uint8Array([1]) })).toHaveProperty('error');
		expect(await fileToMarkdown(spy, { name: 'photo.jpg', bytes: new Uint8Array([1]) }, 100, { images: true })).toHaveProperty('markdown');
	});
});

describe('capabilities', () => {
	it('lists what each agent takes in /v1/models, and auto takes their union', async () => {
		const agents = defineAgents([
			{ id: 'reader', name: 'Reader', description: 'Reads documents.', instructions: '.', capabilities: ['files'] },
			{ id: 'plain', name: 'Plain', description: 'Talks.', instructions: '.' },
		]);
		const server = createAgentServer({ agents });
		const res = await server.fetch(new Request('https://x/v1/models'), {} as never);
		const { data } = (await res.json()) as { data: { id: string; capabilities?: string[] }[] };
		expect(Object.fromEntries(data.map((m) => [m.id, m.capabilities]))).toEqual({ auto: ['files'], reader: ['files'], plain: undefined });
	});
});
