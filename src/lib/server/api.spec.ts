import { describe, expect, it } from 'vitest';
import { parseNotePatch, parseIntParam, checkUpload, MAX_UPLOAD_BYTES } from './api.ts';

describe('parseNotePatch', () => {
	it('accepts known string/array/number fields only', () => {
		expect(
			parseNotePatch({
				title: 'a',
				html: '<p>x</p>',
				tags: ['t', ' u '],
				notebookId: 3,
				trashed: true,
				junk: 1
			})
		).toEqual({ title: 'a', html: '<p>x</p>', tags: ['t', ' u '], notebookId: 3, trashed: true });
	});
	it('rejects wrong types', () => {
		expect(() => parseNotePatch({ title: 1 })).toThrow(/title/);
		expect(() => parseNotePatch({ tags: 'x' })).toThrow(/tags/);
		expect(() => parseNotePatch({ tags: [1] })).toThrow(/tags/);
		expect(() => parseNotePatch({ notebookId: '1' })).toThrow(/notebookId/);
		expect(() => parseNotePatch(null)).toThrow(/object/);
	});
	it('yields an empty patch for an empty object', () => {
		expect(parseNotePatch({})).toEqual({});
	});
});

describe('parseIntParam', () => {
	it('parses positive integers and returns undefined otherwise', () => {
		expect(parseIntParam('12')).toBe(12);
		expect(parseIntParam('0')).toBeUndefined();
		expect(parseIntParam('x')).toBeUndefined();
		expect(parseIntParam(null)).toBeUndefined();
	});
});

describe('checkUpload', () => {
	const ok = { name: 'scan.pdf', type: 'application/pdf', size: 1024 };

	it('accepts the document and image types the extractor understands', () => {
		for (const type of ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'])
			expect(checkUpload({ ...ok, type })).toBeUndefined();
	});

	it('accepts other types too, since a note may hold any attachment', () => {
		expect(checkUpload({ ...ok, type: 'audio/mpeg' })).toBeUndefined();
	});

	it('rejects types that render as same-origin markup', () => {
		for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml'])
			expect(checkUpload({ ...ok, type })).toMatch(/not allowed/i);
	});

	it('rejects empty and oversized files', () => {
		expect(checkUpload({ ...ok, size: 0 })).toMatch(/empty/i);
		expect(checkUpload({ ...ok, size: MAX_UPLOAD_BYTES + 1 })).toMatch(/too large/i);
		expect(checkUpload({ ...ok, size: MAX_UPLOAD_BYTES })).toBeUndefined();
	});

	it('accepts a file the browser could not type, rather than refusing it', () => {
		expect(checkUpload({ name: 'archive.xyz', type: '', size: 10 })).toBeUndefined();
	});
});
