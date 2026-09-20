import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { createNotebook, insertNote, listNotes } from './notes.ts';

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'fn-db-')), 'test.db');

describe('openDb migrations', () => {
	it('upgrades a version-1 database and rebuilds the search index', () => {
		const path = tmpDb();
		let db = openDb(path);
		insertNote(db, {
			notebookId: createNotebook(db, 'x').id,
			title: 'apples',
			enml: '<en-note>b</en-note>'
		});
		// Downgrade to the v1 shape: no OCR columns, two-column FTS.
		db.exec(`
			DROP TRIGGER notes_ai; DROP TRIGGER notes_ad; DROP TRIGGER notes_au; DROP TABLE notes_fts;
			ALTER TABLE resources DROP COLUMN ocr_text; ALTER TABLE resources DROP COLUMN ocr_source; ALTER TABLE notes DROP COLUMN attachment_text;
			CREATE VIRTUAL TABLE notes_fts USING fts5(title, text, content='notes', content_rowid='id');
			PRAGMA user_version = 0;
		`);
		db.close();
		db = openDb(path);
		expect(listNotes(db, { query: 'apples' })).toHaveLength(1);
		expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
			6
		);
	});

	it('repairs a search index created with a mismatched column name', () => {
		const path = tmpDb();
		let db = openDb(path);
		insertNote(db, {
			notebookId: createNotebook(db, 'x').id,
			title: 'pears',
			enml: '<en-note>b</en-note>'
		});
		db.exec(`
			DROP TRIGGER notes_ai; DROP TRIGGER notes_ad; DROP TRIGGER notes_au; DROP TABLE notes_fts;
			CREATE VIRTUAL TABLE notes_fts USING fts5(title, text, attachments, content='notes', content_rowid='id');
			PRAGMA user_version = 2;
		`);
		db.close();
		db = openDb(path);
		expect(listNotes(db, { query: 'pears' })).toHaveLength(1);
	});

	it('adds ocr_source and marks existing text as vision (v3 -> v4)', () => {
		const path = tmpDb();
		let db = openDb(path);
		insertNote(db, {
			notebookId: createNotebook(db, 'x').id,
			title: 'n',
			enml: '<en-note/>',
			resources: [{ hash: 'h', mime: 'image/png', data: new Uint8Array([1]) }]
		});
		db.exec(
			`ALTER TABLE resources DROP COLUMN ocr_source; UPDATE resources SET ocr_text = 'old'; PRAGMA user_version = 3;`
		);
		db.close();
		db = openDb(path);
		expect(db.prepare('SELECT ocr_source FROM resources').get()).toEqual({ ocr_source: 'vision' });
	});

	it('upgrades a version-5 database whose jobs table predates note-scoped work', () => {
		const path = tmpDb();
		let db = openDb(path);
		insertNote(db, {
			notebookId: createNotebook(db, 'x').id,
			title: 'kiwi',
			enml: '<en-note>b</en-note>'
		});
		// The v5 shape: a jobs table without note_id, and no index referring to it.
		db.exec(`
			DROP INDEX IF EXISTS jobs_note;
			ALTER TABLE jobs DROP COLUMN note_id;
			PRAGMA user_version = 5;
		`);
		db.close();
		db = openDb(path);
		expect(listNotes(db, { query: 'kiwi' })).toHaveLength(1);
		expect(
			(db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name)
		).toContain('note_id');
	});

	it('is a no-op on an up-to-date database', () => {
		const path = tmpDb();
		let db = openDb(path);
		insertNote(db, {
			notebookId: createNotebook(db, 'x').id,
			title: 'plums',
			enml: '<en-note>b</en-note>'
		});
		db.close();
		db = openDb(path);
		expect(listNotes(db, { query: 'plums' })).toHaveLength(1);
	});
});
