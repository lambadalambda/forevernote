import { resolve } from 'node:path';

/** Location of the SQLite database; override with FOREVERNOTE_DB. */
export const DB_PATH = resolve(process.env.FOREVERNOTE_DB ?? 'data/forevernote.db');
