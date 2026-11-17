/**
 * Loads every row of GET /hosts/fleet (pages of 100) plus the fleet-wide
 * fields of the last page (control-plane version, unlinked host agents).
 */
import { listHostFleet, type FleetHost } from '#lib/api.js';
import { fetchAllHosts } from '#lib/host-nav.js';

export interface FleetLoad {
  hosts: FleetHost[] | null;
  error: string | null;
  controlPlaneVersion: string;
  unlinkedHostAgents: number;
  generatedAt: string | null;
}

export async function loadFleet(projectId: string, isStale: () => boolean = () => false): Promise<FleetLoad> {
  let controlPlaneVersion = '';
  let unlinkedHostAgents = 0;
  let generatedAt: string | null = null;
  const result = await fetchAllHosts<FleetHost>(async (page) => {
    const res = await listHostFleet(projectId, page);
    if (res.data) {
      controlPlaneVersion = res.data.control_plane_version ?? '';
      unlinkedHostAgents = res.data.unlinked_host_agents ?? 0;
      generatedAt = res.data.generated_at ?? null;
    }
    return res;
  }, isStale);
  return { hosts: result.hosts, error: result.error, controlPlaneVersion, unlinkedHostAgents, generatedAt };
}
