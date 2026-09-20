import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db.ts';
import { createNotebook, insertNote } from './notes.ts';
import {
	claimNextJob,
	completeJob,
	enqueueClassify,
	enqueueOcr,
	failJob,
	jobStats,
	MAX_ATTEMPTS,
	requeueStuckJobs
} from './jobs.ts';

let db: Db;
let resourceId: number;

beforeEach(() => {
	db = openDb(':memory:');
	insertNote(db, {
		notebookId: createNotebook(db, 'Inbox').id,
		title: 'n',
		enml: '<en-note/>',
		resources: [{ hash: 'a', mime: 'image/png', data: new Uint8Array([1]) }]
	});
	resourceId = (db.prepare('SELECT id FROM resources').get() as { id: number }).id;
});

describe('enqueue and claim', () => {
	it('queues a resource and hands it out exactly once', () => {
		enqueueOcr(db, resourceId);
		expect(jobStats(db).pending).toBe(1);
		const job = claimNextJob(db)!;
		expect(job).toMatchObject({ resourceId, attempts: 1 });
		expect(claimNextJob(db)).toBeUndefined();
		expect(jobStats(db).pending).toBe(0);
	});

	it('does not queue the same resource twice while one is outstanding', () => {
		enqueueOcr(db, resourceId);
		enqueueOcr(db, resourceId);
		expect(jobStats(db).pending).toBe(1);
	});

	it('can queue again once the earlier job finished', () => {
		enqueueOcr(db, resourceId);
		completeJob(db, claimNextJob(db)!.id);
		enqueueOcr(db, resourceId);
		expect(jobStats(db).pending).toBe(1);
	});

	it('hands out jobs oldest first', () => {
		const second = db
			.prepare(
				`INSERT INTO resources(note_id, hash, mime, data) SELECT note_id, 'b', mime, data FROM resources LIMIT 1`
			)
			.run().lastInsertRowid as number;
		enqueueOcr(db, resourceId);
		enqueueOcr(db, Number(second));
		expect(claimNextJob(db)!.resourceId).toBe(resourceId);
		expect(claimNextJob(db)!.resourceId).toBe(Number(second));
	});
});

describe('failure handling', () => {
	it('retries a failed job until the attempt limit, then gives up', () => {
		enqueueOcr(db, resourceId);
		for (let i = 1; i < MAX_ATTEMPTS; i++) {
			failJob(db, claimNextJob(db)!.id, `boom ${i}`);
			expect(jobStats(db).pending).toBe(1);
		}
		failJob(db, claimNextJob(db)!.id, 'final');
		expect(jobStats(db).pending).toBe(0);
		expect(jobStats(db)).toMatchObject({ failed: 1 });
	});

	it('records the last error', () => {
		enqueueOcr(db, resourceId);
		failJob(db, claimNextJob(db)!.id, 'llm unreachable');
		expect((db.prepare('SELECT error FROM jobs').get() as { error: string }).error).toBe(
			'llm unreachable'
		);
	});
});

describe('restart recovery', () => {
	it('requeues jobs left running by a crash, without inflating attempts', () => {
		enqueueOcr(db, resourceId);
		const job = claimNextJob(db)!;
		expect(requeueStuckJobs(db)).toBe(1);
		expect(jobStats(db).pending).toBe(1);
		expect(claimNextJob(db)!.attempts).toBe(job.attempts + 1);
	});

	it('leaves finished jobs alone', () => {
		enqueueOcr(db, resourceId);
		completeJob(db, claimNextJob(db)!.id);
		expect(requeueStuckJobs(db)).toBe(0);
	});
});

describe('jobStats', () => {
	it('counts each state for the status endpoint', () => {
		enqueueOcr(db, resourceId);
		expect(jobStats(db)).toEqual({ pending: 1, running: 0, done: 0, failed: 0 });
		claimNextJob(db);
		expect(jobStats(db)).toEqual({ pending: 0, running: 1, done: 0, failed: 0 });
	});
});

describe('note-scoped jobs', () => {
	it('queues classification against a note rather than an attachment', () => {
		const noteId = (db.prepare('SELECT id FROM notes').get() as { id: number }).id;
		enqueueClassify(db, noteId);
		const job = claimNextJob(db)!;
		expect(job).toMatchObject({ kind: 'classify', noteId, resourceId: null });
	});

	it('does not queue the same note for classification twice', () => {
		const noteId = (db.prepare('SELECT id FROM notes').get() as { id: number }).id;
		enqueueClassify(db, noteId);
		enqueueClassify(db, noteId);
		expect(jobStats(db).pending).toBe(1);
	});

	it('keeps extraction and classification of the same note as separate work', () => {
		const noteId = (db.prepare('SELECT id FROM notes').get() as { id: number }).id;
		enqueueOcr(db, resourceId);
		enqueueClassify(db, noteId);
		expect(jobStats(db).pending).toBe(2);
		expect(claimNextJob(db)!.kind).toBe('ocr');
		expect(claimNextJob(db)!.kind).toBe('classify');
	});
});
