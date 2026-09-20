import { getDb } from '$lib/server/instance';
import { startWorker, stopWorker } from '$lib/server/worker';

// One process serves the app and drains the extraction queue.
startWorker(getDb());

// A job interrupted by a restart is requeued on the next boot, so stopping promptly is safe.
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, stopWorker);
