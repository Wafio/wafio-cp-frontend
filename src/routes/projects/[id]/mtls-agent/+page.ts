// Moved to /projects/<id>/settings/credentials; old links and
// bookmarks keep working, query string included (?credential=<id>).
import { redirect } from '@sveltejs/kit';
import { base } from '#lib/paths.js';
import { movedTo } from '#lib/shell-nav.js';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params, url }) => {
  redirect(301, movedTo(base, `/projects/${params.id}/settings/credentials`, url.search));
};
