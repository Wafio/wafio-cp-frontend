/**
 * Policy save errors. A config save without rules_json is
 * refused with RULES_JSON_REQUIRED; one the strict save validator rejects
 * (a bot score threshold out of range, keys that differ only
 * in case, …) with INVALID_RULES. The server's message names the key path,
 * so the editor shows it verbatim under a title that says what happened.
 * A 400 with another code is shown the same way, with the server's message.
 */

export interface PolicySaveError {
  title?: string;
  message: string;
  code?: string;
}

const GENERIC = 'Could not save the policy. Your edits are kept; try again.';

export function policySaveError(message: string | null | undefined, code?: string, status?: number): PolicySaveError {
  const text = message?.trim() || GENERIC;
  switch (code) {
    case 'INVALID_RULES':
      return { title: 'The server rejected the policy. Nothing was saved.', message: text, code };
    case 'RULES_JSON_REQUIRED':
      return { title: 'The policy was not sent with the save. Nothing was saved.', message: text, code };
    default:
      // Any other 400 is a setting the server refuses: its own message says why, shown as it is.
      return status === 400 ? { title: 'The server refused this setting. Nothing was saved.', message: text, code } : { message: text, code };
  }
}
