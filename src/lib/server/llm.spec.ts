import { describe, expect, it, vi } from 'vitest';
import {
	chatText,
	combinePages,
	llmAvailable,
	looksLikeNoise,
	stripRepetition,
	transcribeImage
} from './llm.ts';

/** Mocks a streaming chat completion: each chunk becomes one SSE data line. */
const sse = (chunks: string[]) =>
	[
		...chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}`),
		'data: [DONE]'
	]
		.map((l) => l + '\n\n')
		.join('');
const okFetch = (...chunks: string[]) =>
	vi.fn(
		async () => new Response(sse(chunks), { headers: { 'content-type': 'text/event-stream' } })
	);

describe('transcribeImage', () => {
	it('posts an OpenAI-style vision request with thinking disabled and returns the trimmed text', async () => {
		const fetch = okFetch('  Hello\nWorld \n');
		const text = await transcribeImage(new Uint8Array([1, 2, 3]), 'image/png', {
			baseUrl: 'http://x/api/v1',
			model: 'm',
			fetch
		});
		expect(text).toBe('Hello\nWorld');
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://x/api/v1/chat/completions');
		const body = JSON.parse(init.body as string);
		expect(body.model).toBe('m');
		expect(body.temperature).toBe(0);
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(body.stream).toBe(true);
		expect(body.messages[0].content[1].image_url.url).toBe('data:image/png;base64,AQID');
	});

	it('can enable thinking, which the default disables', async () => {
		const fetch = okFetch('text');
		await transcribeImage(new Uint8Array(), 'image/png', {
			baseUrl: 'http://x',
			model: 'm',
			thinking: true,
			fetch
		});
		const body = JSON.parse(
			(fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string
		);
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
		expect(body.reasoning_effort).toBeUndefined();
	});

	it('throws on http errors and on empty responses', async () => {
		const bad = vi.fn(async () => new Response('nope', { status: 500 }));
		await expect(
			transcribeImage(new Uint8Array(), 'image/png', {
				baseUrl: 'http://x',
				model: 'm',
				fetch: bad
			})
		).rejects.toThrow(/500/);
		const empty = vi.fn(async () => new Response(JSON.stringify({ choices: [] })));
		await expect(
			transcribeImage(new Uint8Array(), 'image/png', {
				baseUrl: 'http://x',
				model: 'm',
				fetch: empty
			})
		).rejects.toThrow(/no content/);
	});

	it('throws when the stream carries an error object', async () => {
		const fetch = vi.fn(
			async () => new Response('data: {"error":{"message":"slot unavailable"}}\n\ndata: [DONE]\n\n')
		);
		await expect(
			transcribeImage(new Uint8Array(), 'image/png', { baseUrl: 'http://x', model: 'm', fetch })
		).rejects.toThrow(/slot unavailable/);
	});

	it('treats a "no text" answer as empty', async () => {
		const fetch = okFetch('[No text in image]');
		expect(
			await transcribeImage(new Uint8Array(), 'image/png', {
				baseUrl: 'http://x',
				model: 'm',
				fetch
			})
		).toBe('');
	});

	it('stops reading once the model starts looping and drops the repeated tail', async () => {
		const chunks = ['Header\n', 'Total 5\n', ...Array(40).fill('| | |\n')];
		const fetch = okFetch(...chunks);
		const text = await transcribeImage(new Uint8Array(), 'image/png', {
			baseUrl: 'http://x',
			model: 'm',
			fetch
		});
		expect(text).toBe('Header\nTotal 5');
	});
});

describe('transcribeImage noise guard', () => {
	it('gives up on pages that are digit soup (e.g. TAN lists) and stores nothing', async () => {
		const chunks = ['Konto 123\n', ...Array(60).fill('4839201 5573920 1029384 7465102\n')];
		const fetch = okFetch(...chunks);
		const text = await transcribeImage(new Uint8Array(), 'image/png', {
			baseUrl: 'http://x',
			model: 'm',
			fetch
		});
		expect(text).toBe('');
	});
});

describe('looksLikeNoise', () => {
	it('flags long, nearly letter-free output but not short or normal text', () => {
		expect(looksLikeNoise('12 34 56')).toBe(false);
		expect(looksLikeNoise('Rechnung 12345 '.repeat(200))).toBe(false);
		expect(looksLikeNoise('9384750 1029384 '.repeat(120))).toBe(true);
	});
});

describe('stripRepetition', () => {
	it('leaves normal text alone, including blank lines', () => {
		const t = 'a\nb\n\nc\n\n\nd';
		expect(stripRepetition(t)).toEqual({ text: t, looped: false });
	});
	it('cuts at the first line repeated more than maxRepeats times in a row', () => {
		expect(stripRepetition('x\ny\ny\ny\ny\ny\nz', 3)).toEqual({ text: 'x', looped: true });
	});
	it('tolerates legitimate short repeats', () => {
		expect(stripRepetition('x\ny\ny\ny\nz', 3)).toEqual({ text: 'x\ny\ny\ny\nz', looped: false });
	});
});

describe('chatText', () => {
	it('sends a plain text prompt with thinking off and returns the reply', async () => {
		const fetch = okFetch('{"title":"x"}');
		const out = await chatText('classify this', { baseUrl: 'http://x', model: 'm', fetch });
		expect(out).toBe('{"title":"x"}');
		const body = JSON.parse(
			(fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string
		);
		expect(body.messages).toEqual([{ role: 'user', content: 'classify this' }]);
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(body.stream).toBe(true);
	});

	it('propagates server errors so the job can be retried', async () => {
		const bad = vi.fn(async () => new Response('busy', { status: 503 }));
		await expect(chatText('x', { baseUrl: 'http://x', model: 'm', fetch: bad })).rejects.toThrow(
			/503/
		);
	});
});

describe('llmAvailable', () => {
	it('accepts the OpenAI shape', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'm' }] })));
		expect(await llmAvailable({ baseUrl: 'http://x', model: 'm', fetch })).toBe(true);
	});

	it("accepts llama-server's shape, which reports ids as absolute file paths", async () => {
		// llama-server answers with both keys and echoes the path it was started with.
		const body = { models: [{ name: '/models/dir/m.gguf' }], data: [{ id: '/models/dir/m.gguf' }] };
		const fetch = vi.fn(async () => new Response(JSON.stringify(body)));
		expect(await llmAvailable({ baseUrl: 'http://x', model: 'm.gguf', fetch })).toBe(true);
	});

	it('is true when the one loaded model is named something else entirely', async () => {
		const body = { models: [{ name: '/models/other.gguf' }], data: [{ id: '/models/other.gguf' }] };
		const fetch = vi.fn(async () => new Response(JSON.stringify(body)));
		expect(await llmAvailable({ baseUrl: 'http://x', model: 'm.gguf', fetch })).toBe(true);
	});

	it('needs the requested model by name when several are served', async () => {
		const body = { data: [{ id: 'a.gguf' }, { id: 'b.gguf' }] };
		const fetch = vi.fn(async () => new Response(JSON.stringify(body)));
		expect(await llmAvailable({ baseUrl: 'http://x', model: 'b.gguf', fetch })).toBe(true);
		expect(await llmAvailable({ baseUrl: 'http://x', model: 'c.gguf', fetch })).toBe(false);
	});

	it('is false when the server is unreachable or lists nothing', async () => {
		const down = vi.fn(async () => {
			throw new Error('ECONNREFUSED');
		});
		expect(await llmAvailable({ baseUrl: 'http://x', model: 'm', fetch: down })).toBe(false);
		const empty = vi.fn(async () => new Response(JSON.stringify({ models: [], data: [] })));
		expect(await llmAvailable({ baseUrl: 'http://x', model: 'm', fetch: empty })).toBe(false);
	});
});

describe('combinePages', () => {
	it('uses the model text for image pages and keeps layer text for the rest, reporting the source', async () => {
		const transcribe = vi.fn(async (path: string) => `LLM(${path})`);
		const result = await combinePages(
			[
				{ text: 'layer one', image: null },
				{ text: 'vision two', image: '/tmp/p2.jpg' },
				{ text: '', image: '/tmp/p3.jpg' }
			],
			transcribe
		);
		expect(result).toEqual({
			text: 'layer one\nLLM(/tmp/p2.jpg)\nLLM(/tmp/p3.jpg)',
			source: 'llm'
		});
	});

	it('falls back to the vision text when the model fails, and reports vision as the source', async () => {
		const transcribe = vi.fn(async () => {
			throw new Error('down');
		});
		const result = await combinePages([{ text: 'vision', image: '/tmp/p.jpg' }], transcribe);
		expect(result).toEqual({ text: 'vision', source: 'vision' });
	});

	it('retries once when the model returns nothing for a page Vision read plenty from, then falls back', async () => {
		const vision = 'x'.repeat(300);
		const transcribe = vi.fn(async () => '');
		expect(await combinePages([{ text: vision, image: '/tmp/p.jpg' }], transcribe)).toEqual({
			text: vision,
			source: 'vision'
		});
		expect(transcribe).toHaveBeenCalledTimes(2);
		const flaky = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('second try');
		expect(await combinePages([{ text: vision, image: '/tmp/p.jpg' }], flaky)).toEqual({
			text: 'second try',
			source: 'llm'
		});
	});

	it('accepts an empty model answer for pages Vision also found (nearly) empty', async () => {
		const transcribe = vi.fn(async () => '');
		expect(await combinePages([{ text: 'a b', image: '/tmp/p.jpg' }], transcribe)).toEqual({
			text: '',
			source: 'llm'
		});
		expect(transcribe).toHaveBeenCalledTimes(1);
	});

	it('reports layer when no page needed a model', async () => {
		const transcribe = vi.fn();
		expect(await combinePages([{ text: 'a', image: null }], transcribe)).toEqual({
			text: 'a',
			source: 'layer'
		});
		expect(transcribe).not.toHaveBeenCalled();
	});

	it('reports layer for empty pages without images', async () => {
		expect(await combinePages([], vi.fn())).toEqual({ text: '', source: 'layer' });
	});
});
