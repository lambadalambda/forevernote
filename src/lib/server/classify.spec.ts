import { describe, expect, it, vi } from 'vitest';
import { buildClassifyPrompt, classify, parseClassification } from './classify.ts';

const ctx = {
	fileName: 'Rechnung 2020.pdf',
	text: 'Hansen & Partner Steuerberatung\nRechnung Nr. 045937 über Beratungsleistungen',
	existingTags: ['Scannable', 'Steuer', 'pc-98'],
	notebooks: ['Dokumente', 'My Notebook']
};

describe('buildClassifyPrompt', () => {
	it('keeps the tag and notebook vocabularies visibly separate', () => {
		const p = buildClassifyPrompt(ctx);
		const tagLine = p.split('\n').find((l) => l.includes('Existing tags'))!;
		expect(tagLine).not.toContain('Dokumente');
		expect(p).toMatch(/notebook[^\n]*Dokumente/i);
	});

	it('shows the model the vocabulary it should reuse', () => {
		const p = buildClassifyPrompt(ctx);
		expect(p).toContain('Scannable');
		expect(p).toContain('Steuer');
		expect(p).toContain('Dokumente');
		expect(p).toContain('Rechnung 2020.pdf');
		expect(p).toContain('Hansen');
	});

	it('truncates very long documents so the request stays small', () => {
		const p = buildClassifyPrompt({ ...ctx, text: 'wort '.repeat(20000) });
		expect(p.length).toBeLessThan(12000);
	});

	it('copes with an empty tag and notebook vocabulary', () => {
		expect(() => buildClassifyPrompt({ ...ctx, existingTags: [], notebooks: [] })).not.toThrow();
	});
});

describe('parseClassification', () => {
	const vocab = { existingTags: ctx.existingTags, notebooks: ctx.notebooks };

	it('reads a clean JSON object', () => {
		const out = parseClassification(
			'{"title":"Rechnung Hansen & Partner","tags":["Steuer"],"notebook":"Dokumente"}',
			vocab
		);
		expect(out).toEqual({
			title: 'Rechnung Hansen & Partner',
			tags: ['Steuer'],
			notebook: 'Dokumente'
		});
	});

	it('digs the object out of markdown fences and surrounding chatter', () => {
		const raw = 'Sure!\n```json\n{"title":"Mietvertrag","tags":["Wohnung"]}\n```\nHope that helps.';
		expect(parseClassification(raw, vocab)).toMatchObject({
			title: 'Mietvertrag',
			tags: ['Wohnung']
		});
	});

	it("reuses an existing tag's capitalisation instead of creating a near-duplicate", () => {
		const out = parseClassification('{"title":"T","tags":["steuer","SCANNABLE"]}', vocab);
		expect(out.tags).toEqual(['Steuer', 'Scannable']);
	});

	it('accepts tags given as a comma separated string', () => {
		expect(parseClassification('{"title":"T","tags":"Steuer, Rechnung"}', vocab).tags).toEqual([
			'Steuer',
			'Rechnung'
		]);
	});

	it('drops duplicates, blanks and anything past the cap', () => {
		const out = parseClassification(
			'{"title":"T","tags":["a","A"," ","b","c","d","e","f"]}',
			vocab
		);
		expect(out.tags).toEqual(['a', 'b', 'c', 'd']);
	});

	it('does not let a notebook name become a tag', () => {
		// Observed in practice: the model reaches for "Dokumente" because it is in the prompt.
		const out = parseClassification(
			'{"title":"T","tags":["Dokumente","Miete","my notebook"]}',
			vocab
		);
		expect(out.tags).toEqual(['Miete']);
	});

	it('drops tags that merely restate the document being a document', () => {
		const out = parseClassification(
			'{"title":"T","tags":["Dokument","Scan","PDF","Miete"]}',
			vocab
		);
		expect(out.tags).toEqual(['Miete']);
	});

	it('only accepts a notebook that already exists, so uploads cannot invent filing', () => {
		expect(parseClassification('{"title":"T","notebook":"Dokumente"}', vocab).notebook).toBe(
			'Dokumente'
		);
		expect(
			parseClassification('{"title":"T","notebook":"Invented"}', vocab).notebook
		).toBeUndefined();
		expect(parseClassification('{"title":"T","notebook":"dokumente"}', vocab).notebook).toBe(
			'Dokumente'
		);
	});

	it('trims and shortens a rambling title', () => {
		const long = 'x'.repeat(300);
		const out = parseClassification(JSON.stringify({ title: `  ${long}  ` }), vocab);
		expect(out.title.length).toBeLessThanOrEqual(120);
		expect(out.title.startsWith('x')).toBe(true);
	});

	it('strips quotes and trailing punctuation the model likes to add', () => {
		expect(parseClassification('{"title":"\\"Rechnung 2020.\\""}', vocab).title).toBe(
			'Rechnung 2020'
		);
	});

	it('returns nothing usable when there is no JSON at all', () => {
		expect(parseClassification('I could not read this document.', vocab)).toEqual({
			title: '',
			tags: []
		});
		expect(parseClassification('', vocab)).toEqual({ title: '', tags: [] });
	});

	it('survives malformed JSON', () => {
		expect(parseClassification('{"title": "Broken", tags: [}', vocab)).toEqual({
			title: '',
			tags: []
		});
	});
});

describe('classify', () => {
	it('asks the model and returns the parsed result', async () => {
		const chat = vi.fn(
			async () => '{"title":"Rechnung Hansen & Partner","tags":["Steuer"],"notebook":"Dokumente"}'
		);
		const out = await classify(ctx, chat);
		expect(out).toEqual({
			title: 'Rechnung Hansen & Partner',
			tags: ['Steuer'],
			notebook: 'Dokumente'
		});
		expect(chat).toHaveBeenCalledWith(expect.stringContaining('Hansen'));
	});

	it('does not call the model for a document with no usable text', async () => {
		const chat = vi.fn();
		expect(await classify({ ...ctx, text: '   ' }, chat)).toEqual({ title: '', tags: [] });
		expect(chat).not.toHaveBeenCalled();
	});
});
