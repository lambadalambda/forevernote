import { describe, expect, it, vi } from 'vitest';
import { extractPages, hasUsableText, type PdfTools } from './pages.ts';

const tools = (over: Partial<PdfTools> = {}): PdfTools => ({
	pageCount: vi.fn(async () => 3),
	pageText: vi.fn(async (_f: string, p: number) =>
		p === 2 ? '' : `layer text for page ${p} `.repeat(3)
	),
	renderPage: vi.fn(async (_f: string, p: number) => `/tmp/render-p${p}.jpg`),
	...over
});

describe('hasUsableText', () => {
	it('needs a dozen letters, so page furniture does not count as a text layer', () => {
		expect(hasUsableText('')).toBe(false);
		expect(hasUsableText('\f\n 12 34 \f')).toBe(false);
		expect(hasUsableText('Zustimmungserklärung zur Steuer')).toBe(true);
	});
});

describe('extractPages', () => {
	it('keeps the text layer where there is one and renders only the pages without', async () => {
		const t = tools();
		const pages = await extractPages('/tmp/doc.pdf', 'application/pdf', t);
		expect(pages).toHaveLength(3);
		expect(pages[0]).toEqual({
			text: expect.stringContaining('layer text for page 1'),
			image: null
		});
		expect(pages[1]).toEqual({ text: '', image: '/tmp/render-p2.jpg' });
		expect(pages[2].image).toBeNull();
		expect(t.renderPage).toHaveBeenCalledTimes(1);
		expect(t.renderPage).toHaveBeenCalledWith('/tmp/doc.pdf', 2, expect.anything());
	});

	it('treats an image as a single page needing transcription', async () => {
		const t = tools();
		const pages = await extractPages('/tmp/scan.png', 'image/png', t);
		expect(pages).toEqual([{ text: '', image: '/tmp/scan.png' }]);
		expect(t.pageCount).not.toHaveBeenCalled();
		expect(t.renderPage).not.toHaveBeenCalled();
	});

	it('returns nothing for types that carry no text', async () => {
		expect(await extractPages('/tmp/a.mp3', 'audio/mpeg', tools())).toEqual([]);
	});

	it('skips pages whose rendering fails rather than losing the whole document', async () => {
		const t = tools({
			pageText: vi.fn(async () => ''),
			renderPage: vi.fn(async (_f: string, p: number) => {
				if (p === 2) throw new Error('render failed');
				return `/tmp/render-p${p}.jpg`;
			})
		});
		const pages = await extractPages('/tmp/doc.pdf', 'application/pdf', t);
		expect(pages.map((p) => p.image)).toEqual(['/tmp/render-p1.jpg', '/tmp/render-p3.jpg']);
	});

	it('gives up on a pdf whose page count cannot be read', async () => {
		const t = tools({
			pageCount: vi.fn(async () => {
				throw new Error('broken pdf');
			})
		});
		expect(await extractPages('/tmp/bad.pdf', 'application/pdf', t)).toEqual([]);
	});
});
