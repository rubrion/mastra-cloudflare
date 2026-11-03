// Reading web pages in a headless browser (Cloudflare Browser Run, the
// `browser` binding). Its own entry, `@rubrion/mastra-cloudflare/browser`, so
// only agents that browse need `@cloudflare/puppeteer` installed; it's loaded on
// first use, not at startup.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { BrowserWorker } from '@cloudflare/puppeteer';
import { clip, publicUrl, type Allow, type ToolCtx } from './tools.js';

export interface PageText {
	url: string;
	title?: string;
	text?: string;
	truncated?: boolean;
	links?: { text: string; href: string }[];
	error?: string;
}

export interface ReadPagesOptions {
	/** Only these hosts (and their subdomains); any public host when empty. */
	allow?: string[];
	/** Characters of text kept per page. */
	maxChars?: number;
	/** Per page. */
	timeoutMs?: number;
	/** Links kept per page, for the model to follow. */
	maxLinks?: number;
}

// Runs in the page. A string, so this package needs no DOM types.
const EXTRACT = `(() => {
	const root = document.querySelector('main, article, [role=main]') || document.body;
	for (const el of root.querySelectorAll('script, style, noscript, svg, iframe')) el.remove();
	return {
		title: document.title,
		text: (root.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim(),
		links: [...document.querySelectorAll('a[href]')].map((a) => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href })).filter((l) => l.text && /^https?:/.test(l.href)),
	};
})()`;

/**
 * Open each URL in one browser, one after another, and return its readable text.
 * Requests to private addresses (redirects and subresources too) are blocked, and
 * images, media and fonts are skipped. `ms` is how long the browser was open:
 * what Browser Run bills.
 */
export async function readPages(binding: BrowserWorker, urls: string[], o: ReadPagesOptions = {}) {
	const { default: puppeteer } = await import('@cloudflare/puppeteer');
	const began = Date.now();
	const browser = await puppeteer.launch(binding);
	const pages: PageText[] = [];
	try {
		for (const raw of urls) {
			const url = publicUrl(raw, o.allow);
			if (!url) {
				pages.push({ url: raw, error: 'Not a public web address this tool may open.' });
				continue;
			}
			const page = await browser.newPage();
			try {
				await page.setRequestInterception(true);
				page.on('request', (req) => {
					const kind = req.resourceType();
					if (kind === 'image' || kind === 'media' || kind === 'font' || !publicUrl(req.url())) req.abort();
					else req.continue();
				});
				const res = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: o.timeoutMs ?? 15_000 });
				// A moment for scripts that fill the page after load.
				await new Promise((r) => setTimeout(r, 800));
				const got = (await page.evaluate(EXTRACT)) as { title: string; text: string; links: { text: string; href: string }[] };
				const { text, truncated } = clip(got.text, o.maxChars ?? 12_000);
				pages.push({
					url: page.url(),
					title: got.title,
					text,
					truncated,
					links: got.links.slice(0, o.maxLinks ?? 30),
					...(res && !res.ok() ? { error: `HTTP ${res.status()}` } : {}),
				});
			} catch (e) {
				pages.push({ url: url.href, error: (e as Error).message });
			} finally {
				await page.close().catch(() => {});
			}
		}
	} finally {
		await browser.close().catch(() => {});
	}
	return { pages, ms: Date.now() - began };
}

export interface BrowseOptions extends ReadPagesOptions {
	/** The `browser` binding. */
	browser: (ctx: ToolCtx) => BrowserWorker;
	id?: string;
	description?: string;
	/** Pages per call. */
	maxPages?: number;
	allow?: string[];
	/** Checked before opening the browser; return a message to refuse. */
	guard?: Allow;
	/** After, with the browser time, so the app can charge whoever asked. */
	used?: (ctx: ToolCtx, usage: { ms: number; pages: number }) => Promise<void> | void;
}

/** `browse`: open public web pages in a headless browser and read them. */
export const browseTool = (o: BrowseOptions) =>
	createTool({
		id: o.id ?? 'browse',
		description:
			o.description ??
			'Open public web pages in a real browser (pages that need JavaScript too) and read their text and links. Use for a page the user names or one you need to answer; never for logins or captchas.',
		inputSchema: z.object({ urls: z.array(z.string().url()).min(1).max(o.maxPages ?? 3).describe('Full http(s) addresses') }),
		execute: async ({ urls }, ctx) => {
			const refused = await o.guard?.(ctx);
			if (refused) return { error: refused };
			try {
				const { pages, ms } = await readPages(o.browser(ctx), urls, o);
				await o.used?.(ctx, { ms, pages: pages.length });
				return { pages };
			} catch (e) {
				return { error: `The browser failed: ${(e as Error).message}` };
			}
		},
	});
