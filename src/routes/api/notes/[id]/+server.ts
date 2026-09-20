import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/instance';
import { parseIntParam, parseNotePatch } from '$lib/server/api';
import { deleteNoteForever, getNote, setTrashed, updateNote } from '$lib/server/notes';

const noteId = (raw: string) => {
	const id = parseIntParam(raw);
	if (!id || !getNote(getDb(), id)) error(404, 'note not found');
	return id;
};

export const GET: RequestHandler = ({ params }) => json(getNote(getDb(), noteId(params.id)));

export const PATCH: RequestHandler = async ({ params, request }) => {
	const id = noteId(params.id);
	let patch;
	try {
		patch = parseNotePatch(await request.json());
	} catch (e) {
		error(400, (e as Error).message);
	}
	const { trashed, ...rest } = patch;
	if (Object.keys(rest).length) updateNote(getDb(), id, rest);
	if (trashed !== undefined) setTrashed(getDb(), id, trashed);
	return json(getNote(getDb(), id));
};

/** DELETE moves to trash; DELETE ?forever=1 removes permanently. */
export const DELETE: RequestHandler = ({ params, url }) => {
	const id = noteId(params.id);
	if (url.searchParams.has('forever')) deleteNoteForever(getDb(), id);
	else setTrashed(getDb(), id, true);
	return new Response(null, { status: 204 });
};
