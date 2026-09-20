import { describe, expect, it } from 'vitest';
import { appendToNoteBody, renderNoteHtml, type ResourceLookup } from './enml.ts';

const lookup: ResourceLookup = (hash) =>
	({
		img1: { url: '/api/resources/img1', mime: 'image/png', fileName: 'pic.png' },
		pdf1: { url: '/api/resources/pdf1', mime: 'application/pdf', fileName: 'doc.pdf' }
	})[hash];

const enml = (body: string) =>
	`<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note>${body}</en-note>`;

describe('renderNoteHtml', () => {
	it('strips prolog/doctype and turns en-note into a div', () => {
		const { html } = renderNoteHtml(enml('<div>Hi <b>there</b></div>'), lookup);
		expect(html).toBe('<div class="en-note"><div>Hi <b>there</b></div></div>');
	});

	it('renders image en-media as img and keeps size attributes', () => {
		const { html } = renderNoteHtml(
			enml('<en-media hash="img1" type="image/png" width="10" height="5" alt="x"/>'),
			lookup
		);
		expect(html).toContain(
			'<img src="/api/resources/img1" alt="x" width="10" height="5" data-hash="img1">'
		);
	});

	it('renders non-image en-media as an attachment link with the file name', () => {
		const { html } = renderNoteHtml(enml('<en-media hash="pdf1" type="application/pdf"/>'), lookup);
		expect(html).toContain(
			'<a class="en-attachment" href="/api/resources/pdf1" data-mime="application/pdf" data-hash="pdf1">doc.pdf</a>'
		);
	});

	it('renders a placeholder for unknown resources', () => {
		const { html } = renderNoteHtml(enml('<en-media hash="nope" type="image/png"/>'), lookup);
		expect(html).toContain('<span class="en-missing" data-hash="nope">missing attachment</span>');
	});

	it('renders en-todo as checkboxes', () => {
		const { html } = renderNoteHtml(
			enml('<en-todo checked="true"/>done<br/><en-todo/>todo'),
			lookup
		);
		expect(html).toContain('<input type="checkbox" class="en-todo" checked>done<br>');
		expect(html).toContain('<input type="checkbox" class="en-todo">todo');
	});

	it('renders en-crypt as an opaque placeholder', () => {
		const { html } = renderNoteHtml(enml('<en-crypt cipher="AES">ZZZ</en-crypt>'), lookup);
		expect(html).toContain('<span class="en-crypt">encrypted content</span>');
		expect(html).not.toContain('ZZZ');
	});

	it('escapes text and attribute values', () => {
		const { html } = renderNoteHtml(
			enml('<a href="?a=1&amp;b=2" title="&quot;q&quot;">x &lt; y</a>'),
			lookup
		);
		expect(html).toContain('<a href="?a=1&amp;b=2" title="&quot;q&quot;">x &lt; y</a>');
	});

	it('drops scripts, event handlers and javascript: urls', () => {
		const { html } = renderNoteHtml(
			'<div onclick="evil()">ok</div><script>evil()</script><a href="javascript:evil()">l</a>',
			lookup
		);
		expect(html).toBe('<div class="en-note"><div>ok</div><a>l</a></div>');
	});

	it('blocks javascript: urls obfuscated with control characters or entities', () => {
		const { html } = renderNoteHtml(
			'<a href="&#1;javascript:x()">a</a><a href="java&#9;script:x()">b</a><a href=" JAVASCRIPT:x()">c</a>',
			lookup
		);
		expect(html).toBe('<div class="en-note"><a>a</a><a>b</a><a>c</a></div>');
	});

	it('allows data:image urls (pasted images) but not other data: urls', () => {
		const { html } = renderNoteHtml(
			'<img src="data:image/png;base64,AAAA"><a href="data:text/html,x">l</a>',
			lookup
		);
		expect(html).toBe('<div class="en-note"><img src="data:image/png;base64,AAAA"><a>l</a></div>');
	});

	it('applies the url check to every attribute, not just href/src', () => {
		const { html } = renderNoteHtml('<div data-x="javascript:1" title="ok">t</div>', lookup);
		expect(html).toBe('<div class="en-note"><div title="ok">t</div></div>');
	});

	it('drops svg, math, form, button, meta, base, link and template subtrees', () => {
		const { html } = renderNoteHtml(
			'<svg><set attributeName="href" to="javascript:1"/></svg><math><maction>m</maction></math>' +
				'<form action="x"><button formaction="javascript:1">b</button></form>' +
				'<meta http-equiv="refresh" content="0"><base href="http://evil/"><link rel="x"><template>t</template>ok',
			lookup
		);
		expect(html).toBe('<div class="en-note">ok</div>');
	});

	it('is idempotent on its own output', () => {
		const src = enml(
			'<div>a<en-todo checked="true"/>b</div><en-media hash="img1" type="image/png"/><en-media hash="pdf1" type="application/pdf"/><ul><li>x &amp; y</li></ul>'
		);
		const once = renderNoteHtml(src, lookup);
		const twice = renderNoteHtml(once.html, lookup);
		expect(twice).toEqual(once);
	});

	it('separates table cells with spaces in the text', () => {
		const { text } = renderNoteHtml(
			enml('<table><tr><td>a</td><td>b</td></tr><tr><th>c</th></tr></table>'),
			lookup
		);
		expect(text).toBe('a b\nc');
	});

	it('accepts non-XML browser HTML (unclosed void tags) and wraps it', () => {
		const { html } = renderNoteHtml('<p>a<br>b</p><img src="/api/resources/img1">', lookup);
		expect(html).toBe('<div class="en-note"><p>a<br>b</p><img src="/api/resources/img1"></div>');
	});

	it('does not double-wrap an existing en-note div', () => {
		const { html } = renderNoteHtml('<div class="en-note"><p>a</p></div>', lookup);
		expect(html).toBe('<div class="en-note"><p>a</p></div>');
	});

	it('extracts plain text with line breaks at block boundaries', () => {
		const { text } = renderNoteHtml(
			enml('<div>one <b>two</b></div><p>three</p>four<br/>five<ul><li>six</li><li>seven</li></ul>'),
			lookup
		);
		expect(text).toBe('one two\nthree\nfour\nfive\nsix\nseven');
	});

	it('includes attachment file names in the text', () => {
		const { text } = renderNoteHtml(enml('<en-media hash="pdf1" type="application/pdf"/>'), lookup);
		expect(text).toBe('doc.pdf');
	});
});

describe('appendToNoteBody', () => {
	it('puts the fragment inside the note wrapper, not beside it', () => {
		const out = appendToNoteBody('<div class="en-note"><p>body</p></div>', '<en-media hash="x"/>');
		expect(out).toBe('<div class="en-note"><p>body</p><en-media hash="x"/></div>');
	});

	it('stays flat however many times it is applied', () => {
		let html = '<div class="en-note"><p>body</p></div>';
		for (const tag of ['<a/>', '<b/>', '<c/>']) html = appendToNoteBody(html, tag);
		expect(html.match(/class="en-note"/g)).toHaveLength(1);
		expect(html).toBe('<div class="en-note"><p>body</p><a/><b/><c/></div>');
	});

	it('handles a body that is not wrapped yet', () => {
		expect(appendToNoteBody('<p>body</p>', '<x/>')).toBe('<p>body</p><x/>');
		expect(appendToNoteBody('', '<x/>')).toBe('<x/>');
	});

	it('does not mistake a nested div for the wrapper', () => {
		const out = appendToNoteBody('<div class="en-note"><div>a</div><div>b</div></div>', '<x/>');
		expect(out).toBe('<div class="en-note"><div>a</div><div>b</div><x/></div>');
	});
});
