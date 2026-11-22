import { describe, expect, it } from 'vitest';
import {
  createTranslator,
  DEFAULT_LOCALE,
  detectEnvLocale,
  interpolate,
  localeLabel,
  localeOf,
  normalizeLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
} from './index.js';

describe('core/i18n', () => {
  it('normalizes supported locale variants', () => {
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('en_US.UTF-8')).toBe('en');
    expect(normalizeLocale('zh')).toBe('zh-CN');
    expect(normalizeLocale('zh_CN.UTF-8')).toBe('zh-CN');
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(normalizeLocale('zh-SG')).toBe('zh-CN');
    expect(normalizeLocale('fr-FR')).toBeUndefined();
    expect(normalizeLocale('')).toBeUndefined();
    expect(normalizeLocale(undefined)).toBeUndefined();
  });

  it('resolves locale with fallback', () => {
    expect(resolveLocale('zh-CN')).toBe('zh-CN');
    expect(resolveLocale('de-DE')).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(undefined, 'zh-CN')).toBe('zh-CN');
  });

  it('detects locale from env vars in priority order', () => {
    expect(detectEnvLocale({ LANG: 'zh_CN.UTF-8' })).toBe('zh-CN');
    expect(detectEnvLocale({ LANG: 'en_US.UTF-8', FLEETHERD_LOCALE: 'zh-CN' })).toBe('zh-CN');
    expect(detectEnvLocale({ LANGUAGE: 'fr_FR:zh_CN:en_US' })).toBe('zh-CN');
    expect(detectEnvLocale({ LANG: 'C.UTF-8' })).toBe('en');
    expect(detectEnvLocale({})).toBe('en');
  });

  it('reads locale from config and formats labels', () => {
    expect(localeOf()).toBe('en');
    expect(localeOf({ locale: 'zh-CN' })).toBe('zh-CN');
    expect(localeLabel('en')).toBe('English');
    expect(localeLabel('zh-CN')).toBe('简体中文');
    expect(SUPPORTED_LOCALES.map((l) => l.code)).toEqual(['en', 'zh-CN']);
  });

  it('interpolates parameters and creates domain translators', () => {
    expect(interpolate('Hello {name} ({count})', { name: 'cc', count: 2 })).toBe('Hello cc (2)');
    expect(interpolate('Keep {missing}', { name: 'cc' })).toBe('Keep {missing}');

    const t = createTranslator({
      en: { greet: 'Hi {who}' },
      'zh-CN': { greet: '你好 {who}' },
    });
    expect(t(undefined, 'greet', { who: 'cc' })).toBe('Hi cc');
    expect(t('en', 'greet', { who: 'cc' })).toBe('Hi cc');
    expect(t('zh-CN', 'greet', { who: 'cc' })).toBe('你好 cc');
  });
});
