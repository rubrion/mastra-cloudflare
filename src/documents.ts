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

const SPREADSHEET = /\.(xlsx|xlsm|xlsb|xls|ods|et)$/i;
const SPREADSHEET_TYPE = /spreadsheet|excel|opendocument\.spreadsheet/i;

/** True for a workbook, by name or MIME type: its dates may come out as Excel serial numbers. */
export const isSpreadsheet = (file: { name: string; type?: string }) => SPREADSHEET.test(file.name) || SPREADSHEET_TYPE.test(file.type ?? '');

/** An Excel serial day (days since 1899-12-30) as YYYY-MM-DD. */
export function excelSerialToISO(serial: number): string {
	return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
}

// Steps between consecutive dates that mark a date column: daily, weekly, monthly, quarterly, yearly.
const DATE_STEPS = [[1, 1], [7, 7], [28, 31], [89, 92], [365, 366]] as const;

/**
 * Turns the date columns of Markdown tables from Excel serial numbers into ISO dates. A
 * column counts as dates only when every filled cell is a whole number between 10000 and
 * 80000 (1927–2119), there are at least 6, they never go down, and the usual step between
 * them is a day, a week, a month, a quarter or a year. Anything else is left as it is.
 */
export function excelDatesToISO(markdown: string): string {
	const lines = markdown.split('\n');
	let i = 0;
	while (i < lines.length) {
		if (!lines[i].trimStart().startsWith('|')) {
			i++;
			continue;
		}
		let end = i;
		while (end < lines.length && lines[end].trimStart().startsWith('|')) end++;
		const rows = lines.slice(i, end).map((l) => l.split('|'));
		const width = Math.max(...rows.map((r) => r.length));
		for (let col = 1; col < width - 1; col++) {
			const cells = rows.map((r, k) => ({ k, v: (r[col] ?? '').trim() })).filter((c) => c.v !== '' && !/^-+$/.test(c.v));
			const numbers = cells.filter((c) => /^\d{5}$/.test(c.v)).map((c) => ({ k: c.k, n: Number(c.v) }));
			if (numbers.length < 6 || numbers.some((c) => c.n < 10_000 || c.n > 80_000)) continue;
			// Text cells are allowed only above the numbers (the column's header rows).
			const firstNumber = numbers[0].k;
			if (cells.some((c) => c.k > firstNumber && !/^\d{5}$/.test(c.v))) continue;
			const steps = numbers.slice(1).map((c, j) => c.n - numbers[j].n);
			if (steps.some((d) => d < 0)) continue;
			const sorted = [...steps].sort((a, b) => a - b);
			const median = sorted[Math.floor(sorted.length / 2)];
			if (!DATE_STEPS.some(([lo, hi]) => median >= lo && median <= hi)) continue;
			for (const { k, n } of numbers) {
				const cell = rows[k][col];
				rows[k][col] = cell.replace(String(n), excelSerialToISO(n));
			}
		}
		for (let k = 0; k < rows.length; k++) lines[i + k] = rows[k].join('|');
		i = end;
	}
	return lines.join('\n');
}
