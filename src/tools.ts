// Tools an agent opts into: reading a file it was given, and long work that
// runs in a Workflow while the chat goes on. Reading web pages lives in
// ./browser.ts (its own entry), so agents without a browser don't bundle one.
//
// Every tool takes `guard` (checked before the work; return a message to refuse,
// e.g. "not enough credit") and `used` (called after, with what the work cost),
// so the app charges whoever asked rather than absorbing it.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/** What a tool's execute gets as its second argument, as far as these tools need. */
export type ToolCtx = { requestContext?: { get(key: string): unknown } } | undefined;

/** Return a sentence for the model to refuse with, or nothing to go ahead. */
export type Allow = (ctx: ToolCtx) => Promise<string | void> | string | void;

/** The Workers AI binding's file conversion, as these tools use it. */
export interface MarkdownAi {
	toMarkdown(files: { name: string; blob: Blob }[]): Promise<({ name: string; mimeType: string } & ({ format: 'markdown'; tokens: number; data: string } | { format: 'error'; error: string }))[]>;
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

/** A file as Markdown (PDF, Office, spreadsheets, HTML, XML, images…), cut to `maxChars`. */
export async function fileToMarkdown(ai: MarkdownAi, file: LoadedFile, maxChars = 20_000): Promise<FileText | { error: string }> {
	const blob = file.bytes instanceof Blob ? file.bytes : new Blob([file.bytes as ArrayBuffer], { type: file.type ?? 'application/octet-stream' });
	const [out] = await ai.toMarkdown([{ name: file.name, blob }]);
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

export interface ReadFileOptions {
	ai: (ctx: ToolCtx) => MarkdownAi;
	/** The file behind a reference the conversation holds (an attachment id, an R2 key); null when it isn't the caller's. */
	load: (ref: string, ctx: ToolCtx) => Promise<LoadedFile | null>;
	id?: string;
	description?: string;
	maxChars?: number;
	guard?: Allow;
	used?: (ctx: ToolCtx, usage: { name: string; tokens: number; chars: number }) => Promise<void> | void;
}

/** `read_file`: the text of a file the user attached, for the model to work with. */
export const readFileTool = (o: ReadFileOptions) =>
	createTool({
		id: o.id ?? 'read_file',
		description:
			o.description ??
			'Read a file the user attached (PDF, Word, Excel, CSV, HTML, XML, image) and get its text as Markdown. Pass the file reference shown in the conversation.',
		inputSchema: z.object({ file: z.string().min(1).max(300).describe('The attached file reference') }),
		execute: async ({ file }, ctx) => {
			const refused = await o.guard?.(ctx);
			if (refused) return { error: refused };
			const loaded = await o.load(file, ctx).catch(() => null);
			if (!loaded) return { error: 'No such file in this conversation.' };
			const out = await fileToMarkdown(o.ai(ctx), loaded, o.maxChars).catch((e: Error) => ({ error: `Could not read ${loaded.name}: ${e.message}` }) as const);
			if ('markdown' in out) await o.used?.(ctx, { name: out.name, tokens: out.tokens, chars: out.markdown.length });
			return out;
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
