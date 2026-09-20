/**
 * Turns an uploaded file into a note. Text files become the note body; everything else is
 * attached. Either way the note is queued for titling and tagging by the model, which is
 * enqueued last so it runs after any extraction (the queue is FIFO and single-worker).
 */
import type { Db } from './db.ts';
import { enqueueClassify } from './jobs.ts';
import { attachResource, insertNote } from './notes.ts';

export interface IntakeFile {
	name: string;
	mime: string;
	data: Uint8Array;
}

const TEXT_TYPES = /^text\/(plain|markdown|x-markdown|csv|tab-separated-values)$/i;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|log)$/i;

/** Text we can show directly. HTML is deliberately excluded: it is stored, not rendered. */
export const isTextLike = (mime: string, name: string): boolean =>
	TEXT_TYPES.test(mime) || (!mime.startsWith('text/') && TEXT_EXTENSIONS.test(name));

/** A readable stand-in title, used until the model suggests a better one. */
export const titleFromFileName = (name: string): string => {
	const stem = name.replace(/\.[^./\\]+$/, '').trim();
	const tidy = stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
	return tidy || 'Untitled';
};

const escapeXml = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Wraps plain text as ENML, one div per line, which the renderer then sanitises. */
const textToEnml = (text: string) =>
	`<en-note>${text
		.split(/\r?\n/)
		.map((line) => `<div>${escapeXml(line) || '<br/>'}</div>`)
		.join('')}</en-note>`;

export const intakeFile = (db: Db, file: IntakeFile, { notebookId }: { notebookId: number }) => {
	const title = titleFromFileName(file.name);
	const text = isTextLike(file.mime, file.name)
		? new TextDecoder('utf-8').decode(file.data)
		: undefined;

	const noteId = insertNote(db, {
		notebookId,
		title,
		enml: text === undefined ? '<en-note><div><br/></div></en-note>' : textToEnml(text)
	});
	if (text === undefined) {
		attachResource(db, noteId, { mime: file.mime, fileName: file.name, data: file.data });
	}
	enqueueClassify(db, noteId);
	return noteId;
};
