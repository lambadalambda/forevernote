import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/instance';
import { insertNote, listNotebooks } from '$lib/server/notes';

/** POST { notebookId?, title? } -> { id } */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as {
		notebookId?: unknown;
		title?: unknown;
	};
	const notebookId =
		typeof body.notebookId === 'number' ? body.notebookId : listNotebooks(getDb())[0]?.id;
	if (!notebookId) error(400, 'no notebook available');
	const title = typeof body.title === 'string' ? body.title : 'Untitled';
	const id = insertNote(getDb(), { notebookId, title, enml: '<en-note><div><br></div></en-note>' });
	return json({ id }, { status: 201 });
};
