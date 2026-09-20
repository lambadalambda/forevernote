/** Vision-LLM transcription through an OpenAI-compatible server (Lemonade or llama-server). */
import { basename } from 'node:path';

export interface LlmOptions {
	baseUrl: string;
	model: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
	/**
	 * Let the model reason before answering. Off by default: for transcription it adds no
	 * accuracy and can eat the whole token budget before any text is emitted.
	 */
	thinking?: boolean;
}

export const DEFAULT_LLM = {
	// Either a Lemonade server (the Mac) or a plain llama-server (the NAS); both speak the
	// OpenAI chat API. LEMONADE_* are kept as aliases for the older local setup.
	baseUrl:
		process.env.FOREVERNOTE_LLM_URL ?? process.env.LEMONADE_URL ?? 'http://127.0.0.1:13305/api/v1',
	model:
		process.env.FOREVERNOTE_LLM_MODEL ?? process.env.LEMONADE_MODEL ?? 'Gemma-4-26B-A4B-it-GGUF'
};

const PROMPT =
	'Transcribe all text in this image exactly as written, preserving line breaks and reading order. ' +
	'Output plain text only: no markdown, no tables (write each table row as one line with the cells ' +
	'separated by spaces), no commentary. If the image contains no text, output nothing.';

/** Max consecutive identical lines before we assume the model is looping. */
const MAX_REPEATS = 3;

/**
 * Detects degenerate repetition (the model emitting the same line over and over) and cuts the
 * text just before it starts. Blank lines are never counted.
 */
export const stripRepetition = (text: string, maxRepeats = MAX_REPEATS) => {
	const lines = text.split('\n');
	let prev = '';
	let run = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === '') {
			run = 0;
			continue;
		}
		run = line === prev ? run + 1 : 1;
		prev = line;
		if (run > maxRepeats)
			return {
				text: lines
					.slice(0, i - maxRepeats)
					.join('\n')
					.trimEnd(),
				looped: true
			};
	}
	return { text, looped: false };
};

const NOISE_MIN_CHARS = 1500;
const NOISE_MAX_LETTER_RATIO = 0.05;

/** Long output with almost no letters: digit sheets (TAN lists, dot-matrix noise). Not worth indexing. */
export const looksLikeNoise = (text: string) =>
	text.length >= NOISE_MIN_CHARS &&
	(text.match(/\p{L}/gu)?.length ?? 0) / text.length < NOISE_MAX_LETTER_RATIO;

/** Reads an SSE chat-completion stream, stopping early when the model loops or emits noise. */
const readStream = async (res: Response): Promise<string> => {
	if (!res.body) throw new Error('llm returned no content');
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let text = '';
	let sawChunk = false;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const raw of lines) {
				const line = raw.trim();
				if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
				let json: { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
				try {
					json = JSON.parse(line.slice(5));
				} catch {
					continue;
				}
				if (json.error)
					throw new Error(`llm error: ${json.error.message ?? JSON.stringify(json.error)}`);
				sawChunk = true;
				text += json.choices?.[0]?.delta?.content ?? '';
			}
			if (looksLikeNoise(text)) {
				await reader.cancel();
				return '';
			}
			const check = stripRepetition(text);
			if (check.looped) {
				await reader.cancel();
				return check.text;
			}
		}
	} finally {
		reader.releaseLock();
	}
	if (!sawChunk) throw new Error('llm returned no content');
	return text;
};

/** Answers models give for blank pages; treated as empty text. */
const NO_TEXT = /^\s*[[(]?\s*(no|kein)\s+(text|readable)[^\n]*[\])]?\s*$/i;

export const transcribeImage = async (
	data: Uint8Array,
	mime: string,
	{ baseUrl, model, fetch: f = fetch, timeoutMs = 300_000, thinking = false }: LlmOptions
): Promise<string> => {
	const url = `data:${mime};base64,${Buffer.from(data).toString('base64')}`;
	const res = await f(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		signal: AbortSignal.timeout(timeoutMs),
		body: JSON.stringify({
			model,
			temperature: 0,
			max_tokens: 2500,
			stream: true,
			...(thinking ? {} : { reasoning_effort: 'none' }),
			chat_template_kwargs: { enable_thinking: thinking },
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: PROMPT },
						{ type: 'image_url', image_url: { url } }
					]
				}
			]
		})
	});
	if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const text = (await readStream(res)).trim();
	return NO_TEXT.test(text) ? '' : text;
};

/** Sends a text-only prompt and returns the reply. Used for titling and tagging. */
export const chatText = async (
	prompt: string,
	{ baseUrl, model, fetch: f = fetch, timeoutMs = 180_000, thinking = false }: LlmOptions
): Promise<string> => {
	const res = await f(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		signal: AbortSignal.timeout(timeoutMs),
		body: JSON.stringify({
			model,
			temperature: 0,
			max_tokens: 400,
			stream: true,
			...(thinking ? {} : { reasoning_effort: 'none' }),
			chat_template_kwargs: { enable_thinking: thinking },
			messages: [{ role: 'user', content: prompt }]
		})
	});
	if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return (await readStream(res)).trim();
};

/** Is the server reachable and does it know the model? */
export const llmAvailable = async ({ baseUrl, model, fetch: f = fetch }: LlmOptions) => {
	try {
		const res = await f(`${baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) return false;
		// Lemonade lists models under `data` with an `id`; llama-server answers with both keys
		// and echoes the absolute path it was started with, so compare on the file name.
		const body = (await res.json()) as {
			data?: { id?: string }[];
			models?: { name?: string }[];
		};
		const names = [
			...(body.data ?? []).map((m) => m.id),
			...(body.models ?? []).map((m) => m.name)
		].filter((n): n is string => !!n);
		if (names.length === 0) return false;
		// A server holding a single model is ready whatever that model happens to be called.
		if (new Set(names.map((n) => basename(n))).size === 1) return true;
		return names.some((n) => n === model || basename(n) === basename(model));
	} catch {
		return false;
	}
};

export interface ExtractedPage {
	/** Text layer, or Vision OCR when the page had none. */
	text: string;
	/** Rendered image of the page when it had no text layer, else null. */
	image: string | null;
}
export type TextSource = 'layer' | 'vision' | 'llm';

/** Vision text longer than this on a page the model called empty means the model call went wrong. */
const SUSPICIOUS_EMPTY_CHARS = 200;

/**
 * Merges page texts: pages with an image go through the model, falling back to their Vision
 * text if that fails or looks wrong. The source is the "weakest" method that contributed.
 */
export const combinePages = async (
	pages: ExtractedPage[],
	transcribe: (imagePath: string) => Promise<string>
): Promise<{ text: string; source: TextSource }> => {
	let source: TextSource = 'layer';
	const texts: string[] = [];
	for (const page of pages) {
		if (!page.image) {
			texts.push(page.text);
			continue;
		}
		try {
			let text = await transcribe(page.image);
			const suspicious = () => !text.trim() && page.text.trim().length > SUSPICIOUS_EMPTY_CHARS;
			if (suspicious()) text = await transcribe(page.image);
			if (suspicious()) throw new Error('model returned nothing for a page with text');
			texts.push(text);
			if (source === 'layer') source = 'llm';
		} catch {
			texts.push(page.text);
			source = 'vision';
		}
	}
	return { text: texts.join('\n'), source };
};
