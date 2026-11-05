import { describe, expect, it } from 'vitest';
import { clip, createAgentServer, defineAgents, gatewayBrowseTool, isSafeKey, PROVIDER, excelDatesToISO, excelSerialToISO, fileToMarkdown, jobTools, publicUrl, r2Source, readFileTool, z, type FileText, type FileView, type MarkdownAi } from '../src/index';

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

describe('gatewayBrowseTool', () => {
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	const fake = (status: number, body: unknown) =>
		(globalThis.fetch = (async (url: string, init: RequestInit) => (calls.push(`${url} ${(init.headers as Record<string, string>).authorization}`), new Response(JSON.stringify(body), { status }))) as never);
	const withProvider = (baseURL?: string) => ctxOf(baseURL ? { [PROVIDER]: { baseURL, apiKey: 'rl_key', model: 'rubry' } } : {});

	it('asks the caller\'s provider to browse, with its key', async () => {
		fake(200, { pages: [{ url: 'https://example.com', text: 'hi' }] });
		const out = await gatewayBrowseTool().execute!({ urls: ['https://example.com'] }, withProvider('https://rubry.ai/api/llm/v1/') as never);
		expect(out).toEqual({ pages: [{ url: 'https://example.com', text: 'hi' }] });
		expect(calls.at(-1)).toBe('https://rubry.ai/api/llm/v1/tools/browse Bearer rl_key');
	});
	it('falls back when the provider has no browser, and passes its refusal through', async () => {
		fake(404, {});
		const fallback = { execute: async () => ({ pages: ['own'] }) };
		expect(await gatewayBrowseTool({ fallback }).execute!({ urls: ['https://example.com'] }, withProvider('https://api.openai.com/v1') as never)).toEqual({ pages: ['own'] });
		expect(await gatewayBrowseTool().execute!({ urls: ['https://example.com'] }, withProvider() as never)).toHaveProperty('error');
		fake(429, { error: { message: 'No Rubry credit left' } });
		expect(await gatewayBrowseTool({ fallback }).execute!({ urls: ['https://example.com'] }, withProvider('https://rubry.ai/api/llm/v1') as never)).toEqual({ error: 'No Rubry credit left' });
		globalThis.fetch = realFetch;
	});
});

describe('read_file navigation and sources', () => {
	const WORKBOOK = ['# book.xlsx', '## Index', '| GD22 | railway |', '## GD21', '| 2019 | 6420 |', '## GD22', '| Unit | R$ bn |', '| 2023 | 11.39 |', '| 2024 | 14.25 |', '## GD24', '| 2019 | 98 |'].join('\n');
	const book = ai(WORKBOOK);

	it('lists the headings and reads one sheet, then the lines around a word', async () => {
		const tool = readFileTool({ ai: () => book, load: async () => ({ name: 'book.xlsx', bytes: new Uint8Array([1]) }) });
		const sheet = (await tool.execute!({ file: 'k', section: 'gd22' }, ctxOf({}) as never)) as FileView;
		expect(sheet.headings).toEqual(['book.xlsx', 'Index', 'GD21', 'GD22', 'GD24']);
		expect(sheet.sectionsFound).toEqual(['GD22']);
		expect(sheet.markdown).toContain('14.25');
		expect(sheet.markdown).not.toContain('6420');
		const line = (await tool.execute!({ file: 'k', section: 'GD22', match: '2024' }, ctxOf({}) as never)) as FileView;
		expect(line.matches).toBe(1);
		expect(line.markdown).toContain('4: | 2024 | 14.25 |');
		expect(line.markdown).not.toContain('GD24');
	});

	it('keeps the whole document in the cache and cuts only the answer', async () => {
		const store = new Map<string, FileText>();
		const tool = readFileTool({
			ai: () => ai(`## A\n${'x'.repeat(500)}\n## B\nend`),
			load: async () => ({ name: 'a.pdf', bytes: new Uint8Array([1]), version: 'v1' }),
			maxChars: 100,
			cache: { get: async (k) => store.get(k) ?? null, put: async (k, t) => void store.set(k, t) },
		});
		const first = (await tool.execute!({ file: 'k' }, ctxOf({}) as never)) as FileView;
		expect(first.truncated).toBe(true);
		expect([...store.keys()]).toEqual(['k@v1']);
		expect((await tool.execute!({ file: 'k', section: 'B' }, ctxOf({}) as never)) as FileView).toMatchObject({ markdown: '## B\nend', truncated: false });
	});

	it('reads from named sources the model picks', async () => {
		const tool = readFileTool({
			ai: () => ai('# Hi'),
			sources: {
				attachment: { describe: 'An uploads/ key.', load: async (ref) => (ref.startsWith('uploads/me/') ? { name: 'a.pdf', bytes: new Uint8Array([1]) } : null) },
				lake: { describe: 'A lake key.', load: async () => ({ name: 'b.csv', bytes: new Uint8Array([1]) }) },
			},
		});
		expect(await tool.execute!({ source: 'attachment', file: 'uploads/other/a.pdf' } as never, ctxOf({}) as never)).toEqual({ error: 'No such file in attachment.' });
		expect(await tool.execute!({ source: 'lake', file: 'Sources/b.csv' } as never, ctxOf({}) as never)).toMatchObject({ source: 'lake', name: 'b.csv' });
	});
});

describe('r2Source', () => {
	const objects = new Map<string, string>([['uploads/ana/1/a.pdf', 'A'], ['uploads/bob/1/b.pdf', 'B']]);
	const bucket = {
		get: async (key: string) => {
			const v = objects.get(key);
			return v === undefined ? null : { size: v.length, etag: `e-${key}`, httpMetadata: { contentType: 'application/pdf' }, body: { cancel: async () => {} }, arrayBuffer: async () => new TextEncoder().encode(v).buffer };
		},
	} as unknown as R2Bucket;
	const source = r2Source({ bucket: () => bucket, describe: 'x', folder: (ctx) => `uploads/${ctx?.requestContext?.get('who')}/` });

	it('reads only the caller folder, by exact key, with the etag as version', async () => {
		expect(await source.load('uploads/ana/1/a.pdf', ctxOf({ who: 'ana' }) as never)).toMatchObject({ name: 'a.pdf', version: 'e-uploads/ana/1/a.pdf' });
		expect(await source.load('uploads/bob/1/b.pdf', ctxOf({ who: 'ana' }) as never)).toBeNull();
		expect(await source.load('uploads/ana/../bob/1/b.pdf', ctxOf({ who: 'ana' }) as never)).toBeNull();
		expect(isSafeKey('/x')).toBe(false);
	});
});

describe('spreadsheet dates', () => {
	const sheet = [
		'| DATA | | SÉRIE | ID |',
		'|------|-|-------|----|',
		'| 2003 | 1T2003 | 856.47 | 12345 |',
		...[37622, 37653, 37681, 37712, 37742, 37773, 43709].map((d, i) => `| 2003 | x | ${d} | ${20000 + i * 1000} |`),
		'| 2004 | y | 512.3 | 27500 |',
	].join('\n');

	it('turns a monthly serial column into ISO dates and leaves other numbers alone', () => {
		const out = excelDatesToISO(['| DATA | | SÉRIE |', '|---|---|---|', ...[37622, 37653, 37681, 37712, 37742, 37773, 43709].map((d) => `| 2003 | ${d} | 1.5 |`)].join('\n'));
		expect(out).toContain('| 2003-01-01 |');
		expect(out).toContain('| 2019-09-01 |');
		expect(out).toContain('| 1.5 |');
		expect(excelSerialToISO(43709)).toBe('2019-09-01');
	});

	it('does not touch columns that are not dates', () => {
		// A text cell under the numbers, and a column whose steps are not calendar steps.
		expect(excelDatesToISO(sheet)).toBe(sheet);
	});

	it('converts dates of workbooks read with read_file', async () => {
		const rows = ['## GD13', '| DATA | | SÉRIE |', '|---|---|---|', ...[37622, 37653, 37681, 37712, 37742, 37773].map((d) => `| 2003 | ${d} | 1 |`)].join('\n');
		const tool = readFileTool({ ai: () => ai(rows), load: async () => ({ name: 'book.xlsx', bytes: new Uint8Array([1]) }) });
		const out = (await tool.execute!({ file: 'k', section: 'GD13' }, ctxOf({}) as never)) as FileView;
		expect(out.markdown).toContain('2003-06-01');
	});
});
