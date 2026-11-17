import { writable } from 'svelte/store';

export type Theme = 'dark' | 'light';

const THEME_KEY = 'wafio_theme';

function initialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const stored = window.localStorage.getItem(THEME_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'dark';
}

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
}

export const theme = writable<Theme>(initialTheme());

// Keep <html data-theme> in sync with the store (the inline script in app.html
// applies the initial value before hydration to avoid a flash).
theme.subscribe((t) => {
  applyTheme(t);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(THEME_KEY, t);
    } catch {
      // storage unavailable (private mode), session-only theme is fine
    }
  }
});

export function toggleTheme() {
  theme.update((t) => (t === 'dark' ? 'light' : 'dark'));
}
