import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from './db.ts';
import {
	attachResource,
	createNotebook,
	deleteNoteForever,
	getNote,
	insertNote,
	listNotes,
	updateNote
} from './notes.ts';
import { claimNextJob, enqueueClassify, jobStats, MAX_ATTEMPTS } from './jobs.ts';
import { runOneJob, startWorker, stopWorker } from './worker.ts';

let db: Db;
let noteId: number;

beforeEach(() => {
	db = openDb(':memory:');
	noteId = insertNote(db, {
		notebookId: createNotebook(db, 'Inbox').id,
		title: 'Scan',
		enml: '<en-note/>'
	});
});

const deps = (over = {}) => ({
	extractPages: vi.fn(async () => [
		{ text: 'layer page', image: null },
		{ text: '', image: '/tmp/p2.jpg' }
	]),
	transcribe: vi.fn(async () => 'model page'),
	chat: vi.fn(
		async () => '{"title":"Rechnung Hansen & Partner","tags":["Steuer"],"notebook":"Inbox"}'
	),
	...over
});

describe('runOneJob', () => {
	it('does nothing when the queue is empty', async () => {
		expect(await runOneJob(db, deps())).toBe(false);
	});

	it('extracts a queued attachment and makes its text searchable', async () => {
		attachResource(db, noteId, {
			mime: 'application/pdf',
			fileName: 'a.pdf',
			data: new Uint8Array([1])
		});
		expect(await runOneJob(db, deps())).toBe(true);

		const resource = getNote(db, noteId)!.resources[0];
		expect(resource.ocrText).toBe('layer page\nmodel page');
		expect(resource.textState).toBe('ready');
		expect(jobStats(db)).toMatchObject({ pending: 0, done: 1 });
		expect(listNotes(db, { query: 'model' }).map((n) => n.id)).toEqual([noteId]);
	});

	it('stores empty text and completes when a file yields nothing', async () => {
		attachResource(db, noteId, { mime: 'application/pdf', data: new Uint8Array([1]) });
		await runOneJob(db, deps({ extractPages: vi.fn(async () => []) }));
		expect(getNote(db, noteId)!.resources[0].ocrText).toBe('');
		expect(jobStats(db)).toMatchObject({ done: 1, failed: 0 });
	});

	it('retries a job whose extraction threw, leaving the text unset', async () => {
		attachResource(db, noteId, { mime: 'application/pdf', data: new Uint8Array([1]) });
		const failing = deps({
			extractPages: vi.fn(async () => {
				throw new Error('pdftoppm exploded');
			})
		});
		expect(await runOneJob(db, failing)).toBe(true);
		expect(getNote(db, noteId)!.resources[0].ocrText).toBeNull();
		expect(jobStats(db)).toMatchObject({ pending: 1, failed: 0 });
		expect((db.prepare('SELECT error FROM jobs').get() as { error: string }).error).toMatch(
			/exploded/
		);
	});

	it('gives up after the attempt limit and marks the attachment failed', async () => {
		attachResource(db, noteId, { mime: 'application/pdf', data: new Uint8Array([1]) });
		const failing = deps({
			extractPages: vi.fn(async () => {
				throw new Error('nope');
			})
		});
		for (let i = 0; i < MAX_ATTEMPTS; i++) await runOneJob(db, failing);
		expect(jobStats(db)).toMatchObject({ failed: 1, pending: 0 });
		expect(getNote(db, noteId)!.resources[0].textState).toBe('failed');
	});

	it('passes the attachment bytes and type through to the extractor', async () => {
		attachResource(db, noteId, {
			mime: 'image/png',
			fileName: 'x.png',
			data: new Uint8Array([7, 7])
		});
		const d = deps();
		await runOneJob(db, d);
		const [, mime] = d.extractPages.mock.calls[0] as unknown as [string, string];
		expect(mime).toBe('image/png');
	});

	it('completes a job whose resource has since been deleted', async () => {
		attachResource(db, noteId, { mime: 'image/png', data: new Uint8Array([1]) });
		db.exec('DELETE FROM resources');
		// The row is gone, so the job cannot be claimed any more; nothing should throw.
		expect(claimNextJob(db)).toBeUndefined();
		expect(await runOneJob(db, deps())).toBe(false);
	});
});

describe('startWorker / stopWorker', () => {
	it('drains the queue on its own', async () => {
		attachResource(db, noteId, { mime: 'image/png', data: new Uint8Array([1]) });
		startWorker(db, deps());
		for (let i = 0; i < 60 && jobStats(db).done === 0; i++)
			await new Promise((r) => setTimeout(r, 25));
		expect(jobStats(db)).toMatchObject({ done: 1, pending: 0 });
		stopWorker();
	});

	it('stops picking up work once stopped', async () => {
		startWorker(db, deps());
		stopWorker();
		attachResource(db, noteId, { mime: 'image/png', data: new Uint8Array([2]) });
		await new Promise((r) => setTimeout(r, 200));
		expect(jobStats(db)).toMatchObject({ pending: 1, done: 0 });
	});
});

describe('runOneJob: classification', () => {
	const seedForClassify = () => {
		attachResource(db, noteId, { mime: 'application/pdf', data: new Uint8Array([1]) });
		enqueueClassify(db, noteId);
	};

	it('titles and tags a note from the text that was extracted', async () => {
		seedForClassify();
		const d = deps();
		await runOneJob(db, d); // extraction
		await runOneJob(db, d); // classification
		const note = getNote(db, noteId)!;
		expect(note.title).toBe('Rechnung Hansen & Partner');
		expect(note.tags).toEqual(['Steuer']);
		expect(jobStats(db)).toMatchObject({ done: 2, failed: 0 });
	});

	it('shows the model the extracted text, not just the file name', async () => {
		seedForClassify();
		const d = deps();
		await runOneJob(db, d);
		await runOneJob(db, d);
		expect(d.chat).toHaveBeenCalledWith(expect.stringContaining('layer page'));
	});

	it('leaves a note alone when the model returns nothing usable', async () => {
		seedForClassify();
		const d = deps({ chat: vi.fn(async () => 'I cannot tell what this is') });
		await runOneJob(db, d);
		await runOneJob(db, d);
		const note = getNote(db, noteId)!;
		expect(note.title).toBe('Scan');
		expect(note.tags).toEqual([]);
		expect(jobStats(db)).toMatchObject({ done: 2, failed: 0 });
	});

	it('retries when the model is unreachable rather than losing the note', async () => {
		seedForClassify();
		const d = deps({
			chat: vi.fn(async () => {
				throw new Error('ECONNREFUSED');
			})
		});
		await runOneJob(db, d);
		await runOneJob(db, d);
		expect(jobStats(db)).toMatchObject({ pending: 1 });
		expect(getNote(db, noteId)!.title).toBe('Scan');
	});

	it('does not overwrite a title the user changed while the job was queued', async () => {
		seedForClassify();
		const d = deps({
			chat: async () => {
				// Stand in for the user renaming the note while the model is thinking.
				updateNote(db, noteId, { title: 'Renamed by hand' });
				return '{"title":"Rechnung Hansen & Partner","tags":["Steuer"]}';
			}
		});
		await runOneJob(db, d); // extraction
		await runOneJob(db, d); // classification
		const note = getNote(db, noteId)!;
		expect(note.title).toBe('Renamed by hand');
		expect(note.tags).toEqual([]);
		expect(jobStats(db)).toMatchObject({ done: 2, failed: 0 });
	});

	it('completes a classification whose note has since been deleted', async () => {
		enqueueClassify(db, noteId);
		deleteNoteForever(db, noteId);
		expect(await runOneJob(db, deps())).toBe(false);
	});
});
