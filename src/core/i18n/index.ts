import { LOCALES, type Config, type Locale } from '../../config/schema.js';

export { LOCALES, type Locale };

export const DEFAULT_LOCALE: Locale = 'en';

export interface LocaleInfo {
  readonly code: Locale;
  readonly label: string;
}

export const SUPPORTED_LOCALES: readonly LocaleInfo[] = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
];

export type MessageParams = Readonly<Record<string, string | number>>;
export type DictOf<T extends Record<string, string>> = Readonly<Record<keyof T, string>>;
export type DomainTranslator<K extends string> = (
  locale: Locale | undefined,
  key: K,
  params?: MessageParams
) => string;

export function normalizeLocale(raw: string | null | undefined): Locale | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().split('.')[0]?.split('@')[0]?.toLowerCase().replace(/_/g, '-');
  if (!cleaned) return undefined;
  if (
    cleaned === 'zh-cn' ||
    cleaned === 'zh' ||
    cleaned === 'cn' ||
    cleaned === 'chinese' ||
    cleaned === '中文' ||
    cleaned.startsWith('zh-hans') ||
    cleaned === 'zh-sg'
  ) {
    return 'zh-CN';
  }
  if (cleaned === 'en' || cleaned === 'english' || cleaned.startsWith('en-')) {
    return 'en';
  }
  return undefined;
}

export function resolveLocale(raw: string | null | undefined, fallback: Locale = DEFAULT_LOCALE): Locale {
  return normalizeLocale(raw) ?? fallback;
}

export function localeOf(cfg?: Pick<Config, 'locale'> | null): Locale {
  return cfg?.locale ?? DEFAULT_LOCALE;
}

export function localeLabel(locale: Locale = DEFAULT_LOCALE): string {
  return SUPPORTED_LOCALES.find((l) => l.code === locale)?.label ?? 'English';
}

export function detectEnvLocale(env: Readonly<Record<string, string | undefined>>): Locale {
  for (const key of ['FLEETHERD_LOCALE', 'LC_ALL', 'LC_MESSAGES', 'LANGUAGE', 'LANG']) {
    const raw = env[key];
    if (!raw) continue;
    for (const part of raw.split(':')) {
      const matched = normalizeLocale(part);
      if (matched) return matched;
    }
  }
  return DEFAULT_LOCALE;
}

export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const val = params[name];
    return val === undefined ? match : String(val);
  });
}

export function createTranslator<K extends string>(
  dicts: Readonly<Record<Locale, Readonly<Record<K, string>>>>
): DomainTranslator<K> {
  return (locale, key, params) => {
    const loc = locale ?? DEFAULT_LOCALE;
    const raw = dicts[loc]?.[key] ?? dicts[DEFAULT_LOCALE][key] ?? key;
    return interpolate(raw, params);
  };
}
