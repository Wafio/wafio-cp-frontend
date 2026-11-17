/**
 * Application and WAF agent inventory helpers.
 *
 * - One active agent binding per application: the agent routes are indexed
 *   by application id so the Applications list can show who serves what.
 * - The state of an application in one word, with a tone from its own
 *   family (Block mode is never the ALLOW green).
 * - The 409 AGENT_ONLINE refusal of an agent delete, which the WAF agents
 *   page turns into a confirmed forced retry.
 * - The WAF agent run command shown after registering an agent.
 *
 * Pure, unit-tested in web/tests/apps-inventory.test.ts.
 */
import type { AgentRoute, ApiError, App, FleetAgent } from '../../api';
import type { BadgeTone } from '../../tone';
import { listenLabel, parseUpstream, type ProtectionMode } from './route-model';

// ── Bindings ────────────────────────────────────────────────────────────────

export interface AppBinding {
  agentId: string;
  agentName: string;
  online: boolean;
  mode: ProtectionMode;
  route: AgentRoute;
}

export interface AgentRoutes {
  agent: Pick<FleetAgent, 'id' | 'name' | 'is_online'>;
  routes: readonly AgentRoute[];
}

/** Application id → the agent route that serves it. */
export function bindingIndex(entries: readonly AgentRoutes[]): Map<string, AppBinding> {
  const index = new Map<string, AppBinding>();
  for (const { agent, routes } of entries) {
    for (const route of routes) {
      // The server keeps one active binding per application; if two agents
      // ever report the same app, the first (inventory order) wins.
      if (index.has(route.app_id)) continue;
      index.set(route.app_id, {
        agentId: agent.id,
        agentName: agent.name,
        online: agent.is_online,
        mode: route.mode === 'monitor' ? 'monitor' : 'block',
        route,
      });
    }
  }
  return index;
}

// ── Application state ──────────────────────────────────────────────────────

export type AppState = 'block' | 'monitor' | 'unassigned' | 'draft';

export const APP_STATE_TEXT: Record<AppState, { label: string; tone: BadgeTone; hint: string }> = {
  block: { label: 'Block mode', tone: 'mode-block', hint: 'Served by a WAF agent; requests with a strong detection are rejected.' },
  monitor: { label: 'Monitor mode', tone: 'mode-monitor', hint: 'Served by a WAF agent; attacks are logged, nothing is blocked.' },
  unassigned: { label: 'Unassigned', tone: 'warning', hint: 'Routing is set but no WAF agent serves it, so its traffic is not inspected.' },
  draft: { label: 'Draft', tone: 'neutral', hint: 'No upstream or listen port yet.' },
};

export function appState(app: Pick<App, 'upstream_url' | 'listen_port'>, binding?: Pick<AppBinding, 'mode'> | { mode: string } | null): AppState {
  if (binding) return binding.mode === 'monitor' ? 'monitor' : 'block';
  const routed = Boolean((app.upstream_url ?? '').trim()) && typeof app.listen_port === 'number' && app.listen_port > 0;
  return routed ? 'unassigned' : 'draft';
}

/** "0.0.0.0:8080 → http://127.0.0.1:3000", or null when the app has no routing. */
export function routeSummary(
  listenHost: string | null | undefined,
  listenPort: number | null | undefined,
  upstream: string | null | undefined,
): string | null {
  const target = (upstream ?? '').trim();
  if (!target && !listenPort) return null;
  const parsed = parseUpstream(target);
  const shown = parsed.type === 'fcgi' ? `FastCGI ${parsed.addr}` : parsed.addr;
  return `${listenPort ? listenLabel(listenHost, listenPort) : 'no listen port'} → ${shown || 'no upstream'}`;
}

// ── Agent delete ────────────────────────────────────────────────────────────

/** The server refused to delete a running agent; a forced retry is possible. */
export function isAgentOnlineRefusal(error: ApiError | undefined | null): boolean {
  return Boolean(error && error.status === 409 && error.code === 'AGENT_ONLINE');
}

/** Message for a failed agent delete. */
export function agentDeleteError(error: ApiError): string {
  if (error.status === 403) return 'Deleting agents needs member or owner access in this project.';
  if (error.status === 404) return 'The agent no longer exists. Refresh the inventory.';
  return error.error || 'Could not delete the agent.';
}

// ── Registration ───────────────────────────────────────────────────────────

/** Text for a shell comment: control characters would end it. */
function commentText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

/**
 * Commands that install a newly registered WAF agent with the installer
 * (install.sh at the top of the WAF agent release bundle). The installer asks
 * for the control plane address (gRPC on :9090, the host this dashboard is
 * served from), the agent name and the certificate paths, writes the agent's
 * environment file and systemd unit, and fetches the security data. The agent
 * binary takes no other flags to start: the unit and the environment file carry
 * them. `WAFIO_HOST_KEY` is optional (agents on a registered host) and therefore
 * not part of the template.
 */
export function wafAgentInstall(agentName: string, controlPlaneHost: string): string {
  const host = commentText(controlPlaneHost) || 'wafio.example.com';
  return [
    '# On the agent host, in the unpacked WAF agent release:',
    'sudo bash install.sh',
    '# The installer asks for:',
    `#   control plane address  ${host}:9090`,
    `#   agent name             ${commentText(agentName)}`,
    '#   certificate paths      accept the defaults in /etc/wafio/certs/waf/',
  ].join('\n');
}

/** Agent names the register form accepts (required, at most 64 characters). */
export function validateAgentName(name: string): string | null {
  const value = name.trim();
  if (!value) return 'Enter a name for the agent.';
  if (value.length > 64) return 'Agent name must be at most 64 characters.';
  return null;
}
