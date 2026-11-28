import { en } from './en.js';
import { enExtras } from './en-extras.js';
import { zhCN } from './zh-CN.js';
import { zhCNExtras } from './zh-CN-extras.js';

export type MessageKey = keyof typeof en | keyof typeof enExtras;

export type Locale = 'en' | 'zh-CN';

export interface LocaleInfo {
  readonly code: Locale;
  readonly label: string;
}

export const STORAGE_KEY = 'fh_lang';

export const SUPPORTED_LOCALES: readonly LocaleInfo[] = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
];

// Cross-file contract: app-*.js is built with en-extras / zh-CN-extras emptied
// (scripts/webui-client.mjs), so in the page these hold only en / zh-CN until the workbench-extras
// chunk loads and lazy-extras.ts hands its extrasMessages to extendMessages. A key the page script
// itself shows belongs in en.ts (page.test.ts fails otherwise).
export const extrasMessages: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  en: enExtras,
  'zh-CN': zhCNExtras,
};

const DICTS: Record<Locale, Record<string, string>> = {
  en: { ...en, ...enExtras },
  'zh-CN': { ...zhCN, ...zhCNExtras },
};

export function extendMessages(more: Partial<Record<Locale, Readonly<Record<string, string>>>>): void {
  for (const { code } of SUPPORTED_LOCALES) Object.assign(DICTS[code], more[code]);
}

let currentLocale: Locale = 'en';
const listeners = new Set<(locale: Locale) => void>();

export function matchLocale(raw: string | null | undefined): Locale | null {
  if (!raw) return null;
  const norm = raw.trim().toLowerCase().replace(/_/g, '-');
  if (!norm) return null;
  if (norm === 'zh-cn' || norm === 'zh' || norm.startsWith('zh-hans') || norm === 'zh-sg') {
    return 'zh-CN';
  }
  if (norm === 'en' || norm.startsWith('en-')) {
    return 'en';
  }
  return null;
}

export function detectLocale(): Locale {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = matchLocale(localStorage.getItem(STORAGE_KEY));
      if (stored) return stored;
    }
  } catch {
    // Ignore storage access errors.
  }
  if (typeof navigator !== 'undefined') {
    const langs =
      Array.isArray(navigator.languages) && navigator.languages.length > 0
        ? navigator.languages
        : navigator.language
          ? [navigator.language]
          : [];
    for (const lang of langs) {
      const matched = matchLocale(lang);
      if (matched) return matched;
    }
  }
  return 'en';
}

export function getLocale(): Locale {
  return currentLocale;
}

export function localeLabel(locale: Locale = currentLocale): string {
  const found = SUPPORTED_LOCALES.find((item) => item.code === locale);
  return found ? found.label : 'English';
}

export function nextLocale(locale: Locale = currentLocale): Locale {
  const idx = SUPPORTED_LOCALES.findIndex((item) => item.code === locale);
  const next = SUPPORTED_LOCALES[(idx + 1) % SUPPORTED_LOCALES.length];
  return next ? next.code : 'en';
}

function syncHtmlLang(locale: Locale): void {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = locale;
  }
}

export function initLocale(): Locale {
  currentLocale = detectLocale();
  syncHtmlLang(currentLocale);
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  const resolved = matchLocale(locale) ?? 'en';
  currentLocale = resolved;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, resolved);
    }
  } catch {
    // Ignore storage access errors.
  }
  syncHtmlLang(resolved);
  for (const cb of listeners) cb(resolved);
}

export function onLocaleChange(cb: (locale: Locale) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const raw = DICTS[currentLocale][key] || DICTS.en[key] || key;
  if (!params) return raw;
  return raw.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const val = params[name];
    return val === undefined ? match : String(val);
  });
}

function applyElementI18n(el: Element): void {
  const textKey = el.getAttribute('data-i18n');
  if (textKey) el.textContent = t(textKey as MessageKey);
  const titleKey = el.getAttribute('data-i18n-title');
  if (titleKey) el.setAttribute('title', t(titleKey as MessageKey));
  const placeholderKey = el.getAttribute('data-i18n-placeholder');
  if (placeholderKey) el.setAttribute('placeholder', t(placeholderKey as MessageKey));
  const ariaKey = el.getAttribute('data-i18n-aria');
  if (ariaKey) el.setAttribute('aria-label', t(ariaKey as MessageKey));
}

export function applyDomI18n(root: ParentNode = document): void {
  syncHtmlLang(currentLocale);
  if (typeof Element !== 'undefined' && root instanceof Element) {
    applyElementI18n(root);
  }
  const nodes = root.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria]');
  for (const node of nodes) {
    applyElementI18n(node);
  }
}
