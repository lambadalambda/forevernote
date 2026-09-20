/**
 * Splits a document into pages for text extraction, independent of platform.
 * The actual PDF work is injected so this stays testable and so macOS (PDFKit via
 * tools/ocr) and Linux (poppler) can supply their own implementations.
 */
import type { ExtractedPage } from './llm.ts';

export interface PdfTools {
	pageCount: (file: string) => Promise<number>;
	/** Embedded text layer of one 1-based page; empty string when the page is a scan. */
	pageText: (file: string, page: number) => Promise<string>;
	/** Rasterises one 1-based page, returning the image path. */
	renderPage: (file: string, page: number, outDir: string) => Promise<string>;
}

const MIN_LETTERS = 12;

/** True when text has enough letters to be a real text layer rather than page furniture. */
export const hasUsableText = (text: string) => (text.match(/\p{L}/gu)?.length ?? 0) >= MIN_LETTERS;

export const isExtractable = (mime: string) =>
	mime === 'application/pdf' || mime.startsWith('image/');

export const extractPages = async (
	file: string,
	mime: string,
	tools: PdfTools,
	{ outDir = '' } = {}
): Promise<ExtractedPage[]> => {
	if (!isExtractable(mime)) return [];
	// An image is one page and never has a text layer, so it always needs transcription.
	if (mime !== 'application/pdf') return [{ text: '', image: file }];

	let count: number;
	try {
		count = await tools.pageCount(file);
	} catch {
		return [];
	}

	const pages: ExtractedPage[] = [];
	for (let page = 1; page <= count; page++) {
		const layer = await tools.pageText(file, page).catch(() => '');
		const usable = hasUsableText(layer);
		if (usable) {
			pages.push({ text: layer, image: null });
			continue;
		}
		// A page we cannot rasterise is dropped rather than failing the whole document.
		const image = await tools.renderPage(file, page, outDir).catch(() => null);
		if (!image) continue;
		pages.push({ text: usable ? layer : '', image });
	}
	return pages;
};
