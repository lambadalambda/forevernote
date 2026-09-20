import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/instance';
import { parseIntParam } from '$lib/server/api';
import { getNote, listNotebooks, listNotes, listTags } from '$lib/server/notes';

export const load: PageServerLoad = ({ url, depends }) => {
	depends('app:data');
	const q = url.searchParams;
	const filter = {
		notebookId: parseIntParam(q.get('notebook')),
		tagId: parseIntParam(q.get('tag')),
		query: q.get('q') ?? undefined,
		trashed: q.get('view') === 'trash'
	};
	const noteId = parseIntParam(q.get('note'));
	return {
		filter,
		notebooks: listNotebooks(getDb()),
		tags: listTags(getDb()),
		notes: listNotes(getDb(), filter),
		note: noteId ? (getNote(getDb(), noteId) ?? null) : null
	};
};
