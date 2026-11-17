// Profile moved to /account.
import { redirect } from '@sveltejs/kit';
import { base } from '#lib/paths.js';
import { movedTo } from '#lib/shell-nav.js';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url }) => {
  redirect(301, movedTo(base, '/account', url.search));
};
