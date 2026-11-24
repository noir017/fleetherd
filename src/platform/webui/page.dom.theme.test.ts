import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { STYLE_SOURCE } from './page.test-helpers.js';
import { open, sync, type Harness } from './page.dom.test-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CODEVIEW_SOURCE = fs.readFileSync(path.join(here, 'codeview', 'app.ts'), 'utf8');

describe('webui page: theme system', () => {
  const T = 'a1b2c3d4';
  const themeColor = (h: Harness): string | null =>
    h.doc.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null;

  it('defaults to system mode and follows OS prefers-color-scheme', async () => {
    const dark = await open({ colorScheme: 'dark' });
    await dark.emit(sync(T, [], [T]));
    expect(dark.doc.documentElement.dataset.theme).toBe('dark');
    expect(themeColor(dark)).toBe('#131313');
    expect(dark.el('theme-state').textContent).toBe('System');
    expect(dark.el('theme-toggle').getAttribute('aria-label')).toBe('Theme: System');

    const light = await open({ colorScheme: 'light' });
    await light.emit(sync(T, [], [T]));
    expect(light.doc.documentElement.dataset.theme).toBe('light');
    expect(themeColor(light)).toBe('#ffffff');
    expect(light.el('theme-state').textContent).toBe('System');
  });

  it('cycles System -> Dark -> Light -> System, persists to fh_theme, and updates theme-color', async () => {
    const h = await open({ colorScheme: 'dark' });
    await h.emit(sync(T, [], [T]));

    await h.click('#opts-toggle');
    expect(h.el('opts-menu').hidden).toBe(false);

    await h.click('#theme-toggle');
    expect(h.window.localStorage.getItem('fh_theme')).toBe('dark');
    expect(h.doc.documentElement.dataset.theme).toBe('dark');
    expect(themeColor(h)).toBe('#131313');
    expect(h.el('theme-state').textContent).toBe('Dark');
    expect(h.el('theme-toggle').getAttribute('aria-label')).toBe('Theme: Dark');
    expect(h.el('opts-menu').hidden).toBe(false);

    await h.click('#theme-toggle');
    expect(h.window.localStorage.getItem('fh_theme')).toBe('light');
    expect(h.doc.documentElement.dataset.theme).toBe('light');
    expect(themeColor(h)).toBe('#ffffff');
    expect(h.el('theme-state').textContent).toBe('Light');
    expect(h.el('theme-toggle').getAttribute('aria-label')).toBe('Theme: Light');

    await h.click('#theme-toggle');
    expect(h.window.localStorage.getItem('fh_theme')).toBe('system');
    expect(h.doc.documentElement.dataset.theme).toBe('dark');
    expect(themeColor(h)).toBe('#131313');
    expect(h.el('theme-state').textContent).toBe('System');
  });

  it('restores persisted theme from localStorage via boot script on reload', async () => {
    const light = await open({ colorScheme: 'dark', storage: { fh_theme: 'light' } });
    expect(light.doc.documentElement.dataset.theme).toBe('light');
    expect(themeColor(light)).toBe('#ffffff');
    expect(light.el('theme-state').textContent).toBe('Light');

    const dark = await open({ colorScheme: 'light', storage: { fh_theme: 'dark' } });
    expect(dark.doc.documentElement.dataset.theme).toBe('dark');
    expect(themeColor(dark)).toBe('#131313');
    expect(dark.el('theme-state').textContent).toBe('Dark');
  });

  it('reacts to OS prefers-color-scheme changes only when set to system', async () => {
    const h = await open({ colorScheme: 'dark' });
    await h.emit(sync(T, [], [T]));
    expect(h.doc.documentElement.dataset.theme).toBe('dark');

    h.setColorScheme('light');
    expect(h.doc.documentElement.dataset.theme).toBe('light');
    expect(themeColor(h)).toBe('#ffffff');

    h.setColorScheme('dark');
    expect(h.doc.documentElement.dataset.theme).toBe('dark');
    expect(themeColor(h)).toBe('#131313');

    // Explicit dark ignores OS switch to light.
    await h.click('#theme-toggle');
    expect(h.window.localStorage.getItem('fh_theme')).toBe('dark');
    h.setColorScheme('light');
    expect(h.doc.documentElement.dataset.theme).toBe('dark');
    expect(themeColor(h)).toBe('#131313');
  });

  it('keeps main.css free of hardcoded hex and rgb/rgba colors outside theme token blocks', () => {
    const noComments = STYLE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
    const withoutTokens = noComments
      .replace(/:root,\[data-theme="dark"\]\{[^}]*\}/g, '')
      .replace(/@media \(prefers-color-scheme: light\)\{:root:not\(\[data-theme="dark"\]\)\{[^}]*\}\}/g, '')
      .replace(/\[data-theme="light"\]\{[^}]*\}/g, '');
    expect(withoutTokens.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(withoutTokens.match(/rgba?\([^)]+\)/gi)).toBeNull();
  });

  it('defines all semantic --fh-* tokens in dark and light palettes and keeps legacy aliases resolvable', () => {
    const noComments = STYLE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
    const darkBlock = noComments.match(/:root,\[data-theme="dark"\]\{([^}]*)\}/)?.[1] ?? '';
    const mediaLightBlock =
      noComments.match(/@media \(prefers-color-scheme: light\)\{:root:not\(\[data-theme="dark"\]\)\{([^}]*)\}\}/)?.[1] ?? '';
    const dataLightBlock = noComments.match(/\[data-theme="light"\]\{([^}]*)\}/)?.[1] ?? '';

    const requiredTokens = [
      '--fh-bg', '--fh-bg-side', '--fh-bg-widget', '--fh-bg-code', '--fh-line',
      '--fh-fg', '--fh-fg-hi', '--fh-fg-dim', '--fh-fg-inactive',
      '--fh-accent', '--fh-accent-hover', '--fh-link',
      '--fh-input', '--fh-input-line', '--fh-placeholder',
      '--fh-btn2', '--fh-btn2-hover',
      '--fh-hover', '--fh-sel', '--fh-sel-inactive',
      '--fh-toggle', '--fh-toggle-line',
      '--fh-own', '--fh-own-edge',
      '--fh-ok', '--fh-warn', '--fh-err', '--fh-idle',
      '--fh-git-mod', '--fh-git-add', '--fh-git-new', '--fh-git-del',
      '--fh-diff-add', '--fh-diff-del',
      '--fh-hc-claude', '--fh-hc-claude-bg',
      '--fh-hc-codex', '--fh-hc-codex-bg',
      '--fh-hc-opencode', '--fh-hc-opencode-bg',
      '--fh-hc-agy', '--fh-hc-agy-bg',
      '--fh-hc-gemini', '--fh-hc-gemini-bg',
      '--fh-hc-dsh', '--fh-hc-dsh-bg',
    ];

    for (const block of [darkBlock, mediaLightBlock, dataLightBlock]) {
      const defined = new Map<string, string>();
      for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
        defined.set(m[1]!, m[2]!.trim());
      }
      for (const token of requiredTokens) {
        expect(defined.has(token), `missing ${token}`).toBe(true);
      }
      for (const [name, value] of defined) {
        const alias = value.match(/^var\((--fh-[a-z0-9-]+)\)$/);
        if (alias) {
          expect(defined.has(alias[1]!), `dangling alias ${name} -> ${alias[1]}`).toBe(true);
        }
      }
    }
  });

  it('uses CSS custom properties for CodeMirror theme and syntax highlighting', () => {
    const themeBlock = CODEVIEW_SOURCE.slice(
      CODEVIEW_SOURCE.indexOf('const theme = EditorView.theme('),
      CODEVIEW_SOURCE.indexOf('let paletteMounted = false;')
    );
    expect(themeBlock).toContain('var(--cm-active-line)');
    expect(themeBlock).toContain('var(--cm-selection)');
    expect(themeBlock).toContain('var(--syn-keyword)');
    expect(themeBlock.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(themeBlock.match(/rgba?\([^)]+\)/gi)).toBeNull();
  });
});
