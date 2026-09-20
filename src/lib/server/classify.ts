/**
 * Titling and tagging of uploaded documents by the same local model that reads them.
 * The model is shown the existing tags and notebooks so an intake reuses the taxonomy
 * instead of inventing a near-duplicate for every document.
 */

export interface ClassifyContext {
	fileName?: string;
	text: string;
	existingTags: string[];
	notebooks: string[];
}

export interface Classification {
	title: string;
	tags: string[];
	notebook?: string;
}

/** Enough of a document to tell what it is; the opening usually carries sender and subject. */
const TEXT_BUDGET = 4000;
const MAX_TAGS = 4;
const MAX_TITLE = 120;
const MIN_TEXT_CHARS = 20;

/** Tags that describe the artefact rather than the subject, and so tell you nothing. */
const GENERIC_TAGS = new Set([
	'dokument',
	'dokumente',
	'document',
	'documents',
	'scan',
	'scans',
	'pdf',
	'brief',
	'letter',
	'datei',
	'file',
	'note',
	'notiz'
]);

export const buildClassifyPrompt = ({
	fileName,
	text,
	existingTags,
	notebooks
}: ClassifyContext): string =>
	[
		'You are filing a document into a personal note archive.',
		'Answer with one JSON object and nothing else:',
		'{"title": "...", "tags": ["..."], "notebook": "..."}',
		'',
		`title: a short descriptive title in the document's own language, at most 8 words.`,
		`  Name the sender and what it is, for example "Rechnung Stadtwerke März 2021".`,
		`  Do not use the file name unless nothing better can be found.`,
		`tags: 1 to ${MAX_TAGS} tags naming the subject matter, such as Miete, Steuer,`,
		'  Versicherung, Gehalt, Reise. Prefer a tag that already exists over a new one.',
		'  Never use a notebook name as a tag, and never tag what the file is',
		'  (not "Dokument", "Scan", "PDF", "Brief").',
		existingTags.length
			? `  Existing tags: ${existingTags.join(', ')}`
			: '  There are no tags yet.',
		notebooks.length
			? `notebook: pick exactly one of: ${notebooks.join(', ')}`
			: 'notebook: omit this field.',
		'',
		fileName ? `File name: ${fileName}` : '',
		'Document text:',
		'"""',
		text.slice(0, TEXT_BUDGET),
		'"""'
	]
		.filter(Boolean)
		.join('\n');

/** Pulls the outermost JSON object out of a reply that may be fenced or padded with prose. */
const extractJson = (raw: string): Record<string, unknown> | undefined => {
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start === -1 || end <= start) return undefined;
	try {
		const value = JSON.parse(raw.slice(start, end + 1)) as unknown;
		return typeof value === 'object' && value !== null
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
};

const cleanTitle = (value: unknown): string => {
	if (typeof value !== 'string') return '';
	return value
		.trim()
		.replace(/^["'`]+|["'`]+$/g, '')
		.replace(/[.,;:]+$/, '')
		.trim()
		.slice(0, MAX_TITLE);
};

const toList = (value: unknown): string[] => {
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
	if (typeof value === 'string') return value.split(',');
	return [];
};

/**
 * Normalises the model's answer: tags are trimmed, deduplicated case-insensitively and
 * snapped onto existing tags so casing stays consistent; the notebook must already exist.
 */
export const parseClassification = (
	raw: string,
	vocab: { existingTags: string[]; notebooks: string[] }
): Classification => {
	const object = extractJson(raw);
	if (!object) return { title: '', tags: [] };

	const canonical = new Map(vocab.existingTags.map((t) => [t.toLowerCase(), t]));
	// The notebook names sit in the same prompt, and models reach for them as tags.
	const notTags = new Set([...vocab.notebooks.map((n) => n.toLowerCase()), ...GENERIC_TAGS]);
	const seen = new Set<string>();
	const tags: string[] = [];
	for (const candidate of toList(object.tags)) {
		const trimmed = candidate.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key) || notTags.has(key)) continue;
		seen.add(key);
		tags.push(canonical.get(key) ?? trimmed);
		if (tags.length === MAX_TAGS) break;
	}

	const wanted = typeof object.notebook === 'string' ? object.notebook.trim().toLowerCase() : '';
	const notebook = vocab.notebooks.find((n) => n.toLowerCase() === wanted);

	return { title: cleanTitle(object.title), tags, ...(notebook ? { notebook } : {}) };
};

/** Asks the model to title and tag a document. Returns empty values rather than throwing. */
export const classify = async (
	ctx: ClassifyContext,
	chat: (prompt: string) => Promise<string>
): Promise<Classification> => {
	if (ctx.text.trim().length < MIN_TEXT_CHARS) return { title: '', tags: [] };
	const reply = await chat(buildClassifyPrompt(ctx));
	return parseClassification(reply, ctx);
};
