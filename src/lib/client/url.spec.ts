import { describe, expect, it } from 'vitest';
import { withParams, formatDate, debounce } from './url.ts';

describe('withParams', () => {
	it('merges changes into an existing query string', () => {
		expect(withParams('?notebook=1&note=5', { note: 7 })).toBe('?notebook=1&note=7');
	});
	it('removes keys set to null/undefined/empty and returns "/" when nothing is left', () => {
		expect(withParams('?note=5&q=x', { note: null, q: '' })).toBe('/');
	});
	it('handles a missing query string', () => {
		expect(withParams('', { tag: 2 })).toBe('?tag=2');
	});
});

describe('formatDate', () => {
	it('renders ISO dates as a short readable stamp', () => {
		expect(formatDate('2020-05-03T19:48:58.000Z', 'UTC')).toBe('2020-05-03 19:48');
	});
	it('is empty for missing input', () => {
		expect(formatDate(undefined)).toBe('');
	});
});

describe('debounce', () => {
	it('calls the function once after the delay and flushes on demand', async () => {
		const calls: number[] = [];
		const d = debounce((n: number) => calls.push(n), 10);
		d(1);
		d(2);
		expect(calls).toEqual([]);
		d.flush();
		expect(calls).toEqual([2]);
		d(3);
		await new Promise((r) => setTimeout(r, 25));
		expect(calls).toEqual([2, 3]);
		d.flush();
		expect(calls).toEqual([2, 3]);
	});
});
