import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/instance';
import { jobStats } from '$lib/server/jobs';
import { extractorStatus } from '$lib/server/worker';

/** Queue depth and extractor health, for the UI and for eyeballing the service. */
export const GET: RequestHandler = async () =>
	json({ jobs: jobStats(getDb()), extractor: await extractorStatus() });
