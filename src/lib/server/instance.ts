import { DB_PATH } from './config.ts';
import { openDb, type Db } from './db.ts';

let handle: Db | undefined;

/**
 * Process-wide database handle, opened on first use.
 *
 * Lazy on purpose: SvelteKit imports every server module during the build to analyse it,
 * and a build has no business opening (or migrating) a database.
 */
export const getDb = (): Db => (handle ??= openDb(DB_PATH));
