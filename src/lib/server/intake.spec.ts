import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db.ts';
import { createNotebook, getNote, listNotes } from './notes.ts';
import { claimNextJob, jobStats } from './jobs.ts';
import { intakeFile, isTextLike, titleFromFileName } from './intake.ts';

let db: Db;
let notebookId: number;
beforeEach(() => {
	db = openDb(':memory:');
	notebookId = createNotebook(db, 'Inbox').id;
});

const bytes = (s: string) => new TextEncoder().encode(s);

describe('isTextLike', () => {
	it('recognises plain text by type', () => {
		expect(isTextLike('text/plain', 'a.txt')).toBe(true);
		expect(isTextLike('text/markdown', 'a.md')).toBe(true);
		expect(isTextLike('text/csv', 'a.csv')).toBe(true);
	});
	it('falls back to the extension when the browser sends a vague type', () => {
		expect(isTextLike('application/octet-stream', 'notes.md')).toBe(true);
		expect(isTextLike('', 'notes.txt')).toBe(true);
	});
	it('does not treat documents or images as text', () => {
		expect(isTextLike('application/pdf', 'a.pdf')).toBe(false);
		expect(isTextLike('image/png', 'a.png')).toBe(false);
		expect(isTextLike('text/html', 'a.html')).toBe(false);
	});
});

describe('titleFromFileName', () => {
	it('drops the extension and tidies separators', () => {
		expect(titleFromFileName('Rechnung_Stadtwerke-2021.pdf')).toBe('Rechnung Stadtwerke 2021');
		expect(titleFromFileName('scan 001.PNG')).toBe('scan 001');
	});
	it('falls back for a missing or extensionless name', () => {
		expect(titleFromFileName('')).toBe('Untitled');
		expect(titleFromFileName('README')).toBe('README');
	});
});

describe('intakeFile', () => {
	it('puts a text file into the note body rather than attaching it', () => {
		const id = intakeFile(
			db,
			{
				name: 'meeting.txt',
				mime: 'text/plain',
				data: bytes('Line one\nLine two & three')
			},
			{ notebookId }
		);
		const note = getNote(db, id)!;
		expect(note.resources).toHaveLength(0);
		expect(note.html).toContain('Line one');
		expect(note.html).toContain('Line two &amp; three');
		expect(note.title).toBe('meeting');
	});

	it('attaches a pdf and queues its extraction', () => {
		const id = intakeFile(
			db,
			{
				name: 'Rechnung.pdf',
				mime: 'application/pdf',
				data: new Uint8Array([1, 2, 3])
			},
			{ notebookId }
		);
		const note = getNote(db, id)!;
		expect(note.resources.map((r) => r.fileName)).toEqual(['Rechnung.pdf']);
		expect(note.resources[0].textState).toBe('pending');
	});

	it('queues classification after extraction, so the title reflects the contents', () => {
		intakeFile(
			db,
			{ name: 'a.pdf', mime: 'application/pdf', data: new Uint8Array([1]) },
			{ notebookId }
		);
		expect(jobStats(db).pending).toBe(2);
		expect(claimNextJob(db)!.kind).toBe('ocr');
		expect(claimNextJob(db)!.kind).toBe('classify');
	});

	it('queues classification for a text file even though nothing needs extracting', () => {
		intakeFile(
			db,
			{ name: 'a.txt', mime: 'text/plain', data: bytes('some words here') },
			{ notebookId }
		);
		expect(jobStats(db).pending).toBe(1);
		expect(claimNextJob(db)!.kind).toBe('classify');
	});

	it('still stores a file it cannot read text from', () => {
		const id = intakeFile(
			db,
			{ name: 'memo.mp3', mime: 'audio/mpeg', data: new Uint8Array([1]) },
			{ notebookId }
		);
		expect(getNote(db, id)!.resources).toHaveLength(1);
		expect(jobStats(db).pending).toBe(1); // classification only
	});

	it('files into the given notebook and shows up in listings', () => {
		const other = createNotebook(db, 'Other').id;
		const id = intakeFile(
			db,
			{ name: 'a.pdf', mime: 'application/pdf', data: new Uint8Array([1]) },
			{ notebookId: other }
		);
		expect(getNote(db, id)!.notebookId).toBe(other);
		expect(listNotes(db, { notebookId: other }).map((n) => n.id)).toEqual([id]);
	});

	it('decodes utf-8 so umlauts survive', () => {
		const id = intakeFile(
			db,
			{ name: 'de.txt', mime: 'text/plain', data: bytes('Grüße aus Berlin') },
			{ notebookId }
		);
		expect(getNote(db, id)!.html).toContain('Grüße');
	});
});
