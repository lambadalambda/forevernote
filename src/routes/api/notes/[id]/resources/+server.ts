import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/instance';
import { checkUpload, parseIntParam } from '$lib/server/api';
import { attachResource, getNote } from '$lib/server/notes';

/** POST multipart/form-data with one or more `file` parts -> the stored attachments. */
export const POST: RequestHandler = async ({ params, request }) => {
	const id = parseIntParam(params.id);
	if (!id || !getNote(getDb(), id)) error(404, 'note not found');

	const form = await request.formData().catch(() => null);
	if (!form) error(400, 'expected multipart/form-data');
	const files = form.getAll('file').filter((f): f is File => f instanceof File);
	if (!files.length) error(400, 'no file provided');

	for (const file of files) {
		const problem = checkUpload({ name: file.name, type: file.type, size: file.size });
		if (problem) error(400, `${file.name}: ${problem}`);
	}

	const stored = [];
	for (const file of files) {
		try {
			stored.push(
				attachResource(getDb(), id, {
					mime: file.type || 'application/octet-stream',
					fileName: file.name || undefined,
					data: new Uint8Array(await file.arrayBuffer())
				})
			);
		} catch (e) {
			error(409, (e as Error).message);
		}
	}
	return json({ resources: stored, note: getNote(getDb(), id) }, { status: 201 });
};
