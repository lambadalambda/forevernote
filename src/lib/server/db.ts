import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notebooks (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  stack TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY,
  notebook_id INTEGER NOT NULL REFERENCES notebooks(id),
  title       TEXT NOT NULL DEFAULT '',
  html        TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL DEFAULT '',
  enml        TEXT,
  created     TEXT NOT NULL,
  updated     TEXT NOT NULL,
  attributes  TEXT NOT NULL DEFAULT '{}',
  trashed     INTEGER NOT NULL DEFAULT 0,
  attachment_text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS notes_notebook ON notes(notebook_id, trashed, updated);
CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS note_tags (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);
CREATE TABLE IF NOT EXISTS resources (
  id        INTEGER PRIMARY KEY,
  note_id   INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  hash      TEXT NOT NULL,
  mime      TEXT NOT NULL,
  file_name TEXT,
  width     INTEGER,
  height    INTEGER,
  data      BLOB NOT NULL,
  ocr_text  TEXT,
  ocr_source TEXT
);
CREATE INDEX IF NOT EXISTS resources_hash ON resources(hash);
CREATE INDEX IF NOT EXISTS resources_note ON resources(note_id);
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  resource_id INTEGER REFERENCES resources(id) ON DELETE CASCADE,
  note_id     INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created     TEXT NOT NULL,
  updated     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state, id);
CREATE INDEX IF NOT EXISTS jobs_resource ON jobs(resource_id, state);
`;

/**
 * Indexes over columns that migrations add. They must be created after migrate(), because
 * on an older database the column does not exist yet and CREATE INDEX would fail.
 */
const LATE_INDEXES = `
CREATE INDEX IF NOT EXISTS jobs_note ON jobs(note_id, state);
`;

/** FTS index over title, body text and attachment (OCR) text; kept in sync by triggers.
 *  Column names must equal the content table's columns (external-content FTS5). */
const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, text, attachment_text, content='notes', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, text, attachment_text)
  VALUES (new.id, new.title, new.text, new.attachment_text);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, text, attachment_text)
  VALUES ('delete', old.id, old.title, old.text, old.attachment_text);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF title, text, attachment_text ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, text, attachment_text)
  VALUES ('delete', old.id, old.title, old.text, old.attachment_text);
  INSERT INTO notes_fts(rowid, title, text, attachment_text)
  VALUES (new.id, new.title, new.text, new.attachment_text);
END;
`;

const SCHEMA_VERSION = 6;

const hasColumn = (db: Db, table: string, column: string) =>
	(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
		(c) => c.name === column
	);

const ftsDdl = (db: Db) =>
	(
		db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'notes_fts'`).get() as
			{ sql: string } | undefined
	)?.sql;

const dropFts = (db: Db) =>
	db.exec(`
		DROP TRIGGER IF EXISTS notes_ai; DROP TRIGGER IF EXISTS notes_ad; DROP TRIGGER IF EXISTS notes_au;
		DROP TABLE IF EXISTS notes_fts;
	`);

/**
 * Upgrades older databases. Returns true when the FTS index must be rebuilt from the notes table.
 * v2: attachment (OCR) text columns. v3: repairs an FTS index created with a mismatched column name.
 * v4: records how each attachment's text was obtained (layer / vision / llm).
 * v5: background job queue (created by SCHEMA on open, so this only bumps the version).
 * v6: jobs can target a note as well as an attachment.
 */
const migrate = (db: Db): boolean => {
	const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
		.user_version;
	if (version >= SCHEMA_VERSION) return false;
	let rebuild = false;
	if (!hasColumn(db, 'resources', 'ocr_text')) {
		db.exec(`
			ALTER TABLE resources ADD COLUMN ocr_text TEXT;
			ALTER TABLE notes ADD COLUMN attachment_text TEXT NOT NULL DEFAULT '';
		`);
		dropFts(db);
		rebuild = true;
	}
	const ddl = ftsDdl(db);
	if (ddl && !ddl.includes('attachment_text')) {
		dropFts(db);
		rebuild = true;
	}
	if (hasColumn(db, 'jobs', 'kind') && !hasColumn(db, 'jobs', 'note_id')) {
		db.exec('ALTER TABLE jobs ADD COLUMN note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE');
	}
	if (!hasColumn(db, 'resources', 'ocr_source')) {
		// Existing text may be a PDF layer or Vision OCR; mark it 'vision' so an LLM pass revisits it.
		db.exec(`
			ALTER TABLE resources ADD COLUMN ocr_source TEXT;
			UPDATE resources SET ocr_source = 'vision' WHERE ocr_text IS NOT NULL;
		`);
	}
	db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	return rebuild;
};

/** Opens (creating if needed) a database and applies the schema. */
export const openDb = (path: string): Db => {
	if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	// busy_timeout defaults to 0, so a second writer (the extractor CLI, say) would fail
	// immediately rather than waiting for the app to finish a statement.
	db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
	db.exec(SCHEMA);
	const rebuild = migrate(db);
	db.exec(LATE_INDEXES);
	db.exec(FTS);
	if (rebuild) db.exec(`INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')`);
	return db;
};

/** Runs fn inside a transaction, rolling back on throw. */
export const transaction = <T>(db: Db, fn: () => T): T => {
	db.exec('BEGIN');
	try {
		const result = fn();
		db.exec('COMMIT');
		return result;
	} catch (e) {
		// A failed statement may already have rolled back; do not let that hide the real error.
		try {
			db.exec('ROLLBACK');
		} catch {
			/* no transaction to roll back */
		}
		throw e;
	}
};
