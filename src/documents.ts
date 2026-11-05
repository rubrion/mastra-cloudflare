// Reading a long document a piece at a time. toMarkdown turns a workbook into one
// "## <sheet>" section per worksheet and a PDF or Word file into its headings, so an
// agent can list the headings, then read one section, or only the lines around a word,
// instead of the first N characters of a file that may be millions of characters long.

function fold(text: string): string {
	return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** The headings of a converted document (levels 1–3): a workbook's sheets, a report's sections. */
export function documentHeadings(markdown: string, max = 80): string[] {
	return markdown
		.split('\n')
		.filter((l) => /^#{1,3}\s/.test(l))
		.map((l) => l.replace(/^#+\s+/, '').trim())
		.slice(0, max);
}

/**
 * The sections whose heading contains `name` (case- and accent-insensitive), each up to
 * the next heading of the same or a higher level.
 */
export function documentSections(markdown: string, name: string): { found: string[]; text: string } {
	const lines = markdown.split('\n');
	const wanted = fold(name);
	const found: string[] = [];
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
		if (!m || !fold(m[2]).includes(wanted)) continue;
		const level = m[1].length;
		found.push(m[2].trim());
		let j = i + 1;
		while (j < lines.length) {
			const h = /^(#{1,6})\s/.exec(lines[j]);
			if (h && h[1].length <= level) break;
			j++;
		}
		out.push(...lines.slice(i, j));
		i = j - 1;
	}
	return { found, text: out.join('\n') };
}

/** The lines containing `match` (case- and accent-insensitive), with `around` lines on each side, numbered; gaps shown as "…". */
export function matchingLines(text: string, match: string, around = 3, maxLines = 120): { matches: number; text: string; truncated: boolean } {
	const lines = text.split('\n');
	const needle = fold(match);
	const hits = lines.flatMap((l, i) => (fold(l).includes(needle) ? [i] : []));
	const keep = new Set<number>();
	for (const h of hits) for (let i = Math.max(0, h - around); i <= Math.min(lines.length - 1, h + around); i++) keep.add(i);
	const ordered = [...keep].sort((a, b) => a - b);
	const out: string[] = [];
	let prev = -2;
	for (const i of ordered.slice(0, maxLines)) {
		if (i !== prev + 1) out.push('…');
		out.push(`${i + 1}: ${lines[i]}`);
		prev = i;
	}
	return { matches: hits.length, text: out.join('\n'), truncated: ordered.length > maxLines };
}

export interface DocumentView {
	/** The document's headings, so the model knows which section to ask for next. */
	headings: string[];
	/** Characters in the whole converted document. */
	chars: number;
	sectionsFound?: string[];
	matches?: number;
	/** The part asked for, cut to maxChars. */
	markdown: string;
	truncated: boolean;
}

/** Narrows a converted document to a section and/or the lines around a match, then cuts it to `maxChars`. */
export function viewDocument(markdown: string, q: { section?: string; match?: string }, maxChars: number): DocumentView {
	const view: Omit<DocumentView, 'markdown' | 'truncated'> = { headings: documentHeadings(markdown), chars: markdown.length };
	let text = markdown;
	if (q.section) {
		const s = documentSections(markdown, q.section);
		view.sectionsFound = s.found;
		text = s.text;
	}
	let truncated = false;
	if (q.match) {
		const m = matchingLines(text, q.match);
		view.matches = m.matches;
		text = m.text;
		truncated = m.truncated;
	}
	if (text.length > maxChars) {
		const cut = text.lastIndexOf('\n', maxChars);
		text = text.slice(0, cut > maxChars * 0.8 ? cut : maxChars);
		truncated = true;
	}
	return { ...view, markdown: text, truncated };
}
