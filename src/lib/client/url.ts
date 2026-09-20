/** Returns a new query string with the given keys changed; null/empty removes a key. */
export const withParams = (
	search: string,
	changes: Record<string, string | number | null | undefined>
): string => {
	const p = new URLSearchParams(search);
	for (const [k, v] of Object.entries(changes)) {
		if (v === null || v === undefined || v === '') p.delete(k);
		else p.set(k, String(v));
	}
	const s = p.toString();
	return s ? `?${s}` : '/';
};

export const formatDate = (iso: string | undefined, timeZone?: string): string => {
	if (!iso) return '';
	const d = new Date(iso);
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	}).formatToParts(d);
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
	return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
};

export interface Debounced<A extends unknown[]> {
	(...args: A): void;
	flush(): void;
}

/** Trailing-edge debounce with a flush() that runs any pending call immediately. */
export const debounce = <A extends unknown[]>(
	fn: (...args: A) => void,
	ms: number
): Debounced<A> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: A | undefined;
	const run = () => {
		timer = undefined;
		if (!pending) return;
		const args = pending;
		pending = undefined;
		fn(...args);
	};
	const d = ((...args: A) => {
		pending = args;
		clearTimeout(timer);
		timer = setTimeout(run, ms);
	}) as Debounced<A>;
	d.flush = () => {
		clearTimeout(timer);
		run();
	};
	return d;
};
