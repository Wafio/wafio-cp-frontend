/**
 * Shared database disk-pressure alert (GET /api/admin/storage/alert) for
 * system administrators: one value read by the header indicator and the
 * Administration banner. The root layout polls it (every 5 min); the
 * Administration layout refreshes it on mount and the Data retention page
 * sets it from the status it loads. Failures keep the last value silently.
 */
import { getStorageAlert, type StorageAlert } from './api';

export const STORAGE_ALERT_POLL_MS = 5 * 60 * 1000;

const state = $state<{ alert: StorageAlert | null }>({ alert: null });

export const storageAlert = {
  get current(): StorageAlert | null {
    return state.alert;
  },
  set(alert: StorageAlert | null) {
    state.alert = alert;
  },
  clear() {
    state.alert = null;
  },
  async refresh(signal?: AbortSignal): Promise<void> {
    const res = await getStorageAlert(signal);
    if (signal?.aborted) return;
    if (res.data) state.alert = res.data;
    else if (res.error?.status === 403) state.alert = null;
  },
};
