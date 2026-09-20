import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import type { Db } from './db.ts';
import { parseEnex, type EnexNote } from './enex.ts';
import { createNotebook, insertNote } from './notes.ts';

export interface ImportResult {
	imported: number;
	skipped: number;
}
export type ImportProgress = (note: EnexNote, status: 'imported' | 'skipped') => void;

export const notebookNameFromPath = (path: string) => basename(path).replace(/\.enex$/i, '');

const titleOf = (note: EnexNote) => note.title || 'Untitled';

/** Dedupe key is (notebook, title, created); distinct notes created in the same second collide. */
const alreadyImported = (db: Db, notebookId: number, note: EnexNote) =>
	db
		.prepare('SELECT 1 FROM notes WHERE notebook_id = ? AND title = ? AND created IS ?')
		.get(notebookId, titleOf(note), note.created ?? null) !== undefined;

/** Imports all notes from an ENEX stream into the given notebook. Re-running is a no-op. */
export const importEnex = async (
	db: Db,
	input: AsyncIterable<string | Uint8Array>,
	notebookName: string,
	onProgress: ImportProgress = () => {}
): Promise<ImportResult> => {
	const notebook = createNotebook(db, notebookName);
	const result: ImportResult = { imported: 0, skipped: 0 };
	for await (const note of parseEnex(input)) {
		if (alreadyImported(db, notebook.id, note)) {
			result.skipped++;
			onProgress(note, 'skipped');
			continue;
		}
		insertNote(db, {
			notebookId: notebook.id,
			title: titleOf(note),
			enml: note.enml,
			created: note.created,
			updated: note.updated,
			tags: note.tags,
			attributes: note.attributes,
			resources: note.resources
		});
		result.imported++;
		onProgress(note, 'imported');
	}
	return result;
};

export const importEnexFile = (db: Db, path: string, onProgress?: ImportProgress) =>
	importEnex(db, createReadStream(path), notebookNameFromPath(path), onProgress);
