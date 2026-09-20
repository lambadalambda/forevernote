import type { Note, Notebook } from '$lib/server/notes';
import type { NoteApiPatch } from '$lib/server/api';

const send = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
	const res = await fetch(url, {
		method,
		headers: body ? { 'content-type': 'application/json' } : {},
		body: body ? JSON.stringify(body) : undefined
	});
	if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
	return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
};

export const createNote = (notebookId?: number) =>
	send<{ id: number }>('POST', '/api/notes', { notebookId });
export const patchNote = (id: number, patch: NoteApiPatch) =>
	send<Note>('PATCH', `/api/notes/${id}`, patch);
export const deleteNoteForever = (id: number) => send<void>('DELETE', `/api/notes/${id}?forever=1`);
export const createNotebook = (name: string) => send<Notebook>('POST', '/api/notebooks', { name });

/** Uploads attachments to a note and returns the note as it now stands. */
export const uploadResources = async (noteId: number, files: File[]): Promise<Note> => {
	const form = new FormData();
	for (const file of files) form.append('file', file);
	const res = await fetch(`/api/notes/${noteId}/resources`, { method: 'POST', body: form });
	if (!res.ok) throw new Error((await res.text()) || `upload failed (${res.status})`);
	return ((await res.json()) as { note: Note }).note;
};

export const fetchNote = (id: number) => send<Note>('GET', `/api/notes/${id}`);

/** Creates one note per uploaded file, each queued for extraction and auto-titling. */
export const intakeFiles = async (files: File[], notebookId?: number): Promise<Note[]> => {
	const form = new FormData();
	for (const file of files) form.append('file', file);
	if (notebookId) form.append('notebookId', String(notebookId));
	const res = await fetch('/api/intake', { method: 'POST', body: form });
	if (!res.ok) throw new Error((await res.text()) || `upload failed (${res.status})`);
	return ((await res.json()) as { notes: Note[] }).notes;
};
