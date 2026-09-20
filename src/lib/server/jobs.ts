/**
 * Durable background work queue. Text extraction takes tens of seconds per page, so
 * uploads enqueue a job and return immediately. The queue lives in SQLite so work
 * survives a restart.
 */
import type { Db } from './db.ts';

export const MAX_ATTEMPTS = 3;

export type JobKind = 'ocr' | 'classify';

export interface Job {
	id: number;
	kind: JobKind;
	/** Set for extraction jobs, which act on one attachment. */
	resourceId: number | null;
	/** Set for classification jobs, which act on a whole note. */
	noteId: number | null;
	attempts: number;
}

export interface JobStats {
	pending: number;
	running: number;
	done: number;
	failed: number;
}

const now = () => new Date().toISOString();

/** Queues work unless the same target already has an outstanding job of that kind. */
const enqueue = (db: Db, kind: JobKind, column: 'resource_id' | 'note_id', target: number) => {
	const outstanding = db
		.prepare(
			`SELECT 1 FROM jobs WHERE ${column} = ? AND kind = ? AND state IN ('pending', 'running')`
		)
		.get(target, kind);
	if (outstanding) return;
	db.prepare(
		`INSERT INTO jobs(kind, ${column}, state, created, updated) VALUES (?, ?, 'pending', ?, ?)`
	).run(kind, target, now(), now());
};

/** Queues text extraction for one attachment. */
export const enqueueOcr = (db: Db, resourceId: number) =>
	enqueue(db, 'ocr', 'resource_id', resourceId);

/** Queues title and tag suggestions for a note, once its text is known. */
export const enqueueClassify = (db: Db, noteId: number) =>
	enqueue(db, 'classify', 'note_id', noteId);

/**
 * Marks the oldest pending job as running and returns it. Single process, so a
 * statement pair is enough; the UPDATE ... RETURNING keeps it atomic anyway.
 */
export const claimNextJob = (db: Db): Job | undefined =>
	db
		.prepare(
			`UPDATE jobs SET state = 'running', attempts = attempts + 1, updated = ?
			 WHERE id = (SELECT id FROM jobs WHERE state = 'pending' ORDER BY id LIMIT 1)
			 RETURNING id, kind, resource_id AS resourceId, note_id AS noteId, attempts`
		)
		.get(now()) as unknown as Job | undefined;

export const completeJob = (db: Db, id: number) =>
	db
		.prepare(`UPDATE jobs SET state = 'done', error = NULL, updated = ? WHERE id = ?`)
		.run(now(), id);

/** Puts a job back for another try, or marks it failed once the attempt limit is reached. */
export const failJob = (db: Db, id: number, error: string) =>
	db
		.prepare(
			`UPDATE jobs
			 SET state = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
			     error = ?, updated = ?
			 WHERE id = ?`
		)
		.run(MAX_ATTEMPTS, error.slice(0, 500), now(), id);

/** After a crash a job can be stuck in 'running'; put those back on the queue at startup. */
export const requeueStuckJobs = (db: Db): number =>
	Number(
		db.prepare(`UPDATE jobs SET state = 'pending', updated = ? WHERE state = 'running'`).run(now())
			.changes
	);

export const jobStats = (db: Db): JobStats => {
	const rows = db
		.prepare(`SELECT state, count(*) AS n FROM jobs GROUP BY state`)
		.all() as unknown as {
		state: string;
		n: number;
	}[];
	const stats: JobStats = { pending: 0, running: 0, done: 0, failed: 0 };
	for (const r of rows) if (r.state in stats) stats[r.state as keyof JobStats] = r.n;
	return stats;
};
