// Usage: node scripts/bench-ocr.ts --fixtures DIR [--models a,b,c] [--out FILE]
//
// Compares OCR engines on scan-like pages with exact ground truth.
// Build the fixtures first:  python3 scripts/bench_fixtures.py /tmp/fixtures --pages 10
//
// Why synthetic pages: the collection has one born-digital PDF, so real pages have no
// trustworthy reference — their embedded text layer is itself scanner OCR, often bad.
// The fixtures typeset real German passages from the notes and degrade them like a scan,
// which makes the source text exact ground truth. Half are "good" scans, half "rough".
//
// Two scores per engine:
//   WER  word error rate, order-sensitive (lower is better)
//   F1   multiset word overlap, order-insensitive (higher is better) — fair to engines
//        that read multi-column or tabular layouts in a different order
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { transcribeImage, DEFAULT_LLM } from '../src/lib/server/llm.ts';
import {
	bagOfWordsF1,
	normalizeForCompare,
	tokenize,
	wordErrorRate
} from '../src/lib/server/score.ts';

const run = promisify(execFile);
const arg = (name: string, fallback: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const MODELS = arg(
	'models',
	'Gemma-4-26B-A4B-it-GGUF,Gemma-4-E4B-it-GGUF,Gemma-4-E2B-it-GGUF'
).split(',');
const OUT = arg('out', '');
const FIXTURES = arg('fixtures', '');
const THINKING = process.argv.includes('--thinking');
if (!FIXTURES) {
	console.error(
		'usage: node scripts/bench-ocr.ts --fixtures DIR   (see scripts/bench_fixtures.py)'
	);
	process.exit(1);
}

interface Sample {
	label: string;
	tier: string;
	image: string;
	reference: string;
}

/** Reads page-N-<tier>.jpg / .txt pairs written by scripts/bench_fixtures.py. */
const loadSamples = (dir: string): Sample[] =>
	readdirSync(dir)
		.filter((f) => f.endsWith('.jpg'))
		.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
		.map((f) => ({
			label: f.replace(/\.jpg$/, ''),
			tier: f.match(/-(good|rough)\.jpg$/)?.[1] ?? 'unknown',
			image: join(dir, f),
			reference: readFileSync(join(dir, f.replace(/\.jpg$/, '.txt')), 'utf8')
		}));

const visionOcr = async (image: string) => {
	const { stdout } = await run('tools/ocr', ['--fast', image], { maxBuffer: 64 * 1024 * 1024 });
	return stdout;
};

interface Result {
	engine: string;
	wers: number[];
	f1s: number[];
	secs: number[];
	tiers: string[];
	failures: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

const samples = loadSamples(FIXTURES);
const refWords = samples.map((s) => tokenize(normalizeForCompare(s.reference)).length);
const tiers = [...new Set(samples.map((s) => s.tier))].join('/');
console.log(
	`${samples.length} pages from ${FIXTURES} (${tiers}), ~${Math.round(mean(refWords))} reference words each\n`
);

const engines: { name: string; fn: (image: string) => Promise<string> }[] = [
	...(process.argv.includes('--no-vision') ? [] : [{ name: 'apple-vision-fast', fn: visionOcr }]),
	...MODELS.map((model) => ({
		name: THINKING ? `${model} (thinking)` : model,
		fn: (image: string) =>
			transcribeImage(readFileSync(image), 'image/jpeg', {
				...DEFAULT_LLM,
				model,
				thinking: THINKING,
				timeoutMs: 900_000
			})
	}))
];

const results: Result[] = [];
const transcripts: Record<string, Record<string, string>> = {};
for (const engine of engines) {
	const r: Result = { engine: engine.name, wers: [], f1s: [], secs: [], tiers: [], failures: 0 };
	process.stdout.write(`${engine.name.padEnd(24)} `);
	for (const sample of samples) {
		const t0 = Date.now();
		try {
			const text = await engine.fn(sample.image);
			r.secs.push((Date.now() - t0) / 1000);
			r.wers.push(wordErrorRate(sample.reference, text));
			r.f1s.push(bagOfWordsF1(sample.reference, text));
			r.tiers.push(sample.tier);
			(transcripts[sample.label] ??= {})[engine.name] = text;
			process.stdout.write(`${(r.wers.at(-1)! * 100).toFixed(0)}% `);
		} catch (e) {
			r.failures++;
			r.wers.push(1);
			r.f1s.push(0);
			r.secs.push((Date.now() - t0) / 1000);
			r.tiers.push(sample.tier);
			process.stdout.write('ERR ');
			if (process.env.BENCH_VERBOSE) console.error(`\n  ${(e as Error).message}`);
		}
	}
	console.log(`  (${r.secs.reduce((a, b) => a + b, 0).toFixed(0)}s)`);
	results.push(r);
}

const byTier = (r: Result, tier: string, xs: number[]) =>
	mean(xs.filter((_, i) => r.tiers[i] === tier));

console.log('\n=== results (WER lower is better, F1 higher is better)');
console.table(
	results.map((r) => ({
		engine: r.engine,
		'WER %': (mean(r.wers) * 100).toFixed(1),
		'WER % good': (byTier(r, 'good', r.wers) * 100).toFixed(1),
		'WER % rough': (byTier(r, 'rough', r.wers) * 100).toFixed(1),
		'F1 %': (mean(r.f1s) * 100).toFixed(1),
		'median WER %': (median(r.wers) * 100).toFixed(1),
		's/page': mean(r.secs).toFixed(1),
		fail: r.failures
	}))
);

if (OUT) {
	writeFileSync(OUT, JSON.stringify({ fixtures: FIXTURES, results, transcripts }, null, 2));
	console.log(`wrote ${OUT}`);
}
