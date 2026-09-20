import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/instance';
import { getResource } from '$lib/server/notes';

const INERT = /^(application\/pdf|image\/(png|jpeg|gif|webp|bmp))$/;

export const GET: RequestHandler = ({ params, url }) => {
	const r = getResource(getDb(), params.hash);
	if (!r) error(404, 'resource not found');
	const disposition = url.searchParams.has('download') ? 'attachment' : 'inline';
	const name = encodeURIComponent(r.fileName ?? params.hash);
	return new Response(r.data as BodyInit, {
		headers: {
			'content-type': r.mime,
			'content-length': String(r.data.byteLength),
			'content-disposition': `${disposition}; filename*=UTF-8''${name}`,
			'cache-control': 'private, max-age=31536000, immutable',
			'x-content-type-options': 'nosniff',
			// Known-inert types render normally; anything else (html, svg, xml…) is isolated on an
			// opaque origin so it can never run as same-origin content.
			...(INERT.test(r.mime) ? {} : { 'content-security-policy': 'sandbox' })
		}
	});
};
