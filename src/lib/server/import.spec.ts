import { beforeEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { openDb, type Db } from './db.ts';
import { importEnex, notebookNameFromPath } from './import.ts';
import { getNote, listNotebooks, listNotes } from './notes.ts';

let db: Db;
beforeEach(() => {
	db = openDb(':memory:');
});

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<en-export>
<note><title>One</title><created>20200101T000000Z</created><tag>t</tag>
<content><![CDATA[<en-note><en-media hash="5eb63bbbe01eeed093cb22bb8f5acdc3" type="text/plain"/></en-note>]]></content>
<resource><data encoding="base64">aGVsbG8gd29ybGQ=</data><mime>text/plain</mime><resource-attributes><file-name>h.txt</file-name></resource-attributes></resource>
</note>
<note><title>Two</title><created>20200102T000000Z</created><content><![CDATA[<en-note>two</en-note>]]></content></note>
</en-export>`;

describe('importEnex', () => {
	it('imports every note into the named notebook with tags and resources', async () => {
		const result = await importEnex(db, Readable.from([xml]), 'Inbox');
		expect(result).toEqual({ imported: 2, skipped: 0 });
		const [nb] = listNotebooks(db);
		expect(nb).toMatchObject({ name: 'Inbox', noteCount: 2 });
		const one = getNote(db, listNotes(db, { query: 'One' })[0].id)!;
		expect(one.tags).toEqual(['t']);
		expect(one.resources[0]).toMatchObject({ mime: 'text/plain', fileName: 'h.txt', size: 11 });
		expect(one.html).toContain('h.txt</a>');
	});

	it('skips notes that were already imported (same notebook, title, created)', async () => {
		await importEnex(db, Readable.from([xml]), 'Inbox');
		const again = await importEnex(db, Readable.from([xml]), 'Inbox');
		expect(again).toEqual({ imported: 0, skipped: 2 });
		expect(listNotes(db, {})).toHaveLength(2);
	});

	it('reports progress per note', async () => {
		const seen: string[] = [];
		await importEnex(db, Readable.from([xml]), 'Inbox', (n) => seen.push(n.title));
		expect(seen).toEqual(['One', 'Two']);
	});
});

describe('importEnex with empty titles', () => {
	it('does not duplicate untitled notes on re-import', async () => {
		const untitled = `<en-export><note><title></title><created>20200101T000000Z</created><content><![CDATA[<en-note>x</en-note>]]></content></note></en-export>`;
		await importEnex(db, Readable.from([untitled]), 'Inbox');
		const again = await importEnex(db, Readable.from([untitled]), 'Inbox');
		expect(again).toEqual({ imported: 0, skipped: 1 });
		expect(listNotes(db, {})).toHaveLength(1);
		expect(listNotes(db, {})[0].title).toBe('Untitled');
	});
});

describe('notebookNameFromPath', () => {
	it('uses the file name without extension', () => {
		expect(notebookNameFromPath('/x/y/My Notebook.enex')).toBe('My Notebook');
		expect(notebookNameFromPath('Dokumente.ENEX')).toBe('Dokumente');
	});
});
