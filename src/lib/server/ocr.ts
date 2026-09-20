import type { Db } from './db.ts';

import type { TextSource } from './llm.ts';

export interface PendingResource {
	id: number;
	noteId: number;
	hash: string;
	mime: string;
	fileName: string | null;
	ocrSource: TextSource | null;
}

/**
 * Resources still to process: those without text, plus (when upgrading to an LLM) those whose
 * text came from Vision OCR.
 */
export const pendingResources = (db: Db, { upgradeVision = false } = {}): PendingResource[] =>
	db
		.prepare(
			`SELECT id, note_id AS noteId, hash, mime, file_name AS fileName, ocr_source AS ocrSource
			 FROM resources WHERE ocr_text IS NULL ${upgradeVision ? "OR ocr_source = 'vision'" : ''} ORDER BY id`
		)
		.all() as unknown as PendingResource[];

/** Stores extracted text for a resource and refreshes the owning note's searchable attachment text. */
export const setResourceText = (
	db: Db,
	resourceId: number,
	text: string,
	source: TextSource = 'vision'
) => {
	db.prepare('UPDATE resources SET ocr_text = ?, ocr_source = ? WHERE id = ?').run(
		text,
		source,
		resourceId
	);
	db.prepare(
		`UPDATE notes SET attachment_text = (
		   SELECT coalesce(group_concat(ocr_text, char(10)), '') FROM resources
		   WHERE note_id = notes.id AND ocr_text <> ''
		 ) WHERE id = (SELECT note_id FROM resources WHERE id = ?)`
	).run(resourceId);
};
