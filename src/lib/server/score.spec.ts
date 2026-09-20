import { describe, expect, it } from 'vitest';
import { bagOfWordsF1, normalizeForCompare, tokenize, wordErrorRate } from './score.ts';

describe('normalizeForCompare', () => {
	it('lowercases, collapses whitespace and strips punctuation that OCR varies on', () => {
		expect(normalizeForCompare('Hello,   WORLD!\n\nZeile 2.')).toBe('hello world zeile 2');
	});
	it('folds German typography so umlauts and quotes do not count as errors', () => {
		expect(normalizeForCompare('Lindenstraße „Test“ –')).toBe('lindenstrasse test');
	});
	it('is empty for whitespace-only input', () => {
		expect(normalizeForCompare('  \n\t ')).toBe('');
	});
});

describe('tokenize', () => {
	it('splits normalized text into words', () => {
		expect(tokenize('a bc def')).toEqual(['a', 'bc', 'def']);
		expect(tokenize('')).toEqual([]);
	});
});

describe('wordErrorRate', () => {
	it('is 0 for an exact match after normalization', () => {
		expect(wordErrorRate('Hello World', 'hello,  world!')).toBe(0);
	});
	it('counts substitutions, insertions and deletions against the reference length', () => {
		// reference 4 words, one substitution
		expect(wordErrorRate('a b c d', 'a b x d')).toBeCloseTo(0.25);
		// one deletion
		expect(wordErrorRate('a b c d', 'a b d')).toBeCloseTo(0.25);
		// one insertion
		expect(wordErrorRate('a b c d', 'a b c x d')).toBeCloseTo(0.25);
	});
	it('is 1 when the output is empty and 1 when nothing matches', () => {
		expect(wordErrorRate('a b c', '')).toBe(1);
		expect(wordErrorRate('a b c', 'x y z')).toBe(1);
	});
	it('caps at 1 so a rambling output cannot dominate an average', () => {
		expect(wordErrorRate('a b', 'x y z w v u t s')).toBe(1);
	});
	it('is 0 when both sides are empty', () => {
		expect(wordErrorRate('', '')).toBe(0);
	});
});

describe('bagOfWordsF1', () => {
	it('is 1 for the same words in any order, which tables often produce', () => {
		expect(bagOfWordsF1('Datum Betrag Saldo', 'saldo, betrag. DATUM')).toBe(1);
	});
	it('respects repeated words rather than treating text as a set', () => {
		expect(bagOfWordsF1('a a b', 'a b')).toBeCloseTo(0.8);
	});
	it('penalises both missed and invented words', () => {
		expect(bagOfWordsF1('a b c d', 'a b')).toBeCloseTo((2 * ((2 / 2) * (2 / 4))) / (2 / 2 + 2 / 4));
		expect(bagOfWordsF1('a b', 'a b c d')).toBeCloseTo((2 * ((2 / 4) * (2 / 2))) / (2 / 4 + 2 / 2));
	});
	it('is 0 when there is no overlap and 1 when both are empty', () => {
		expect(bagOfWordsF1('a b', 'x y')).toBe(0);
		expect(bagOfWordsF1('', '')).toBe(1);
		expect(bagOfWordsF1('a', '')).toBe(0);
	});
});
