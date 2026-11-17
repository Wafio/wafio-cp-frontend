// The application page moved to /projects/:id/apps/:appId.
// The old per-agent URL was keyed by a mutable assignment, so a reload after
// reassigning showed "Application not found"; it now redirects, keeping the
// tab and every other query parameter.
import { redirect } from '@sveltejs/kit';
import { base } from '#lib/paths.js';
import { legacyAppRedirect } from '#lib/components/apps/app-page.js';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params, url }) => {
  redirect(308, legacyAppRedirect(base, params.id, params.appId, url.search));
};
