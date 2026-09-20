// Usage: node scripts/import.ts export/*.enex
// Imports each ENEX file into a notebook named after the file. Safe to re-run.
import { openDb } from '../src/lib/server/db.ts';
import { importEnexFile, notebookNameFromPath } from '../src/lib/server/import.ts';
import { DB_PATH } from '../src/lib/server/config.ts';

const files = process.argv.slice(2);
if (!files.length) {
	console.error('usage: node scripts/import.ts <file.enex> [...]');
	process.exit(1);
}
const db = openDb(DB_PATH);
console.log(`database: ${DB_PATH}`);
for (const file of files) {
	const t0 = Date.now();
	const r = await importEnexFile(db, file, (n, s) => {
		if (s === 'imported') process.stdout.write(`  + ${n.title}\n`);
	});
	console.log(
		`${notebookNameFromPath(file)}: ${r.imported} imported, ${r.skipped} skipped (${((Date.now() - t0) / 1000).toFixed(1)}s)`
	);
}
db.close();
