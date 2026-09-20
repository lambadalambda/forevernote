/**
 * PDF page access on Linux via poppler-utils, the server-side counterpart to the macOS
 * tools/ocr binary (which needs PDFKit and Vision and so cannot run on the NAS).
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PdfTools } from './pages.ts';

const run = promisify(execFile);
const BUFFER = 256 * 1024 * 1024;

/** Resolution for rasterised pages. 150 dpi keeps small print legible without huge images. */
const RENDER_DPI = 150;

export const popplerTools: PdfTools = {
	pageCount: async (file) => {
		const { stdout } = await run('pdfinfo', [file], { maxBuffer: BUFFER });
		const pages = stdout.match(/^Pages:\s+(\d+)/m)?.[1];
		if (!pages) throw new Error('could not read page count');
		return Number(pages);
	},

	pageText: async (file, page) => {
		const { stdout } = await run('pdftotext', ['-f', String(page), '-l', String(page), file, '-'], {
			maxBuffer: BUFFER
		});
		return stdout;
	},

	renderPage: async (file, page, outDir) => {
		// pdftoppm appends "-<page>.jpg" to the prefix, zero-padded to the page-number width.
		const prefix = join(outDir, `page`);
		await run(
			'pdftoppm',
			['-jpeg', '-r', String(RENDER_DPI), '-f', String(page), '-l', String(page), file, prefix],
			{ maxBuffer: BUFFER }
		);
		const { readdir } = await import('node:fs/promises');
		const produced = (await readdir(outDir)).find((f) => /^page-0*\d+\.jpg$/.test(f));
		if (!produced) throw new Error(`pdftoppm produced no image for page ${page}`);
		return join(outDir, produced);
	}
};

/** True when the poppler binaries this module shells out to are installed. */
export const popplerAvailable = async () => {
	for (const bin of ['pdfinfo', 'pdftotext', 'pdftoppm']) {
		try {
			await run(bin, ['-v'], { maxBuffer: 1024 * 1024 });
		} catch (e) {
			// -v exits non-zero on some builds but still proves the binary exists.
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
		}
	}
	return true;
};
