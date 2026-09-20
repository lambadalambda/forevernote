import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db.ts';
import { pendingResources, setResourceText } from './ocr.ts';
import { claimNextJob, completeJob, failJob, jobStats, MAX_ATTEMPTS } from './jobs.ts';
import {
	attachResource,
	createNotebook,
	deleteNoteForever,
	getNote,
	getResource,
	insertNote,
	listNotebooks,
	listNotes,
	listTags,
	setTrashed,
	updateNote
} from './notes.ts';

let db: Db;
beforeEach(() => {
	db = openDb(':memory:');
});

const png = { hash: 'abc', mime: 'image/png', fileName: 'a.png', data: new Uint8Array([1, 2, 3]) };

const seed = (over: Partial<Parameters<typeof insertNote>[1]> = {}) =>
	insertNote(db, {
		notebookId: createNotebook(db, 'Inbox').id,
		title: 'Hello',
		enml: '<en-note><div>Body words</div><en-media hash="abc" type="image/png"/></en-note>',
		created: '2020-01-01T00:00:00.000Z',
		updated: '2020-01-02T00:00:00.000Z',
		tags: ['work'],
		attributes: { author: 'me' },
		resources: [png],
		...over
	});

describe('notebooks and tags', () => {
	it('creates notebooks idempotently and counts notes', () => {
		const a = createNotebook(db, 'Inbox');
		expect(createNotebook(db, 'Inbox').id).toBe(a.id);
		seed({ notebookId: a.id });
		expect(listNotebooks(db)).toEqual([{ id: a.id, name: 'Inbox', stack: null, noteCount: 1 }]);
	});

	it('lists tags with counts, case-insensitively deduped', () => {
		seed({ tags: ['Work'] });
		seed({ tags: ['work', 'home'] });
		expect(listTags(db)).toEqual([
			{ id: expect.any(Number), name: 'home', noteCount: 1 },
			{ id: expect.any(Number), name: 'Work', noteCount: 2 }
		]);
	});
});

describe('attachResource', () => {
	it('stores the file, shows it in the note and reports it as an attachment', () => {
		const id = seed({ resources: [] });
		const meta = attachResource(db, id, {
			mime: 'application/pdf',
			fileName: 'Rechnung.pdf',
			data: new Uint8Array([1, 2, 3, 4])
		});
		expect(meta).toMatchObject({ mime: 'application/pdf', fileName: 'Rechnung.pdf', size: 4 });
		const note = getNote(db, id)!;
		expect(note.resources.map((r) => r.fileName)).toEqual(['Rechnung.pdf']);
		expect(note.html).toContain(`href="/api/resources/${meta.hash}"`);
		expect(note.html).toContain('Rechnung.pdf</a>');
		expect(note.html.startsWith('<div class="en-note">')).toBe(true);
	});

	it('embeds an image inline rather than as a link', () => {
		const id = seed({ resources: [] });
		const meta = attachResource(db, id, {
			mime: 'image/png',
			fileName: 'scan.png',
			data: new Uint8Array([9])
		});
		expect(getNote(db, id)!.html).toContain(`<img src="/api/resources/${meta.hash}"`);
	});

	it('keeps existing body content and earlier attachments', () => {
		const id = seed();
		attachResource(db, id, { mime: 'image/png', fileName: 'new.png', data: new Uint8Array([7]) });
		const note = getNote(db, id)!;
		expect(note.html).toContain('Body words');
		expect(note.resources.map((r) => r.fileName)).toEqual(['a.png', 'new.png']);
		expect(note.html).toContain('/api/resources/abc');
	});

	it('reports extraction state per attachment so the UI can show progress', () => {
		const id = seed({ resources: [] });
		attachResource(db, id, { mime: 'image/png', fileName: 'a.png', data: new Uint8Array([1]) });
		attachResource(db, id, { mime: 'audio/mpeg', fileName: 'm.mp3', data: new Uint8Array([2]) });
		const states = () =>
			Object.fromEntries(getNote(db, id)!.resources.map((r) => [r.fileName, r.textState]));
		expect(states()).toEqual({ 'a.png': 'pending', 'm.mp3': 'none' });

		const job = claimNextJob(db)!;
		expect(states()['a.png']).toBe('pending');
		setResourceText(db, job.resourceId!, 'hello world text', 'llm');
		completeJob(db, job.id);
		expect(states()['a.png']).toBe('ready');
	});

	it('marks an attachment failed once the queue gives up on it', () => {
		const id = seed({ resources: [] });
		attachResource(db, id, { mime: 'image/png', fileName: 'a.png', data: new Uint8Array([1]) });
		for (let i = 0; i < MAX_ATTEMPTS; i++) failJob(db, claimNextJob(db)!.id, 'nope');
		expect(getNote(db, id)!.resources[0].textState).toBe('failed');
	});

	it('does not nest the body deeper with each attachment', () => {
		const id = seed({ resources: [] });
		for (let i = 0; i < 3; i++)
			attachResource(db, id, { mime: 'image/png', data: new Uint8Array([i + 1]) });
		const note = getNote(db, id)!;
		expect(note.html.match(/class="en-note"/g)).toHaveLength(1);
		expect(note.html).toContain('Body words');
		expect(note.resources).toHaveLength(3);
	});

	it('queues text extraction for the new file', () => {
		const id = seed({ resources: [] });
		attachResource(db, id, { mime: 'image/png', data: new Uint8Array([1]) });
		expect(jobStats(db).pending).toBe(1);
	});

	it('does not queue extraction for types that carry no text', () => {
		const id = seed({ resources: [] });
		attachResource(db, id, { mime: 'audio/mpeg', fileName: 'memo.mp3', data: new Uint8Array([1]) });
		expect(jobStats(db).pending).toBe(0);
		expect(getNote(db, id)!.resources).toHaveLength(1);
	});

	it('refuses to attach the same bytes to a note twice', () => {
		const id = seed({ resources: [] });
		const file = { mime: 'image/png', fileName: 'x.png', data: new Uint8Array([5, 5]) };
		const first = attachResource(db, id, file);
		expect(() => attachResource(db, id, file)).toThrow(/already/i);
		expect(getNote(db, id)!.resources).toHaveLength(1);
		expect(first.hash).toBeTruthy();
	});

	it('bumps the note timestamp so the list reorders', () => {
		const id = seed({ resources: [], updated: '2020-01-01T00:00:00.000Z' });
		attachResource(db, id, { mime: 'image/png', data: new Uint8Array([3]) });
		expect(getNote(db, id)!.updated > '2020-01-01T00:00:00.000Z').toBe(true);
	});
});

describe('notes', () => {
	it('inserts and reads back a note with rendered html, tags and resource metadata', () => {
		const id = seed();
		const note = getNote(db, id)!;
		expect(note.title).toBe('Hello');
		expect(note.html).toBe(
			'<div class="en-note"><div>Body words</div><img src="/api/resources/abc" data-hash="abc"></div>'
		);
		expect(note.tags).toEqual(['work']);
		expect(note.attributes).toEqual({ author: 'me' });
		expect(note.resources).toEqual([
			{
				hash: 'abc',
				mime: 'image/png',
				fileName: 'a.png',
				width: null,
				height: null,
				size: 3,
				ocrText: null,
				textState: 'none'
			}
		]);
		expect(note.trashed).toBe(false);
	});

	it('exposes extracted attachment text on the note', () => {
		const id = seed();
		setResourceText(db, pendingResources(db)[0].id, 'Zustimmungserklärung');
		expect(getNote(db, id)!.resources[0].ocrText).toBe('Zustimmungserklärung');
	});

	it('serves resource bytes by hash', () => {
		seed();
		const r = getResource(db, 'abc')!;
		expect(r.mime).toBe('image/png');
		expect(Array.from(r.data)).toEqual([1, 2, 3]);
		expect(getResource(db, 'nope')).toBeUndefined();
	});

	it('lists notes newest-first with snippets, filtered by notebook and tag', () => {
		const nb = createNotebook(db, 'Other');
		const a = seed({ title: 'A', updated: '2021-01-01T00:00:00.000Z' });
		const b = seed({
			title: 'B',
			notebookId: nb.id,
			tags: ['x'],
			updated: '2022-01-01T00:00:00.000Z'
		});
		expect(listNotes(db, {}).map((n) => n.id)).toEqual([b, a]);
		expect(listNotes(db, { notebookId: nb.id }).map((n) => n.id)).toEqual([b]);
		const tagId = listTags(db).find((t) => t.name === 'x')!.id;
		expect(listNotes(db, { tagId }).map((n) => n.id)).toEqual([b]);
		expect(listNotes(db, {})[0]).toMatchObject({
			id: b,
			title: 'B',
			snippet: 'Body words',
			notebookId: nb.id
		});
	});

	it('full-text searches title and body with prefix matching', () => {
		seed({ title: 'Grocery list', enml: '<en-note>bananas and apples</en-note>' });
		seed({ title: 'Other', enml: '<en-note>nothing here</en-note>' });
		expect(listNotes(db, { query: 'banan' }).map((n) => n.title)).toEqual(['Grocery list']);
		expect(listNotes(db, { query: 'grocery apples' }).map((n) => n.title)).toEqual([
			'Grocery list'
		]);
		expect(listNotes(db, { query: '"unbalanced' })).toEqual([]);
		expect(listNotes(db, { query: 'apples' })[0].snippet).toContain('apples');
	});

	it('ranks search results by relevance, title matches first, instead of by date', () => {
		seed({
			title: 'Other',
			enml: '<en-note>mentions zustimmung once</en-note>',
			updated: '2024-01-01T00:00:00.000Z'
		});
		seed({
			title: 'Zustimmung Steuer',
			enml: '<en-note>x</en-note>',
			updated: '2020-01-01T00:00:00.000Z'
		});
		expect(listNotes(db, { query: 'zustimmung' }).map((n) => n.title)).toEqual([
			'Zustimmung Steuer',
			'Other'
		]);
	});

	it('updates title, content, tags and notebook, re-sanitising the html', () => {
		const id = seed();
		const nb = createNotebook(db, 'Moved');
		updateNote(db, id, {
			title: 'New',
			html: '<p onclick="x()">edited <img src="/api/resources/abc"></p>',
			tags: ['fresh'],
			notebookId: nb.id
		});
		const note = getNote(db, id)!;
		expect(note.title).toBe('New');
		expect(note.html).toBe(
			'<div class="en-note"><p>edited <img src="/api/resources/abc"></p></div>'
		);
		expect(note.tags).toEqual(['fresh']);
		expect(note.notebookId).toBe(nb.id);
		expect(note.updated > '2020-01-02T00:00:00.000Z').toBe(true);
		expect(listNotes(db, { query: 'edited' }).map((n) => n.id)).toEqual([id]);
		expect(listNotes(db, { query: 'Body' })).toEqual([]);
		expect(listTags(db).map((t) => t.name)).toEqual(['fresh']);
	});

	it('excludes trashed notes from tag counts', () => {
		const id = seed({ tags: ['gone'] });
		setTrashed(db, id, true);
		expect(listTags(db)).toEqual([]);
	});

	it('combines full-text search with a notebook filter', () => {
		const nb = createNotebook(db, 'Other');
		seed({ title: 'apples', notebookId: nb.id });
		seed({ title: 'apples too' });
		expect(listNotes(db, { query: 'apples', notebookId: nb.id }).map((n) => n.title)).toEqual([
			'apples'
		]);
	});

	it('trashes, restores and permanently deletes notes', () => {
		const id = seed();
		setTrashed(db, id, true);
		expect(listNotes(db, {})).toEqual([]);
		expect(listNotes(db, { trashed: true }).map((n) => n.id)).toEqual([id]);
		setTrashed(db, id, false);
		expect(listNotes(db, {}).map((n) => n.id)).toEqual([id]);
		deleteNoteForever(db, id);
		expect(getNote(db, id)).toBeUndefined();
		expect(getResource(db, 'abc')).toBeUndefined();
	});
});
