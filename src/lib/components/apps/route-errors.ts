/**
 * 409 answers of application and route writes: the server tells a
 * taken listen address (LISTEN_HOST_TAKEN, another application on the same
 * WAF agent) apart from a duplicate application name (CONFLICT). Used by the
 * create flows, the Routing tab and the WAF-agent assignment.
 */

import { agentRefusalText } from './speed';

export interface AppWriteError {
  error?: string;
  code?: string;
  status?: number;
  /** AGENT_TOO_OLD, FEATURE_UNSUPPORTED: the agent and the parts it cannot run. */
  agent?: string;
  feature?: string;
  parts?: string[];
}

export const LISTEN_HOST_TAKEN_MESSAGE =
  'Another application on this WAF agent already uses this listen address. Choose another host or port.';
export const APP_NAME_TAKEN_MESSAGE = 'An application with this name already exists in this project.';

/**
 * Message for a failed application/route write. `nameHint` is appended to the
 * duplicate-name message (e.g. how to assign the existing app instead).
 */
export function appWriteErrorMessage(err: AppWriteError | null | undefined, fallback: string, nameHint = ''): string {
  if (err?.code === 'LISTEN_HOST_TAKEN') return LISTEN_HOST_TAKEN_MESSAGE;
  // The path prefix is the only setting of an application write that an agent can be too old for.
  const agentText = agentRefusalText(err, 'the path prefix');
  if (agentText) return agentText;
  if (err?.code === 'CONFLICT') return nameHint ? `${APP_NAME_TAKEN_MESSAGE} ${nameHint}` : APP_NAME_TAKEN_MESSAGE;
  return err?.error || fallback;
}
