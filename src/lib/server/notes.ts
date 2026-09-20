import { createHash } from 'node:crypto';
import { transaction, type Db } from './db.ts';
import { appendToNoteBody, renderNoteHtml, type ResourceLookup } from './enml.ts';
import { enqueueOcr } from './jobs.ts';
import { isExtractable } from './pages.ts';

export interface Notebook {
	id: number;
	name: string;
	stack: string | null;
	noteCount: number;
}
export interface Tag {
	id: number;
	name: string;
	noteCount: number;
}
export interface ResourceMeta {
	hash: string;
	mime: string;
	fileName: string | null;
	width: number | null;
	height: number | null;
	size: number;
	/** Text extracted from the attachment (PDF text layer or OCR); null until extracted. */
	ocrText: string | null;
	/** Where extraction stands: none means the type carries no text. */
	textState: 'ready' | 'pending' | 'failed' | 'none';
}
export interface NoteSummary {
	id: number;
	notebookId: number;
	title: string;
	snippet: string;
	created: string;
	updated: string;
}
export interface Note extends NoteSummary {
	html: string;
	tags: string[];
	attributes: Record<string, string>;
	resources: ResourceMeta[];
	trashed: boolean;
}
export interface NewResource {
	hash: string;
	mime: string;
	data: Uint8Array;
	fileName?: string;
	width?: number;
	height?: number;
}
export interface NewNote {
	notebookId: number;
	title: string;
	enml: string;
	created?: string;
	updated?: string;
	tags?: string[];
	attributes?: Record<string, string>;
	resources?: NewResource[];
}
export interface NoteListFilter {
	notebookId?: number;
	tagId?: number;
	query?: string;
	trashed?: boolean;
}
export interface NotePatch {
	title?: string;
	html?: string;
	tags?: string[];
	notebookId?: number;
}

export const resourceUrl = (hash: string) => `/api/resources/${hash}`;

const SNIPPET_LEN = 120;
const now = () => new Date().toISOString();

// ---------- notebooks ----------

export const listNotebooks = (db: Db): Notebook[] =>
	db
		.prepare(
			`SELECT nb.id, nb.name, nb.stack,
			        (SELECT count(*) FROM notes n WHERE n.notebook_id = nb.id AND n.trashed = 0) AS noteCount
			 FROM notebooks nb ORDER BY nb.name COLLATE NOCASE`
		)
		.all() as unknown as Notebook[];

export const createNotebook = (db: Db, name: string, stack: string | null = null): Notebook => {
	db.prepare('INSERT OR IGNORE INTO notebooks(name, stack) VALUES (?, ?)').run(name, stack);
	return db
		.prepare('SELECT id, name, stack, 0 AS noteCount FROM notebooks WHERE name = ?')
		.get(name) as unknown as Notebook;
};

// ---------- tags ----------

export const listTags = (db: Db): Tag[] =>
	db
		.prepare(
			`SELECT t.id, t.name, count(n.id) AS noteCount
			 FROM tags t
			 JOIN note_tags nt ON nt.tag_id = t.id
			 JOIN notes n ON n.id = nt.note_id AND n.trashed = 0
			 GROUP BY t.id ORDER BY t.name COLLATE NOCASE`
		)
		.all() as unknown as Tag[];

const pruneTags = (db: Db) =>
	db.exec('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM note_tags)');

const setNoteTags = (db: Db, noteId: number, tags: string[]) => {
	db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId);
	const insTag = db.prepare('INSERT OR IGNORE INTO tags(name) VALUES (?)');
	const link = db.prepare(
		'INSERT OR IGNORE INTO note_tags(note_id, tag_id) SELECT ?, id FROM tags WHERE name = ?'
	);
	for (const name of tags.map((t) => t.trim()).filter(Boolean)) {
		insTag.run(name);
		link.run(noteId, name);
	}
	pruneTags(db);
};

// ---------- resources ----------

export const getResource = (db: Db, hash: string) =>
	db
		.prepare('SELECT mime, file_name AS fileName, data FROM resources WHERE hash = ? LIMIT 1')
		.get(hash) as { mime: string; fileName: string | null; data: Uint8Array } | undefined;

const listResources = (db: Db, noteId: number): ResourceMeta[] =>
	db
		.prepare(
			`SELECT r.hash, r.mime, r.file_name AS fileName, r.width, r.height,
			        length(r.data) AS size, r.ocr_text AS ocrText,
			        CASE
			          WHEN r.ocr_text IS NOT NULL AND r.ocr_text <> '' THEN 'ready'
			          WHEN j.state IN ('pending', 'running') THEN 'pending'
			          WHEN j.state = 'failed' THEN 'failed'
			          ELSE 'none'
			        END AS textState
			 FROM resources r
			 LEFT JOIN (
			   SELECT resource_id, state FROM jobs
			   WHERE kind = 'ocr' AND id IN (SELECT max(id) FROM jobs WHERE kind = 'ocr' GROUP BY resource_id)
			 ) j ON j.resource_id = r.id
			 WHERE r.note_id = ? ORDER BY r.id`
		)
		.all(noteId) as unknown as ResourceMeta[];

const lookupFor =
	(resources: { hash: string; mime: string; fileName?: string | null }[]): ResourceLookup =>
	(hash) => {
		const r = resources.find((r) => r.hash === hash);
		return r && { url: resourceUrl(hash), mime: r.mime, fileName: r.fileName ?? undefined };
	};

// ---------- notes ----------

export const insertNote = (db: Db, note: NewNote): number =>
	transaction(db, () => {
		const resources = note.resources ?? [];
		const { html, text } = renderNoteHtml(note.enml, lookupFor(resources));
		const created = note.created ?? now();
		const { lastInsertRowid } = db
			.prepare(
				`INSERT INTO notes(notebook_id, title, html, text, enml, created, updated, attributes)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				note.notebookId,
				note.title,
				html,
				text,
				note.enml,
				created,
				note.updated ?? created,
				JSON.stringify(note.attributes ?? {})
			);
		const id = Number(lastInsertRowid);
		const insRes = db.prepare(
			`INSERT INTO resources(note_id, hash, mime, file_name, width, height, data)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		);
		for (const r of resources)
			insRes.run(id, r.hash, r.mime, r.fileName ?? null, r.width ?? null, r.height ?? null, r.data);
		setNoteTags(db, id, note.tags ?? []);
		return id;
	});

export const getNote = (db: Db, id: number): Note | undefined => {
	const row = db
		.prepare(
			`SELECT id, notebook_id AS notebookId, title, html, text, created, updated, attributes, trashed
			 FROM notes WHERE id = ?`
		)
		.get(id) as
		| {
				id: number;
				notebookId: number;
				title: string;
				html: string;
				text: string;
				created: string;
				updated: string;
				attributes: string;
				trashed: number;
		  }
		| undefined;
	if (!row) return undefined;
	const tags = (
		db
			.prepare(
				`SELECT t.name FROM tags t JOIN note_tags nt ON nt.tag_id = t.id
				 WHERE nt.note_id = ? ORDER BY t.name COLLATE NOCASE`
			)
			.all(id) as { name: string }[]
	).map((t) => t.name);
	return {
		id: row.id,
		notebookId: row.notebookId,
		title: row.title,
		html: row.html,
		snippet: row.text.slice(0, SNIPPET_LEN),
		created: row.created,
		updated: row.updated,
		attributes: JSON.parse(row.attributes),
		trashed: row.trashed === 1,
		tags,
		resources: listResources(db, id)
	};
};

/** Turns free text into a safe FTS5 query: every term becomes a quoted prefix match. */
const ftsQuery = (q: string) =>
	q
		.split(/\s+/)
		.map((t) => t.replace(/"/g, '').trim())
		.filter(Boolean)
		.map((t) => `"${t}"*`)
		.join(' ');

export const listNotes = (db: Db, f: NoteListFilter): NoteSummary[] => {
	const where: string[] = ['n.trashed = ?'];
	const params: (number | string)[] = [f.trashed ? 1 : 0];
	if (f.notebookId !== undefined) {
		where.push('n.notebook_id = ?');
		params.push(f.notebookId);
	}
	if (f.tagId !== undefined) {
		where.push('n.id IN (SELECT note_id FROM note_tags WHERE tag_id = ?)');
		params.push(f.tagId);
	}
	const fts = f.query ? ftsQuery(f.query) : '';
	// With a query, the snippet comes from whichever indexed column matched (body or attachment OCR text).
	const snippet = fts
		? `snippet(notes_fts, -1, '', '', '…', 16)`
		: `substr(n.text, 1, ${SNIPPET_LEN})`;
	const from = fts ? 'notes_fts JOIN notes n ON n.id = notes_fts.rowid' : 'notes n';
	// Search results are ranked by relevance (title matches weigh most); browsing is newest-first.
	const order = fts ? 'bm25(notes_fts, 8.0, 1.0, 1.0), n.updated DESC' : 'n.updated DESC';
	if (fts) {
		where.unshift('notes_fts MATCH ?');
		params.unshift(fts);
	}
	return db
		.prepare(
			`SELECT n.id, n.notebook_id AS notebookId, n.title, ${snippet} AS snippet, n.created, n.updated
			 FROM ${from} WHERE ${where.join(' AND ')} ORDER BY ${order}`
		)
		.all(...params) as unknown as NoteSummary[];
};

export const updateNote = (db: Db, id: number, patch: NotePatch) =>
	transaction(db, () => {
		const sets: string[] = ['updated = ?'];
		const params: (string | number)[] = [now()];
		if (patch.title !== undefined) {
			sets.push('title = ?');
			params.push(patch.title);
		}
		if (patch.html !== undefined) {
			const { html, text } = renderNoteHtml(patch.html, lookupFor(listResources(db, id)));
			sets.push('html = ?', 'text = ?');
			params.push(html, text);
		}
		if (patch.notebookId !== undefined) {
			sets.push('notebook_id = ?');
			params.push(patch.notebookId);
		}
		db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
		if (patch.tags) setNoteTags(db, id, patch.tags);
	});

/**
 * Adds an uploaded file to a note: stores the bytes, appends the matching element to the
 * note body and queues text extraction. The body is re-rendered through the sanitiser so
 * uploads go through exactly the same gate as imported and edited content.
 */
export const attachResource = (
	db: Db,
	noteId: number,
	file: { mime: string; data: Uint8Array; fileName?: string; width?: number; height?: number }
): ResourceMeta =>
	transaction(db, () => {
		const hash = createHash('md5').update(file.data).digest('hex');
		const duplicate = db
			.prepare('SELECT 1 FROM resources WHERE note_id = ? AND hash = ?')
			.get(noteId, hash);
		if (duplicate) throw new Error('this file is already attached to the note');

		const { lastInsertRowid } = db
			.prepare(
				`INSERT INTO resources(note_id, hash, mime, file_name, width, height, data)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				noteId,
				hash,
				file.mime,
				file.fileName ?? null,
				file.width ?? null,
				file.height ?? null,
				file.data
			);
		const resourceId = Number(lastInsertRowid);

		const row = db.prepare('SELECT html FROM notes WHERE id = ?').get(noteId) as
			{ html: string } | undefined;
		if (!row) throw new Error('note not found');
		// en-media is the ENML element the renderer turns into an img or an attachment link.
		const media = `<en-media hash="${hash}" type="${file.mime}"/>`;
		const { html, text } = renderNoteHtml(
			appendToNoteBody(row.html, media),
			lookupFor(listResources(db, noteId))
		);
		db.prepare('UPDATE notes SET html = ?, text = ?, updated = ? WHERE id = ?').run(
			html,
			text,
			now(),
			noteId
		);

		// Audio and the like have no text to find, so there is nothing to extract.
		if (isExtractable(file.mime)) enqueueOcr(db, resourceId);

		return listResources(db, noteId).find((r) => r.hash === hash)!;
	});

export const setTrashed = (db: Db, id: number, trashed: boolean) =>
	db.prepare('UPDATE notes SET trashed = ? WHERE id = ?').run(trashed ? 1 : 0, id);

export const deleteNoteForever = (db: Db, id: number) =>
	transaction(db, () => {
		db.prepare('DELETE FROM notes WHERE id = ?').run(id);
		pruneTags(db);
	});
