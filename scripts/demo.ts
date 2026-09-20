// Usage: node scripts/demo.ts [path]        default: data/demo.db
//
// Builds a small database of invented notes so the app can be tried, screenshotted or
// developed against without an Evernote export. Refuses to touch an existing file.
//
//   FOREVERNOTE_DB=data/demo.db npm run dev
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDb } from '../src/lib/server/db.ts';
import { attachResource, createNotebook, insertNote } from '../src/lib/server/notes.ts';
import { setResourceText } from '../src/lib/server/ocr.ts';
import { claimNextJob, completeJob } from '../src/lib/server/jobs.ts';

const path = resolve(process.argv[2] ?? 'data/demo.db');
if (existsSync(path)) {
	console.error(`${path} already exists; delete it first or pass another path.`);
	process.exit(1);
}
mkdirSync(dirname(path), { recursive: true });

/**
 * A minimal one-page PDF with a real text layer, so the demo has an attachment that the
 * extractor can read without anyone needing a model server running.
 */
const makePdf = (lines: string[]): Uint8Array => {
	const escape = (s: string) => s.replace(/([()\\])/g, '\\$1');
	const body = lines
		.map((line, i) => `BT /F1 12 Tf 60 ${740 - i * 18} Td (${escape(line)}) Tj ET`)
		.join('\n');
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
		`<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
	];
	let pdf = '%PDF-1.4\n';
	const offsets: number[] = [];
	objects.forEach((object, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
	return new TextEncoder().encode(pdf);
};

const p = (...paragraphs: string[]) =>
	`<en-note>${paragraphs.map((t) => `<div>${t}</div>`).join('<div><br/></div>')}</en-note>`;

const db = openDb(path);
const documents = createNotebook(db, 'Documents').id;
const notes = createNotebook(db, 'Notes').id;

const seed: Parameters<typeof insertNote>[1][] = [
	{
		notebookId: notes,
		title: 'Sourdough, what actually worked',
		created: '2024-03-02T09:14:00.000Z',
		updated: '2024-11-18T19:02:00.000Z',
		tags: ['recipes'],
		enml: p(
			'Stopped weighing the starter and it got better, not worse.',
			'<b>Ratios that work:</b> 100 g starter, 500 g flour, 350 g water, 10 g salt. Autolyse for an hour before the salt goes in.',
			'Four sets of stretch and folds, half an hour apart, then cold proof overnight. Straight from the fridge into a very hot dutch oven, lid on for twenty minutes.',
			'The loaf that came out flat was under-proofed, not over. Give it the extra hour.'
		)
	},
	{
		notebookId: notes,
		title: 'Lisbon, places worth going back to',
		created: '2024-05-21T17:40:00.000Z',
		updated: '2024-05-29T08:11:00.000Z',
		tags: ['travel'],
		enml: p(
			'<b>Food.</b> The tiny place on Rua das Portas de Santo Antão with no sign. Grilled sardines, cash only, closes when it runs out.',
			'<b>Walking.</b> Start at Graça and come down through Alfama in the late afternoon. Everything before eleven is empty and everything after four is beautiful.',
			'<b>Do not bother.</b> The tram queue at Praça do Comércio. Walk two stops up and get on where nobody is waiting.'
		)
	},
	{
		notebookId: notes,
		title: 'Team sync, 14 November',
		created: '2024-11-14T10:00:00.000Z',
		updated: '2024-11-14T10:47:00.000Z',
		tags: ['work', 'meetings'],
		enml: `<en-note><div><b>Present:</b> Ana, Priya, Tomas, me</div><div><br/></div><div>Migration is a week behind, and the reason is the backfill, not the schema work.</div><div><br/></div><ul><li>Ana takes the backfill and reports Thursday</li><li>Priya writes the rollback runbook before we touch production</li><li>I talk to support about the ticket backlog</li></ul><div><br/></div><div><en-todo checked="true"/>Book the follow-up</div><div><en-todo/>Send the rollback runbook round for review</div></en-note>`
	},
	{
		notebookId: notes,
		title: 'Books to read next',
		created: '2023-09-04T21:33:00.000Z',
		updated: '2024-10-02T07:55:00.000Z',
		tags: ['reading'],
		enml: `<en-note><ul><li>The Dawn of Everything, Graeber and Wengrow</li><li>Piranesi, Susanna Clarke, second time</li><li>Seeing Like a State, borrowed and never started</li><li>A Pattern Language, in small pieces rather than cover to cover</li></ul></en-note>`
	},
	{
		notebookId: notes,
		title: 'Flat: things to fix before winter',
		created: '2024-09-30T12:20:00.000Z',
		updated: '2024-10-28T16:05:00.000Z',
		tags: ['home'],
		enml: `<en-note><div><en-todo checked="true"/>Bleed the radiators</div><div><en-todo checked="true"/>Replace the hall light switch</div><div><en-todo/>Seal the bathroom window, the draught is coming from the hinge side</div><div><en-todo/>Get the boiler serviced, last done two winters ago</div></en-note>`
	},
	{
		notebookId: documents,
		title: 'Bike insurance, renewal terms',
		created: '2024-02-11T14:02:00.000Z',
		updated: '2024-02-11T14:02:00.000Z',
		tags: ['insurance'],
		enml: p(
			'Renews automatically on 1 March unless cancelled a month before.',
			'Excess went from 75 to 120. Theft is only covered if it is locked to something fixed, which rules out the courtyard.'
		)
	},
	{
		notebookId: documents,
		title: 'Apartment inventory, move-in',
		created: '2023-07-02T11:15:00.000Z',
		updated: '2023-07-02T11:15:00.000Z',
		tags: ['home'],
		enml: p(
			'Photographed everything before unpacking. Scratch on the kitchen worktop and the crack in the bathroom tile were both there already, both noted on the handover sheet.',
			'Meter readings on the day: electricity 41,207, gas 8,914, water 112.'
		)
	},
	{
		notebookId: notes,
		title: 'Why the deploy broke on Friday',
		created: '2024-11-08T18:41:00.000Z',
		updated: '2024-11-08T20:12:00.000Z',
		tags: ['work'],
		enml: p(
			'The migration added an index over a column that a later migration creates. Locally the column was already there, so it passed. On a fresh database the index came first and the whole thing failed to open.',
			'Ordering matters more than it looks. Anything that references a migrated column has to run after the migration, not alongside the base schema.',
			'Fix was four lines. Finding it took two hours.'
		)
	}
];

for (const note of seed) insertNote(db, note);

// One note with an attachment, to show what a filed document looks like.
const invoiceLines = [
	'NORTHWIND CYCLES',
	'14 Carriage Lane, Bristol BS1 4TR',
	'',
	'INVOICE  NW-2024-0318',
	'Date: 18 March 2024',
	'',
	'Annual service                      85.00',
	'Replace rear brake cable            12.50',
	'Chain and cassette                  64.00',
	'Labour, 1.5 hours                   52.50',
	'',
	'Subtotal                           214.00',
	'VAT 20%                             42.80',
	'Total due                          256.80',
	'',
	'Payable within 14 days.',
	'Warranty on parts is 12 months from this date.'
];
const invoiceId = insertNote(db, {
	notebookId: documents,
	title: 'Bike service invoice, March 2024',
	created: '2024-03-18T15:26:00.000Z',
	updated: '2024-03-18T15:26:00.000Z',
	tags: ['invoices'],
	enml: p(
		'Annual service plus the drivetrain that finally gave up. Warranty on the parts runs to March next year, so worth keeping.'
	)
});
attachResource(db, invoiceId, {
	mime: 'application/pdf',
	fileName: 'northwind-invoice-NW-2024-0318.pdf',
	data: makePdf(invoiceLines)
});

// Attaching bumps the note's timestamp; put it back so the demo reads as a real archive.
db.prepare('UPDATE notes SET updated = created WHERE id = ?').run(invoiceId);

// Pretend the extractor already ran, so the demo is searchable without a model server.
for (;;) {
	const job = claimNextJob(db);
	if (!job) break;
	if (job.resourceId !== null) setResourceText(db, job.resourceId, invoiceLines.join('\n'), 'layer');
	completeJob(db, job.id);
}

db.close();
console.log(`demo database written to ${path}`);
console.log(`try it with:  FOREVERNOTE_DB=${process.argv[2] ?? 'data/demo.db'} npm run dev`);
