/** Scoring helpers for comparing OCR output against a known-good reference text. */

/**
 * Normalises text so that only real recognition errors count: case, punctuation,
 * whitespace and German typography (ß/ss, curly quotes, dashes) are folded away.
 */
export const normalizeForCompare = (text: string): string =>
	text
		.toLowerCase()
		.replace(/ß/g, 'ss')
		.replace(/[„“”«»‚‘’]/g, '')
		.replace(/[–—−]/g, '-')
		.replace(/[^\p{L}\p{N}\s-]/gu, ' ')
		.replace(/(^|\s)-+(\s|$)/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

export const tokenize = (normalized: string): string[] =>
	normalized.split(' ').filter((w) => w.length > 0);

/** Levenshtein distance over word arrays, using a rolling row. */
const editDistance = (a: string[], b: string[]): number => {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
		}
		prev = row;
	}
	return prev[b.length];
};

/**
 * Word error rate of `hypothesis` against `reference`, in [0, 1].
 * Capped at 1 so one runaway output cannot dominate an average.
 */
export const wordErrorRate = (reference: string, hypothesis: string): number => {
	const ref = tokenize(normalizeForCompare(reference));
	const hyp = tokenize(normalizeForCompare(hypothesis));
	if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
	return Math.min(1, editDistance(ref, hyp) / ref.length);
};

/**
 * Order-insensitive overlap of two texts, counting repeats (multiset F1).
 * Tables and multi-column layouts are read in different orders by different engines,
 * which wrecks a sequence metric even when every word was recognised correctly.
 */
export const bagOfWordsF1 = (reference: string, hypothesis: string): number => {
	const ref = tokenize(normalizeForCompare(reference));
	const hyp = tokenize(normalizeForCompare(hypothesis));
	if (ref.length === 0 && hyp.length === 0) return 1;
	if (ref.length === 0 || hyp.length === 0) return 0;
	const counts = new Map<string, number>();
	for (const w of ref) counts.set(w, (counts.get(w) ?? 0) + 1);
	let overlap = 0;
	for (const w of hyp) {
		const n = counts.get(w) ?? 0;
		if (n > 0) {
			overlap++;
			counts.set(w, n - 1);
		}
	}
	if (overlap === 0) return 0;
	const precision = overlap / hyp.length;
	const recall = overlap / ref.length;
	return (2 * precision * recall) / (precision + recall);
};
