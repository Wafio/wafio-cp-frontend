// The orphan fleet page was removed. Host agents are managed
// under Hosts (host key, host detail), WAF agents under WAF agents.
import { redirect } from '@sveltejs/kit';
import { base } from '#lib/paths.js';
import { legacyAgentsTarget } from '#lib/shell-nav.js';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params, url }) => {
  redirect(301, `${base}${legacyAgentsTarget(params.id, url.searchParams)}`);
};
