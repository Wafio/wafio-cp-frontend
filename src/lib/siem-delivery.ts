export interface SIEMDelivery {
  accepted: number;
  delivered: number;
  failed: number;
  dropped: number;
  retried: number;
  queued: number;
  in_flight: number;
}

export function parseSIEMDelivery(value: unknown): SIEMDelivery | null {
  if (!value || typeof value !== 'object') return null;
  const fields = ['accepted', 'delivered', 'failed', 'dropped', 'retried', 'queued', 'in_flight'] as const;
  const data = value as Record<string, unknown>;
  if (!fields.every(field => typeof data[field] === 'number' && Number.isSafeInteger(data[field]) && (data[field] as number) >= 0)) return null;
  return data as unknown as SIEMDelivery;
}
