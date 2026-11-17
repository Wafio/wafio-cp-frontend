// Back-link labels for PageHeader (link text names its target).

const ARROW = /^\s*←\s*/;

function pathOf(href: string): string {
  return href.split(/[?#]/)[0].replace(/\/+$/, '');
}

/**
 * Label derived from the target when the caller gave none:
 * `/projects/<id>` → "← Overview", `/projects` → "← Projects".
 * Any other target needs an explicit label, so undefined is returned.
 */
export function defaultBackLabel(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  const path = pathOf(href);
  if (/\/projects\/[^/]+$/.test(path)) return '← Overview';
  if (/(^|\/)projects$/.test(path)) return '← Projects';
  return undefined;
}

/** The label text without its leading arrow (the arrow is rendered aria-hidden). */
export function backLabelText(label: string): string {
  return label.replace(ARROW, '').trim();
}
