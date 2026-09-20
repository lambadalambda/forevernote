import type { NotePatch } from './notes.ts';

export interface NoteApiPatch extends NotePatch {
	trashed?: boolean;
}

const isStringArray = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Validates a JSON body for PATCH /api/notes/:id. Throws with a field name on bad input. */
export const parseNotePatch = (body: unknown): NoteApiPatch => {
	if (typeof body !== 'object' || body === null) throw new Error('expected a JSON object');
	const b = body as Record<string, unknown>;
	const out: NoteApiPatch = {};
	if ('title' in b) {
		if (typeof b.title !== 'string') throw new Error('title must be a string');
		out.title = b.title;
	}
	if ('html' in b) {
		if (typeof b.html !== 'string') throw new Error('html must be a string');
		out.html = b.html;
	}
	if ('tags' in b) {
		if (!isStringArray(b.tags)) throw new Error('tags must be a string array');
		out.tags = b.tags;
	}
	if ('notebookId' in b) {
		if (typeof b.notebookId !== 'number') throw new Error('notebookId must be a number');
		out.notebookId = b.notebookId;
	}
	if ('trashed' in b) {
		if (typeof b.trashed !== 'boolean') throw new Error('trashed must be a boolean');
		out.trashed = b.trashed;
	}
	return out;
};

/** Parses a positive integer route/query param. */
export const parseIntParam = (v: string | null | undefined): number | undefined => {
	if (!v || !/^\d+$/.test(v)) return undefined;
	const n = Number(v);
	return n > 0 ? n : undefined;
};

/** 100 MB: the largest attachment in the imported archive is 12 MB, so this is ample. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Types that browsers render as markup in the same origin. Attachments are served with a
 * sandbox CSP, but refusing them outright keeps a second line of defence.
 */
const BLOCKED_UPLOAD_TYPES = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml)$/i;

/** Validates an upload's declared type and size. Returns an error message, or undefined if fine. */
export const checkUpload = (file: {
	name?: string;
	type: string;
	size: number;
}): string | undefined => {
	// Browsers leave the type empty for extensions they do not recognise. That is not a
	// reason to refuse the file; it just means we treat it as opaque bytes.
	if (BLOCKED_UPLOAD_TYPES.test(file.type)) return `files of type ${file.type} are not allowed`;
	if (file.size <= 0) return 'the file is empty';
	if (file.size > MAX_UPLOAD_BYTES)
		return `the file is too large (limit ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)`;
	return undefined;
};
