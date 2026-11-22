export type ThemeId = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

export interface ThemeEntry {
  readonly id: ThemeId;
  readonly label: string;
}

export const STORAGE_KEY = 'fh_theme';
export const MEDIA_QUERY = '(prefers-color-scheme: dark)';

export const THEME_COLORS: Readonly<Record<ResolvedTheme, string>> = {
  dark: '#131313',
  light: '#ffffff',
};

export const THEMES: readonly ThemeEntry[] = [
  { id: 'system', label: 'System' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEMES.some((entry) => entry.id === value);
}

export function themeLabel(theme: ThemeId): string {
  return THEMES.find((entry) => entry.id === theme)?.label ?? 'System';
}

export function getTheme(): ThemeId {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isThemeId(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(theme: ThemeId = getTheme()): ResolvedTheme {
  if (theme === 'dark' || theme === 'light') return theme;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia(MEDIA_QUERY).matches ? 'dark' : 'light';
}

export function applyTheme(theme: ThemeId = getTheme()): ResolvedTheme {
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[resolved]);
  return resolved;
}

export function setTheme(theme: ThemeId): ResolvedTheme {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage may be unavailable in private browsing or restricted contexts.
  }
  return applyTheme(theme);
}

export function nextTheme(current: ThemeId = getTheme()): ThemeId {
  const idx = THEMES.findIndex((entry) => entry.id === current);
  const next = THEMES[(idx + 1) % THEMES.length];
  return next ? next.id : 'system';
}

export function initTheme(onChange?: (theme: ThemeId, resolved: ResolvedTheme) => void): () => void {
  applyTheme();
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(MEDIA_QUERY);
  const handleChange = (): void => {
    const current = getTheme();
    if (current !== 'system') return;
    const resolved = applyTheme(current);
    onChange?.(current, resolved);
  };
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }
  return () => {};
}
