/**
 * Viewer redaction of stored credentials.
 *
 * Config and app reads by a caller below member blank the credential fields
 * (SIEM webhook URL, challenge secret, path-exception AES keys, proxy header
 * values) and set `secrets_redacted` plus a `<field>_set` flag. The UI shows
 * such a field as "Configured (hidden)" instead of an empty input, and a form
 * holding redacted values is never saved (the blanks would overwrite the
 * real secrets).
 */

export const HIDDEN_SECRET_TEXT = 'Configured (hidden)';

/**
 * True when a secret field is blank only because the server redacted it:
 * the read was redacted, the server says a value is configured, and the
 * field holds nothing.
 */
export function isHiddenSecret(
  redacted: boolean | null | undefined,
  configured: boolean | null | undefined,
  value: string | null | undefined
): boolean {
  return redacted === true && configured === true && !value;
}

/** True when a response carries redacted credentials, so a save must not send it back. */
export function hasRedactedSecrets(...sources: ({ secrets_redacted?: boolean } | null | undefined)[]): boolean {
  return sources.some((source) => source?.secrets_redacted === true);
}
