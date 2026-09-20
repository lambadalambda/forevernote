// Usage: node scripts/ocr.ts [--fast] [--no-llm] [--upgrade] [--rebuild-tool]
// Extracts searchable text from attachments using tools/ocr (PDF text layers via PDFKit,
// Vision OCR) and, when a Lemonade server with a vision model is reachable, transcribes image
// pages with the model instead (much better quality). macOS only.
//   --upgrade  also redo attachments whose text came from Vision OCR
//   --no-llm   skip the model even if the server is up
//   --fast     use Vision's fast mode from the start
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openDb } from '../src/lib/server/db.ts';
import {
	DEFAULT_LLM,
	combinePages,
	llmAvailable,
	transcribeImage,
	type ExtractedPage
} from '../src/lib/server/llm.ts';
import { DB_PATH } from '../src/lib/server/config.ts';
import { pendingResources, setResourceText } from '../src/lib/server/ocr.ts';
import { isExtractable } from '../src/lib/server/pages.ts';

const run = promisify(execFile);
const TOOL = 'tools/ocr';
const flags = new Set(process.argv.slice(2));
let fast = flags.has('--fast');

if (!existsSync(TOOL) || flags.has('--rebuild-tool')) {
	console.log('compiling tools/ocr with swiftc…');
	await run('swiftc', ['-O', '-o', TOOL, 'tools/ocr.swift']);
}

const useLlm = !flags.has('--no-llm') && (await llmAvailable(DEFAULT_LLM));
console.log(
	useLlm
		? `vision model: ${DEFAULT_LLM.model} at ${DEFAULT_LLM.baseUrl}`
		: 'vision model: not available, Vision OCR only'
);

const tmp = mkdtempSync(join(tmpdir(), 'forevernote-ocr-'));
const ext = (mime: string) =>
	({ 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' })[
		mime
	] ?? 'bin';

/** Runs the Swift tool in page mode. */
const extractPages = async (data: Uint8Array, mime: string): Promise<ExtractedPage[]> => {
	const path = join(tmp, `scan.${ext(mime)}`);
	writeFileSync(path, data);
	const args = [...(fast ? ['--fast'] : []), '--json', '--render-dir', tmp, path];
	const { stdout, stderr } = await run(TOOL, args, { maxBuffer: 256 * 1024 * 1024 }).catch((e) => {
		console.error('  ocr tool failed:', (e as Error).message);
		return { stdout: '{"pages":[]}', stderr: '' };
	});
	if (stderr.includes('fallback:fast') && !fast) {
		fast = true;
		console.log('  (accurate Vision OCR unavailable, using fast mode from here on)');
	}
	return (JSON.parse(stdout) as { pages: ExtractedPage[] }).pages;
};

const transcribe = (imagePath: string) => {
	const mime = imagePath.endsWith('.png')
		? 'image/png'
		: imagePath.endsWith('.gif')
			? 'image/gif'
			: 'image/jpeg';
	return transcribeImage(readFileSync(imagePath), mime, DEFAULT_LLM);
};

const db = openDb(DB_PATH);
const pending = pendingResources(db, { upgradeVision: useLlm && flags.has('--upgrade') });
console.log(`database: ${DB_PATH}\n${pending.length} attachments to process`);
const t0 = Date.now();
let done = 0;
const bySource = { layer: 0, vision: 0, llm: 0 };
for (const r of pending) {
	if (!isExtractable(r.mime)) {
		setResourceText(db, r.id, '', 'layer');
		continue;
	}
	const { data } = db.prepare('SELECT data FROM resources WHERE id = ?').get(r.id) as {
		data: Uint8Array;
	};
	const pages = await extractPages(data, r.mime);
	const { text, source } = await combinePages(
		pages,
		useLlm ? transcribe : () => Promise.reject(new Error('llm disabled'))
	);
	setResourceText(db, r.id, text.trim(), source);
	done++;
	bySource[source]++;
	console.log(
		`  [${done}/${pending.length}] ${r.fileName ?? r.hash} -> ${text.length} chars (${source}, ${pages.length} pages)`
	);
}
rmSync(tmp, { recursive: true, force: true });
db.close();
console.log(`done: ${done} attachments in ${((Date.now() - t0) / 1000).toFixed(0)}s`, bySource);
