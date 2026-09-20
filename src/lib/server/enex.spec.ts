import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { parseEnex, parseEnexDate } from './enex.ts';

const wrap = (notes: string) =>
	`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20260918T141546Z" application="Evernote" version="10.134.4">
${notes}
</en-export>`;

const collect = async (xml: string) => {
	const out = [];
	for await (const n of parseEnex(Readable.from([xml]))) out.push(n);
	return out;
};

describe('parseEnexDate', () => {
	it('converts compact Evernote timestamps to ISO 8601', () => {
		expect(parseEnexDate('20200503T194858Z')).toBe('2020-05-03T19:48:58.000Z');
	});
	it('returns undefined for missing input', () => {
		expect(parseEnexDate(undefined)).toBeUndefined();
	});
});

describe('parseEnex', () => {
	it('parses a minimal note with title, dates, tags and ENML content', async () => {
		const [note] = await collect(
			wrap(`<note>
  <title>Hello &amp; welcome</title>
  <created>20200503T194858Z</created>
  <updated>20200503T195244Z</updated>
  <tag>alpha</tag>
  <tag>beta</tag>
  <note-attributes>
    <author>me@example.com</author>
    <source>desktop.win</source>
    <source-url>https://example.com</source-url>
  </note-attributes>
  <content><![CDATA[<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note><div>Body <b>text</b></div></en-note>]]></content>
</note>`)
		);
		expect(note.title).toBe('Hello & welcome');
		expect(note.created).toBe('2020-05-03T19:48:58.000Z');
		expect(note.updated).toBe('2020-05-03T19:52:44.000Z');
		expect(note.tags).toEqual(['alpha', 'beta']);
		expect(note.attributes).toEqual({
			author: 'me@example.com',
			source: 'desktop.win',
			sourceUrl: 'https://example.com'
		});
		expect(note.enml).toContain('<en-note><div>Body <b>text</b></div></en-note>');
		expect(note.resources).toEqual([]);
	});

	it('decodes base64 resources and computes their md5 hash', async () => {
		const bytes = Buffer.from('hello world');
		const b64 = bytes.toString('base64');
		const md5 = createHash('md5').update(bytes).digest('hex');
		const [note] = await collect(
			wrap(`<note>
  <title>With file</title>
  <created>20200503T194858Z</created>
  <content><![CDATA[<en-note><en-media hash="${md5}" type="text/plain"/></en-note>]]></content>
  <resource>
    <data encoding="base64">
${b64.slice(0, 8)}
${b64.slice(8)}
    </data>
    <mime>text/plain</mime>
    <width>10</width>
    <height>20</height>
    <resource-attributes>
      <file-name>hello.txt</file-name>
    </resource-attributes>
  </resource>
</note>`)
		);
		expect(note.resources).toHaveLength(1);
		const r = note.resources[0];
		expect(r.hash).toBe(md5);
		expect(r.mime).toBe('text/plain');
		expect(r.fileName).toBe('hello.txt');
		expect(r.width).toBe(10);
		expect(r.height).toBe(20);
		expect(Buffer.from(r.data).toString()).toBe('hello world');
	});

	it('yields multiple notes in order and defaults missing fields', async () => {
		const notes = await collect(
			wrap(`<note><title>One</title><content><![CDATA[<en-note/>]]></content></note>
<note><title>Two</title><content><![CDATA[<en-note/>]]></content></note>`)
		);
		expect(notes.map((n) => n.title)).toEqual(['One', 'Two']);
		expect(notes[0].tags).toEqual([]);
		expect(notes[0].created).toBeUndefined();
		expect(notes[0].attributes).toEqual({});
	});

	it('handles content split across multiple stream chunks', async () => {
		const xml = wrap(
			`<note><title>Chunky</title><content><![CDATA[<en-note><div>split here</div></en-note>]]></content></note>`
		);
		const chunks = [xml.slice(0, 120), xml.slice(120, 250), xml.slice(250)];
		const out = [];
		for await (const n of parseEnex(Readable.from(chunks))) out.push(n);
		expect(out).toHaveLength(1);
		expect(out[0].title).toBe('Chunky');
		expect(out[0].enml).toContain('split here');
	});
});
