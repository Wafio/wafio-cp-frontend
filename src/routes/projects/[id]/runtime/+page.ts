// Short alias of the Runtime security page. The page itself still
// lives at /host/trace; the alias keeps the query (?host=<id>, ?tab=…).
import { redirect } from '@sveltejs/kit';
import { base } from '#lib/paths.js';
import { movedTo } from '#lib/shell-nav.js';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params, url }) => {
  redirect(307, movedTo(base, `/projects/${params.id}/host/trace`, url.search));
};
