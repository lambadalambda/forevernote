import { Parser } from 'htmlparser2';

export interface ResourceRef {
	url: string;
	mime: string;
	fileName?: string;
}
export type ResourceLookup = (hash: string) => ResourceRef | undefined;

export interface RenderedNote {
	/** Sanitised HTML, always wrapped in <div class="en-note">. */
	html: string;
	/** Plain text for full-text search. */
	text: string;
}

const VOID = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'source',
	'track',
	'wbr'
]);
const BLOCK = new Set([
	'div',
	'p',
	'br',
	'li',
	'tr',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'table',
	'ul',
	'ol',
	'pre',
	'blockquote',
	'hr',
	'en-note'
]);
const DROP = new Set([
	'script',
	'style',
	'iframe',
	'object',
	'embed',
	'svg',
	'math',
	'form',
	'button',
	'meta',
	'base',
	'link',
	'template'
]);
/** Browsers strip C0 controls and whitespace inside the scheme, so we do too before checking. */
const isBadUrl = (v: string) => {
	const clean = v.replace(/[\u0000-\u0020]/g, '');
	return (
		/^(javascript|vbscript):/i.test(clean) ||
		(/^data:/i.test(clean) && !/^data:image\//i.test(clean))
	);
};

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');

const attrString = (attrs: Record<string, string>) =>
	Object.entries(attrs)
		.filter(([k, v]) => !k.startsWith('on') && !isBadUrl(v))
		.map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escAttr(v)}"`))
		.join('');

const pick = (attrs: Record<string, string>, keys: string[]) =>
	Object.fromEntries(keys.filter((k) => k in attrs).map((k) => [k, attrs[k]]));

const openTag = (name: string, attrs: Record<string, string>) => `<${name}${attrString(attrs)}>`;

const renderMedia = (attrs: Record<string, string>, lookup: ResourceLookup) => {
	const hash = attrs.hash ?? '';
	const ref = lookup(hash);
	if (!ref)
		return {
			html: `<span class="en-missing" data-hash="${escAttr(hash)}">missing attachment</span>`,
			text: ''
		};
	if (ref.mime.startsWith('image/')) {
		const a = {
			src: ref.url,
			...pick(attrs, ['alt', 'title', 'width', 'height', 'style']),
			'data-hash': hash
		};
		return { html: openTag('img', a), text: attrs.alt ?? '' };
	}
	const name = ref.fileName ?? hash;
	const a = { class: 'en-attachment', href: ref.url, 'data-mime': ref.mime, 'data-hash': hash };
	return { html: `${openTag('a', a)}${escText(name)}</a>`, text: name };
};

const collapseText = (parts: string[]) =>
	parts
		.join('')
		.split('\n')
		.map((l) => l.replace(/\s+/g, ' ').trim())
		.filter(Boolean)
		.join('\n');

/**
 * Converts ENML (or already-rendered / browser-edited HTML) into sanitised HTML
 * plus a plain-text version. Idempotent on its own output.
 */
export const renderNoteHtml = (input: string, lookup: ResourceLookup): RenderedNote => {
	const out: string[] = [];
	const text: string[] = [];
	const stack: string[] = [];
	let skip = 0; // >0 while inside a dropped subtree
	let topLevel = 0;
	let firstIsRoot = false;

	const parser = new Parser(
		{
			onopentag(name, attrs) {
				if (stack.length === 0) {
					topLevel++;
					if (topLevel === 1)
						firstIsRoot = name === 'en-note' || (name === 'div' && attrs.class === 'en-note');
				}
				stack.push(name);
				if (skip) return void skip++;
				if (BLOCK.has(name)) text.push('\n');
				if (DROP.has(name)) return void (skip = 1);
				if (name === 'en-crypt') {
					out.push('<span class="en-crypt">encrypted content</span>');
					return void (skip = 1);
				}
				if (name === 'en-note') return void out.push('<div class="en-note">');
				if (name === 'en-media') {
					const r = renderMedia(attrs, lookup);
					out.push(r.html);
					text.push(r.text);
					return;
				}
				if (name === 'en-todo') {
					const a: Record<string, string> = { type: 'checkbox', class: 'en-todo' };
					if (attrs.checked === 'true' || attrs.checked === '') a.checked = '';
					return void out.push(openTag('input', a));
				}
				out.push(openTag(name, attrs));
			},
			ontext(t) {
				if (skip) return;
				if (stack.length === 0 && !t.trim()) return;
				if (stack.length === 0) topLevel++;
				out.push(escText(t));
				text.push(t);
			},
			onclosetag(name) {
				stack.pop();
				if (skip) return void skip--;
				if (BLOCK.has(name)) text.push('\n');
				else if (name === 'td' || name === 'th') text.push(' ');
				if (name === 'en-note') return void out.push('</div>');
				if (name === 'en-media' || name === 'en-todo' || VOID.has(name)) return;
				out.push(`</${name}>`);
			}
		},
		{
			decodeEntities: true,
			recognizeSelfClosing: true,
			lowerCaseTags: true,
			lowerCaseAttributeNames: true
		}
	);
	parser.write(input);
	parser.end();

	const body = out.join('');
	const html = topLevel === 1 && firstIsRoot ? body : `<div class="en-note">${body}</div>`;
	return { html, text: collapseText(text) };
};

const NOTE_OPEN = '<div class="en-note">';
const NOTE_CLOSE = '</div>';

/**
 * Appends a fragment to a rendered note body, inside the wrapper rather than after it.
 * Appending naively leaves two top-level nodes, which renderNoteHtml then wraps again,
 * so every attachment would nest the body one level deeper.
 */
export const appendToNoteBody = (html: string, fragment: string): string => {
	const trimmed = html.trim();
	if (trimmed.startsWith(NOTE_OPEN) && trimmed.endsWith(NOTE_CLOSE)) {
		const inner = trimmed.slice(NOTE_OPEN.length, -NOTE_CLOSE.length);
		return `${NOTE_OPEN}${inner}${fragment}${NOTE_CLOSE}`;
	}
	return trimmed + fragment;
};
