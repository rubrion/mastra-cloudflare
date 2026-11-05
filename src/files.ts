// Ready-made pieces for read_file over R2: a source that reads one object by exact key
// (never lists), optionally only under the caller's own folder, and a cache that keeps
// each converted document next to the files.
import type { FileSource, FileText, ToolCtx } from './tools.js';

export interface R2SourceOptions {
	bucket: (ctx: ToolCtx) => R2Bucket;
	/** One line for the model about what keys look like here. */
	describe: string;
	/**
	 * The folder the caller may read, e.g. their own uploads; null refuses. Leave out to allow
	 * any key in the bucket (for a bucket that is shared reference material).
	 */
	folder?: (ctx: ToolCtx) => string | null;
	/** Largest object read, in bytes. Default 20 MB. */
	maxBytes?: number;
}

/** A key read as is: no "..", no leading slash, no backslash, no query or fragment. */
export function isSafeKey(key: string): boolean {
	return Boolean(key) && !key.startsWith('/') && !key.split('/').includes('..') && !/[\\?#\0]/.test(key);
}

/** A read_file source over an R2 bucket. The object's etag is its version, so the cache follows changes. */
export function r2Source(o: R2SourceOptions): FileSource {
	const maxBytes = o.maxBytes ?? 20 * 1024 * 1024;
	return {
		describe: o.describe,
		load: async (ref, ctx) => {
			const key = ref.trim();
			if (!isSafeKey(key)) return null;
			if (o.folder) {
				const folder = o.folder(ctx);
				if (!folder || !key.startsWith(folder)) return null;
			}
			const obj = await o.bucket(ctx).get(key);
			if (!obj) return null;
			if (obj.size > maxBytes) {
				await obj.body.cancel();
				throw new Error(`${key} is ${obj.size} bytes, over the ${maxBytes}-byte limit`);
			}
			return { name: key.split('/').pop() ?? key, type: obj.httpMetadata?.contentType, bytes: await obj.arrayBuffer(), version: obj.etag };
		},
	};
}

/** read_file's cache in an R2 bucket: each converted document as JSON under `prefix`, keyed by a hash of the file and its version. */
export function r2Cache(bucket: (ctx: ToolCtx) => R2Bucket, prefix = 'read-file-cache/') {
	const keyOf = async (key: string) => {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
		return prefix + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') + '.json';
	};
	return {
		get: async (key: string, ctx: ToolCtx): Promise<FileText | null> => {
			const obj = await bucket(ctx).get(await keyOf(key));
			return obj ? ((await obj.json()) as FileText) : null;
		},
		put: async (key: string, text: FileText, ctx: ToolCtx): Promise<void> => {
			await bucket(ctx).put(await keyOf(key), JSON.stringify(text), { httpMetadata: { contentType: 'application/json' } });
		},
	};
}
