import { writable } from 'svelte/store';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  message: string;
  duration: number; // in milliseconds; 0 = stays until dismissed
  createdAt: number;
}

function createToastStore() {
  const { subscribe, update } = writable<ToastItem[]>([]);

  function add(type: ToastType, message: string, title?: string, duration?: number): string {
    const id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const defaultTitle =
      type === 'success'
        ? 'Success'
        : type === 'error'
        ? 'Action failed'
        : type === 'warning'
        ? 'Warning'
        : 'Notice';

    // Errors stay until dismissed: a failure must not vanish before it is read.
    const defaultDuration = type === 'error' ? 0 : 4000;
    const item: ToastItem = {
      id,
      type,
      title: title || defaultTitle,
      message: message || '',
      duration: duration !== undefined ? duration : defaultDuration,
      createdAt: Date.now(),
    };

    update((items) => [...items, item]);
    return id;
  }

  function dismiss(id: string) {
    update((items) => items.filter((item) => item.id !== id));
  }

  function clear() {
    update(() => []);
  }

  return {
    subscribe,
    success: (message: string, title = 'Done', duration?: number) =>
      add('success', message, title, duration),
    error: (message: string, title = 'Action failed', duration?: number) =>
      add('error', message, title, duration),
    info: (message: string, title = 'Info', duration?: number) =>
      add('info', message, title, duration),
    warning: (message: string, title = 'Warning', duration?: number) =>
      add('warning', message, title, duration),
    dismiss,
    clear,
  };
}

export const toast = createToastStore();
