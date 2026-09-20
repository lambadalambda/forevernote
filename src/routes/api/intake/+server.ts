import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/instance';
import { checkUpload, parseIntParam } from '$lib/server/api';
import { intakeFile } from '$lib/server/intake';
import { getNote, listNotebooks } from '$lib/server/notes';

/**
 * POST multipart/form-data with one or more `file` parts, optionally `notebookId`.
 * Each file becomes its own note, queued for text extraction and for titling by the model.
 */
export const POST: RequestHandler = async ({ request }) => {
	const form = await request.formData().catch(() => null);
	if (!form) error(400, 'expected multipart/form-data');
	const files = form.getAll('file').filter((f): f is File => f instanceof File);
	if (!files.length) error(400, 'no file provided');

	const notebooks = listNotebooks(getDb());
	const requested = parseIntParam(String(form.get('notebookId') ?? ''));
	const notebookId = notebooks.find((n) => n.id === requested)?.id ?? notebooks[0]?.id;
	if (!notebookId) error(400, 'no notebook available');

	// Validate everything first: a bad file halfway through must not leave notes behind.
	for (const file of files) {
		const problem = checkUpload({ name: file.name, type: file.type, size: file.size });
		if (problem) error(400, `${file.name}: ${problem}`);
	}

	const notes = [];
	for (const file of files) {
		const id = intakeFile(
			getDb(),
			{
				name: file.name,
				mime: file.type || 'application/octet-stream',
				data: new Uint8Array(await file.arrayBuffer())
			},
			{ notebookId }
		);
		notes.push(getNote(getDb(), id));
	}
	return json({ notes }, { status: 201 });
};
