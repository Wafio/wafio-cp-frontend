// The integration guide is the Overview "Get started" checklist now;
// ?setup=1 keeps the checklist open even when every step is done.
import { redirect } from '@sveltejs/kit';
import { base } from '#lib/paths.js';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
  redirect(301, `${base}/projects/${params.id}?setup=1`);
};
