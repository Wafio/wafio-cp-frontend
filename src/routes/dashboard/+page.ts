// /dashboard has no page of its own; send it to the project list.
import { redirect } from '@sveltejs/kit';
import { base } from '#lib/paths.js';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  redirect(301, `${base}/projects`);
};
