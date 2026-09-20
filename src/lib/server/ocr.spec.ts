import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db.ts';
import { createNotebook, insertNote, listNotes } from './notes.ts';
import { pendingResources, setResourceText } from './ocr.ts';

let db: Db;
beforeEach(() => {
	db = openDb(':memory:');
});

const seed = (resources: { hash: string; mime: string; fileName?: string }[]) =>
	insertNote(db, {
		notebookId: createNotebook(db, 'Inbox').id,
		title: 'Scan',
		enml: '<en-note/>',
		resources: resources.map((r) => ({ ...r, data: new Uint8Array([1]) }))
	});

describe('pending / setResourceText', () => {
	it('lists resources without text, then makes stored text searchable with a snippet', () => {
		const id = seed([
			{ hash: 'a', mime: 'image/png', fileName: 'scan.png' },
			{ hash: 'b', mime: 'application/pdf' }
		]);
		expect(pendingResources(db).map((r) => r.hash)).toEqual(['a', 'b']);
		setResourceText(
			db,
			pendingResources(db)[0].id,
			'Hansen & Partner\nEinwilligungserklärung 2020'
		);
		expect(pendingResources(db).map((r) => r.hash)).toEqual(['b']);
		const hits = listNotes(db, { query: 'einwilligung' });
		expect(hits.map((n) => n.id)).toEqual([id]);
		expect(hits[0].snippet).toContain('Einwilligungserklärung');
	});

	it('can revisit vision-sourced text when upgrading, but leaves layer and llm text alone', () => {
		seed([
			{ hash: 'a', mime: 'image/png' },
			{ hash: 'b', mime: 'application/pdf' },
			{ hash: 'c', mime: 'image/png' }
		]);
		const [a, b, c] = pendingResources(db);
		setResourceText(db, a.id, 'x', 'vision');
		setResourceText(db, b.id, 'y', 'layer');
		setResourceText(db, c.id, 'z', 'llm');
		expect(pendingResources(db)).toEqual([]);
		expect(pendingResources(db, { upgradeVision: true }).map((r) => r.hash)).toEqual(['a']);
	});

	it('concatenates text of all resources of a note', () => {
		seed([
			{ hash: 'a', mime: 'image/png' },
			{ hash: 'b', mime: 'image/png' }
		]);
		const [a, b] = pendingResources(db);
		setResourceText(db, a.id, 'alpha');
		setResourceText(db, b.id, 'beta');
		expect(listNotes(db, { query: 'alpha' })).toHaveLength(1);
		expect(listNotes(db, { query: 'beta' })).toHaveLength(1);
	});
});
