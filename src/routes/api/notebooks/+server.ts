import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/instance';
import { createNotebook } from '$lib/server/notes';

/** POST { name } -> notebook */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { name?: unknown };
	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (!name) error(400, 'name required');
	return json(createNotebook(getDb(), name), { status: 201 });
};
