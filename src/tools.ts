// Tools an agent opts into: reading a file it was given, and long work that
// runs in a Workflow while the chat goes on. Reading web pages lives in
// ./browser.ts (its own entry), so agents without a browser don't bundle one.
//
// Every tool takes `guard` (checked before the work; return a message to refuse,
// e.g. "not enough credit") and `used` (called after, with what the work cost),
// so the app charges whoever asked rather than absorbing it.
import { ToolCallFilter } from '@mastra/core/processors';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PROVIDER, type ProviderConfig } from './models.js';
import { viewDocument, type DocumentView } from './documents.js';

/** What a tool's execute gets as its second argument, as far as these tools need. */
export type ToolCtx = { requestContext?: { get(key: string): unknown } } | undefined;

/** Return a sentence for the model to refuse with, or nothing to go ahead. */
export type Allow = (ctx: ToolCtx) => Promise<string | void> | string | void;

/** The Workers AI binding's file conversion, as these tools use it. */
export interface MarkdownAi {
	toMarkdown(files: { name: string; blob: Blob }[], options?: { conversionOptions?: Record<string, unknown> }): Promise<({ name: string; mimeType: string } & ({ format: 'markdown'; tokens: number; data: string } | { format: 'error'; error: string }))[]>;
}

export interface LoadedFile {
	name: string;
	type?: string;
	bytes: Uint8Array | ArrayBuffer | Blob;
}

/** Cut text to `max` characters, at a line break when one is near. */
export function clip(text: string, max: number) {
	if (text.length <= max) return { text, truncated: false };
	const cut = text.lastIndexOf('\n', max);
	return { text: text.slice(0, cut > max * 0.8 ? cut : max), truncated: true };
}

// Pictures go through an AI model (billed); text, documents and spreadsheets don't.
const IMAGE = /^image\//;
const IMAGE_NAME = /\.(png|jpe?g|webp|gif|bmp|tiff?|svg)$/i;
const NO_IMAGES = { pdf: { images: { convert: false } }, docx: { images: { convert: false } }, html: { images: { convert: false } } };

/** True for a picture: `fileToMarkdown` reads one only with `images: true`. */
export const isImage = (file: Pick<LoadedFile, 'name' | 'type'>) => IMAGE.test(file.type ?? '') || IMAGE_NAME.test(file.name);

/**
 * A file as Markdown (PDF, Office, spreadsheets, HTML, XML…), cut to `maxChars`.
 * Pictures, alone or inside documents, are described by an AI model that Workers
 * AI bills: off unless `images` is true (a vision model reads a picture better anyway).
 */
export async function fileToMarkdown(ai: MarkdownAi, file: LoadedFile, maxChars = 20_000, { images = false } = {}): Promise<FileText | { error: string }> {
	if (!images && isImage(file)) return { error: `${file.name} is a picture; this tool reads documents. Look at the image itself instead.` };
	const blob = file.bytes instanceof Blob ? file.bytes : new Blob([file.bytes as ArrayBuffer], { type: file.type ?? 'application/octet-stream' });
	const [out] = await ai.toMarkdown([{ name: file.name, blob }], images ? undefined : { conversionOptions: NO_IMAGES });
	if (!out || out.format === 'error') return { error: `Could not read ${file.name}: ${out?.format === 'error' ? out.error : 'no result'}` };
	const { text, truncated } = clip(out.data.trim(), maxChars);
	return { name: file.name, type: out.mimeType, markdown: text, truncated, tokens: out.tokens };
}

export interface FileText {
	name: string;
	type: string;
	markdown: string;
	truncated: boolean;
	tokens: number;
}

/** A file as `read_file` returns it: the part asked for, plus the map of the whole document. */
export interface FileView extends FileText, DocumentView {
	source?: string;
}

/** Where a file comes from: the chat's attachments, a bucket, a repository… */
export interface FileSource {
	/** One line for the model: what refs look like here, e.g. 'a lake key such as "Sources/x.xlsx"'. */
	describe: string;
	/** The file behind `ref`, or null when it does not exist or is not the caller's. `version` (an etag, a sha) keys the cache. */
	load: (ref: string, ctx: ToolCtx) => Promise<(LoadedFile & { version?: string }) | null>;
}

export interface ReadFileOptions {
	ai: (ctx: ToolCtx) => MarkdownAi;
	/** The file behind a reference the conversation holds (an attachment id, an R2 key); null when it isn't the caller's. Shorthand for one source. */
	load?: (ref: string, ctx: ToolCtx) => Promise<(LoadedFile & { version?: string }) | null>;
	/** Several places files come from; the model picks one with `source`. Takes the place of `load`. */
	sources?: Record<string, FileSource>;
	id?: string;
	description?: string;
	/** Longest text handed back per call, after `section` and `match`. Default 20,000. */
	maxChars?: number;
	/** Longest document converted and cached whole, so later calls can read any section. Default 2,000,000. */
	maxDocumentChars?: number;
	/** Describe pictures with an AI model (billed by Workers AI). Off by default. */
	images?: boolean;
	/** Where converted text is kept, so a file is converted once per version (see r2Cache). */
	cache?: {
		get: (key: string, ctx: ToolCtx) => Promise<FileText | null>;
		put: (key: string, text: FileText, ctx: ToolCtx) => Promise<void>;
	};
	guard?: Allow;
	used?: (ctx: ToolCtx, usage: { name: string; tokens: number; chars: number; cached: boolean }) => Promise<void> | void;
}

const NAVIGATION =
	' Every answer lists the document\'s headings (a workbook\'s sheets, a report\'s sections); read a long file in pieces: section to read one of them, match to get only the lines around a word, a code or a year.';

/**
 * `read_file`: the text of a file as Markdown (PDF, Word, Excel, CSV, HTML, XML…), read a
 * piece at a time. The whole document is converted once (and cached per version); each
 * call returns its headings plus the section or the lines asked for, cut to maxChars.
 */
export const readFileTool = (o: ReadFileOptions) => {
	const sources: Record<string, FileSource> = o.sources ?? { file: { describe: 'The attached file reference shown in the conversation.', load: o.load ?? (async () => null) } };
	const names = Object.keys(sources);
	if (!names.length) throw new Error('readFileTool: give load or at least one source');
	const multi = names.length > 1 || Boolean(o.sources);
	const maxChars = o.maxChars ?? 20_000;
	const fileText = multi ? `The file reference. ${names.map((n) => `${n}: ${sources[n].describe}`).join(' ')}` : sources[names[0]].describe;

	return createTool({
		id: o.id ?? 'read_file',
		description:
			(o.description ??
				(multi
					? `Read a file (PDF, Word, Excel, CSV, HTML, XML) and get its text as Markdown, from one of these sources: ${names.join(', ')}.`
					: 'Read a file the user attached (PDF, Word, Excel, CSV, HTML, XML, image) and get its text as Markdown. Pass the file reference shown in the conversation.')) + NAVIGATION,
		inputSchema: z.object({
			...(multi ? { source: z.enum(names as [string, ...string[]]).describe('Where the file is.') } : {}),
			file: z.string().min(1).max(500).describe(fileText),
			section: z.string().max(200).optional().describe('Read only the section (or sheet) whose heading contains this, e.g. "Summary" or a sheet name.'),
			match: z.string().max(200).optional().describe('Return only the lines containing this text, with 3 lines around each.'),
		}),
		execute: async (input: { source?: unknown; file: string; section?: string; match?: string }, ctx: ToolCtx): Promise<FileView | { error: string }> => {
			const refused = await o.guard?.(ctx);
			if (refused) return { error: refused };
			const name = multi && typeof input.source === 'string' ? input.source : names[0];
			const source = sources[name];
			if (!source) return { error: `Unknown source "${name}". Use one of: ${names.join(', ')}.` };

			const loaded = await source.load(input.file, ctx).catch(() => null);
			if (!loaded) return { error: multi ? `No such file in ${name}.` : 'No such file in this conversation.' };

			// The key names the file and its version, so a changed file is converted again.
			const key = [multi ? `${name}:` : '', input.file, loaded.version ? `@${loaded.version}` : ''].join('');
			let whole = await o.cache?.get(key, ctx).catch(() => null);
			const cached = Boolean(whole);
			if (!whole) {
				const out = await fileToMarkdown(o.ai(ctx), loaded, o.maxDocumentChars ?? 2_000_000, { images: o.images }).catch(
					(e: Error) => ({ error: `Could not read ${loaded.name}: ${e.message}` }) as const,
				);
				if ('error' in out) return out;
				whole = out;
				await o.cache?.put(key, out, ctx).catch(() => undefined);
			}

			const view = viewDocument(whole.markdown, input, maxChars);
			await o.used?.(ctx, { name: whole.name, tokens: whole.tokens, chars: view.markdown.length, cached });
			return { ...whole, ...view, truncated: view.truncated || whole.truncated, ...(multi ? { source: name } : {}) };
		},
	});
};

/**
 * Keeps these tools' results out of the prompt once their turn is over: a file's
 * or a page's text is sent with the turn that read it, not with every message
 * after (memory still stores it). The model calls the tool again if it needs it.
 * For an agent's `inputProcessors`.
 */
export const forgetResults = (tools: string[]) => new ToolCallFilter({ exclude: tools });

export interface GatewayBrowseOptions {
	id?: string;
	description?: string;
	/** Used when the request's provider offers no browser: e.g. browseTool from ./browser, on your own binding. */
	fallback?: { execute?: (input: never, ctx: never) => Promise<unknown> };
}

/**
 * `browse` through the model provider's gateway: when a caller brings its model
 * (X-Provider-* headers) and that provider offers a browser at `<baseURL>/tools/browse`
 * (rubry.ai's does, for an agent run on Rubry's model), the caller's provider
 * opens the pages and charges its user, so the agent's author pays nothing.
 * Otherwise `fallback`, or an error the model can explain.
 */
export const gatewayBrowseTool = (o: GatewayBrowseOptions = {}) =>
	createTool({
		id: o.id ?? 'browse',
		description:
			o.description ??
			'Open one or two public web pages in a real browser (pages that need JavaScript too) and read their text and links. Never for logins or captchas.',
		inputSchema: z.object({ urls: z.array(z.string().url()).min(1).max(2).describe('Full http(s) addresses') }),
		execute: async (input, ctx) => {
			const provider = ctx?.requestContext?.get(PROVIDER) as ProviderConfig | undefined;
			if (provider?.baseURL) {
				const r = await fetch(`${provider.baseURL.replace(/\/+$/, '')}/tools/browse`, {
					method: 'POST',
					headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' },
					body: JSON.stringify(input),
					signal: AbortSignal.timeout(60_000),
				}).catch(() => null);
				if (r?.ok) return r.json();
				// 404/405: this provider has no browser; anything else is its answer (e.g. no credit).
				if (r && r.status !== 404 && r.status !== 405) {
					const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
					return { error: body?.error?.message ?? `The browser answered ${r.status}.` };
				}
			}
			if (o.fallback?.execute) return o.fallback.execute(input as never, ctx as never);
			return { error: 'No browser here: it runs only when the chat brings a model that offers one (like Rubry’s). Tell the user.' };
		},
	});

/** The Workflow binding, as the job tools use it. */
export interface WorkflowLike<P> {
	create(options: { id?: string; params?: P }): Promise<{ id: string }>;
	get(id: string): Promise<{ status(): Promise<{ status: string; output?: unknown; error?: unknown }> }>;
}

export interface JobToolsOptions<S extends z.ZodObject> {
	/** `start_<name>` and `check_<name>`. */
	name: string;
	/** What the job does, for the model (the start tool's description). */
	description: string;
	input: S;
	workflow: (ctx: ToolCtx) => WorkflowLike<z.infer<S> & { owner: string } & Record<string, unknown>>;
	/** Who asked: only they can check the job. */
	owner: (ctx: ToolCtx) => string;
	/** More for the Workflow from the request, beside the model's input (e.g. whose credit to charge). */
	params?: (ctx: ToolCtx) => Record<string, unknown>;
	/** How long check waits for the job to finish before answering "still running". */
	waitMs?: number;
	guard?: (ctx: ToolCtx, input: z.infer<S>) => Promise<string | void> | string | void;
	/** After the job starts; charge here what it will cost, or charge in the Workflow by what it used. */
	started?: (ctx: ToolCtx, input: z.infer<S>, job: string) => Promise<void> | void;
}

const DONE = new Set(['complete', 'errored', 'terminated']);

async function tag(owner: string) {
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(owner));
	return [...new Uint8Array(bytes)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A start/check pair over a Workflow: the job outlives the chat request, and the
 * model checks on it (now, or in a later message). A job id carries a tag of its
 * owner, so one person can't read another's.
 */
export function jobTools<S extends z.ZodObject>(o: JobToolsOptions<S>) {
	const start = createTool({
		id: `start_${o.name}`,
		description: `${o.description} Runs in the background: returns a job id at once; then call check_${o.name} with it.`,
		inputSchema: o.input,
		execute: async (input, ctx) => {
			const args = input as z.infer<S>;
			const refused = await o.guard?.(ctx, args);
			if (refused) return { error: refused };
			const owner = o.owner(ctx);
			const id = `${await tag(owner)}-${crypto.randomUUID()}`;
			await o.workflow(ctx).create({ id, params: { ...o.params?.(ctx), ...args, owner } });
			await o.started?.(ctx, args, id);
			return { job: id, status: 'running' };
		},
	});
	const check = createTool({
		id: `check_${o.name}`,
		description: `The state of a job from start_${o.name}, and its result once complete. Waits a little for it.`,
		inputSchema: z.object({ job: z.string().min(10).max(100) }),
		execute: async ({ job }, ctx) => {
			if (!job.startsWith(`${await tag(o.owner(ctx))}-`)) return { error: 'No such job.' };
			const instance = await o.workflow(ctx).get(job).catch(() => null);
			if (!instance) return { error: 'No such job.' };
			const until = Date.now() + (o.waitMs ?? 15_000);
			for (;;) {
				const s = await instance.status();
				if (DONE.has(s.status)) return s.status === 'complete' ? { job, status: 'complete', result: s.output } : { job, status: 'failed', error: String((s.error as { message?: string })?.message ?? s.error ?? s.status) };
				if (Date.now() > until) return { job, status: 'running', note: 'Still running: tell the user, and check again when they ask.' };
				await new Promise((r) => setTimeout(r, 1500));
			}
		},
	});
	return { start, check };
}

function privateV4(host: string) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
	if (a === 100 && b >= 64 && b < 128) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b < 32) return true;
	if (a === 192 && b === 168) return true;
	return false;
}

/**
 * The URL when it's a public http(s) address (and, with `allow`, on one of those
 * hosts or their subdomains); null otherwise. Keeps a browser or fetch off
 * localhost, private networks and cloud metadata addresses.
 */
export function publicUrl(input: string, allow?: string[]): URL | null {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	if (url.username || url.password) return null;
	if (url.port && url.port !== '80' && url.port !== '443') return null;
	const host = url.hostname.toLowerCase().replace(/\.$/, '');
	if (!host.includes('.') || host.startsWith('[')) return null; // single labels, IPv6 literals
	if (/(^|\.)(localhost|local|internal|home|lan|corp|intranet)$/.test(host)) return null;
	if (/^\d+$/.test(host) || /^0x/i.test(host) || privateV4(host)) return null;
	if (allow?.length && !allow.some((h) => host === h || host.endsWith(`.${h}`))) return null;
	return url;
}
