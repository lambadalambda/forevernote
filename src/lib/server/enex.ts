import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';

export interface EnexResource {
	hash: string;
	mime: string;
	data: Uint8Array;
	fileName?: string;
	width?: number;
	height?: number;
}

export interface EnexNote {
	title: string;
	created?: string;
	updated?: string;
	tags: string[];
	enml: string;
	attributes: Record<string, string>;
	resources: EnexResource[];
}

/** "20200503T194858Z" -> "2020-05-03T19:48:58.000Z" */
export const parseEnexDate = (s: string | undefined): string | undefined => {
	const m = s?.trim().match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
	if (!m) return undefined;
	const [, y, mo, d, h, mi, sec] = m;
	return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec)).toISOString();
};

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

const newNote = (): EnexNote => ({
	title: '',
	tags: [],
	enml: '',
	attributes: {},
	resources: []
});

const newResource = (): EnexResource => ({ hash: '', mime: '', data: new Uint8Array() });

const md5 = (data: Uint8Array) => createHash('md5').update(data).digest('hex');

/**
 * Streams an ENEX document and yields one note at a time.
 * Works on any async iterable of strings or byte chunks (e.g. a file stream).
 */
export async function* parseEnex(
	input: AsyncIterable<string | Uint8Array>
): AsyncGenerator<EnexNote> {
	const parser = new SaxesParser();
	const queue: EnexNote[] = [];
	const path: string[] = [];
	let note = newNote();
	let resource = newResource();
	let text: string[] = [];

	parser.on('opentag', (tag) => {
		path.push(tag.name);
		text = [];
		if (tag.name === 'note') note = newNote();
		if (tag.name === 'resource') resource = newResource();
	});
	parser.on('text', (t) => text.push(t));
	parser.on('cdata', (t) => text.push(t));
	parser.on('closetag', (tag) => {
		path.pop();
		const parent = path[path.length - 1];
		const value = text.join('');
		text = [];
		handleClose(parent, tag.name, value);
	});

	const handleClose = (parent: string | undefined, name: string, value: string) => {
		if (name === 'note') return void queue.push(note);
		if (name === 'resource') return void note.resources.push(resource);
		if (parent === 'note') {
			if (name === 'title') note.title = value.trim();
			else if (name === 'created') note.created = parseEnexDate(value);
			else if (name === 'updated') note.updated = parseEnexDate(value);
			else if (name === 'tag') note.tags.push(value.trim());
			else if (name === 'content') note.enml = value.trim();
		} else if (parent === 'note-attributes') {
			note.attributes[camel(name)] = value.trim();
		} else if (parent === 'resource') {
			if (name === 'data') {
				resource.data = Buffer.from(value.replace(/\s+/g, ''), 'base64');
				resource.hash = md5(resource.data);
			} else if (name === 'mime') resource.mime = value.trim();
			else if (name === 'width') resource.width = Number(value);
			else if (name === 'height') resource.height = Number(value);
		} else if (parent === 'resource-attributes' && name === 'file-name') {
			resource.fileName = value.trim();
		}
	};

	const decoder = new TextDecoder();
	for await (const chunk of input) {
		parser.write(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
		while (queue.length) yield queue.shift()!;
	}
	parser.close();
	while (queue.length) yield queue.shift()!;
}
