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
  const themeBtn = (h: Harness): HTMLButtonElement => {
    const el = h.doc.querySelector<HTMLButtonElement>('[data-status-id="status.theme"]');
    if (!el) throw new Error('status.theme button not found');
    return el;
  };

  it('defaults to system mode and follows OS prefers-color-scheme', async () => {
    const dark = await open({ colorScheme: 'dark' });
    await dark.emit(sync(T, [], [T]));
    expect(dark.doc.documentElement.dataset.theme).toBe('dark');
    expect(themeColor(dark)).toBe('#1f1f1f');
    expect(themeBtn(dark).textContent).toContain('System');

    const light = await open({ colorScheme: 'light' });
    await light.emit(sync(T, [], [T]));
    expect(light.doc.documentElement.dataset.theme).toBe('light');
    expect(themeColor(light)).toBe('#ffffff');
    expect(themeBtn(light).textContent).toContain('System');
  });

  it('cycles System -> Dark -> Light -> System, persists to fh_theme, and updates theme-color', async () => {
    const h = await open({ colorScheme: 'dark' });
    await h.emit(sync(T, [], [T]));

    await h.click('[data-status-id="status.theme"]');
    expect(h.window.localStorage.getItem('fh_theme')).toBe('dark');
    expect(h.doc.documentElement.dataset.theme).toBe('dark');
    expect(themeColor(h)).toBe('#1f1f1f');
    expect(themeBtn(h).textContent).toContain('Dark');

    await h.click('[data-status-id="status.theme"]');
    expect(h.window.localStorage.getItem('fh_theme')).toBe('light');
    expect(h.doc.documentElement.dataset.theme).toBe('light');
    expect(themeColor(h)).toBe('#ffffff');
    expect(themeBtn(h).textContent).toContain('Light');

    await h.click('[data-status-id="status.theme"]');
    expect(h.window.localStorage.getItem('fh_theme')).toBe('system');
    expect(h.doc.documentElement.dataset.theme).toBe('dark');
    expect(themeColor(h)).toBe('#1f1f1f');
    expect(themeBtn(h).textContent).toContain('System');
  });

  it('restores persisted theme from localStorage via boot script on reload', async () => {
    const light = await open({ colorScheme: 'dark', storage: { fh_theme: 'light' } });
    await light.emit(sync(T, [], [T]));
    expect(light.doc.documentElement.dataset.theme).toBe('light');
    expect(themeColor(light)).toBe('#ffffff');
    expect(themeBtn(light).textContent).toContain('Light');

    const dark = await open({ colorScheme: 'light', storage: { fh_theme: 'dark' } });
    await dark.emit(sync(T, [], [T]));
    expect(dark.doc.documentElement.dataset.theme).toBe('dark');
    expect(themeColor(dark)).toBe('#1f1f1f');
    expect(themeBtn(dark).textContent).toContain('Dark');
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
    expect(themeColor(h)).toBe('#1f1f1f');

    // Explicit dark ignores OS switch to light.
    await h.click('[data-status-id="status.theme"]');
    expect(h.window.localStorage.getItem('fh_theme')).toBe('dark');
    h.setColorScheme('light');
    expect(h.doc.documentElement.dataset.theme).toBe('dark');
    expect(themeColor(h)).toBe('#1f1f1f');
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

  it('defines all 46 VS Code Dark Modern and Light Modern --fh-* tokens as default palettes', () => {
    const noComments = STYLE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
    const wbDark = noComments.match(/:root,\[data-theme="dark"\]\{([^}]*)\}/)?.[1] ?? '';
    const wbMediaLight =
      noComments.match(/@media \(prefers-color-scheme: light\)\{:root:not\(\[data-theme="dark"\]\)\{([^}]*)\}\}/)?.[1] ?? '';
    const wbDataLight = noComments.match(/\[data-theme="light"\]\{([^}]*)\}/)?.[1] ?? '';

    const parseVars = (block: string): Map<string, string> => {
      const map = new Map<string, string>();
      for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
        map.set(m[1]!, m[2]!.trim());
      }
      return map;
    };

    const darkExpected: Record<string, string> = {
      '--fh-bg': '#1f1f1f',
      '--fh-bg-side': '#181818',
      '--fh-bg-widget': '#252526',
      '--fh-bg-code': '#2b2b2b',
      '--fh-line': '#2b2b2b',
      '--fh-fg': '#cccccc',
      '--fh-fg-hi': '#e7e7e7',
      '--fh-fg-dim': '#9d9d9d',
      '--fh-fg-inactive': '#868686',
      '--fh-accent': '#0078d4',
      '--fh-accent-hover': '#026ec1',
      '--fh-link': '#4daafc',
      '--fh-input': '#313131',
      '--fh-input-line': '#3c3c3c',
      '--fh-placeholder': '#989898',
      '--fh-btn2': '#313131',
      '--fh-btn2-hover': '#3c3c3c',
      '--fh-hover': '#2a2d2e',
      '--fh-sel': '#04395e',
      '--fh-sel-inactive': '#37373d',
      '--fh-toggle': 'rgba(36,137,219,.51)',
      '--fh-toggle-line': '#2488db',
      '--fh-own': 'rgba(0,120,212,.10)',
      '--fh-own-edge': '#0078d4',
      '--fh-ok': '#89d185',
      '--fh-warn': '#cca700',
      '--fh-err': '#f14c4c',
      '--fh-idle': '#6e7681',
      '--fh-git-mod': '#e2c08d',
      '--fh-git-add': '#81b88b',
      '--fh-git-new': '#73c991',
      '--fh-git-del': '#e06c6c',
      '--fh-diff-add': 'rgba(155,185,85,.2)',
      '--fh-diff-del': 'rgba(255,0,0,.2)',
      '--fh-hc-claude': '#e0805f',
      '--fh-hc-claude-bg': 'rgba(224,128,95,.15)',
      '--fh-hc-codex': '#3fb68b',
      '--fh-hc-codex-bg': 'rgba(63,182,139,.15)',
      '--fh-hc-opencode': '#e2e2e2',
      '--fh-hc-opencode-bg': 'rgba(226,226,226,.15)',
      '--fh-hc-agy': '#4f8ff7',
      '--fh-hc-agy-bg': 'rgba(79,143,247,.15)',
      '--fh-hc-gemini': '#a78bfa',
      '--fh-hc-gemini-bg': 'rgba(167,139,250,.15)',
      '--fh-hc-dsh': '#5b7cfa',
      '--fh-hc-dsh-bg': 'rgba(91,124,250,.15)',
    };

    const lightExpected: Record<string, string> = {
      '--fh-bg': '#ffffff',
      '--fh-bg-side': '#f8f8f8',
      '--fh-bg-widget': '#f8f8f8',
      '--fh-bg-code': '#f2f2f2',
      '--fh-line': '#e5e5e5',
      '--fh-fg': '#3b3b3b',
      '--fh-fg-hi': '#1f1f1f',
      '--fh-fg-dim': '#717171',
      '--fh-fg-inactive': '#616161',
      '--fh-accent': '#005fb8',
      '--fh-accent-hover': '#0258a8',
      '--fh-link': '#005fb8',
      '--fh-input': '#ffffff',
      '--fh-input-line': '#cecece',
      '--fh-placeholder': '#767676',
      '--fh-btn2': '#e5e5e5',
      '--fh-btn2-hover': '#cccccc',
      '--fh-hover': '#f2f2f2',
      '--fh-sel': '#e8e8e8',
      '--fh-sel-inactive': '#e4e6f1',
      '--fh-toggle': 'rgba(0,95,184,.12)',
      '--fh-toggle-line': '#005fb8',
      '--fh-own': 'rgba(0,95,184,.06)',
      '--fh-own-edge': '#005fb8',
      '--fh-ok': '#388a34',
      '--fh-warn': '#bf8803',
      '--fh-err': '#e51400',
      '--fh-idle': '#8b949e',
      '--fh-git-mod': '#895503',
      '--fh-git-add': '#587c0c',
      '--fh-git-new': '#007100',
      '--fh-git-del': '#ad0707',
      '--fh-diff-add': 'rgba(155,185,85,.2)',
      '--fh-diff-del': 'rgba(255,0,0,.12)',
      '--fh-hc-claude': '#b5532f',
      '--fh-hc-claude-bg': 'rgba(181,83,47,.10)',
      '--fh-hc-codex': '#0d8a6a',
      '--fh-hc-codex-bg': 'rgba(13,138,106,.10)',
      '--fh-hc-opencode': '#475569',
      '--fh-hc-opencode-bg': 'rgba(71,85,105,.10)',
      '--fh-hc-agy': '#2563eb',
      '--fh-hc-agy-bg': 'rgba(37,99,235,.10)',
      '--fh-hc-gemini': '#7c3aed',
      '--fh-hc-gemini-bg': 'rgba(124,58,237,.10)',
      '--fh-hc-dsh': '#4338ca',
      '--fh-hc-dsh-bg': 'rgba(67,56,202,.10)',
    };

    const darkMap = parseVars(wbDark);
    const mediaLightMap = parseVars(wbMediaLight);
    const dataLightMap = parseVars(wbDataLight);

    for (const [token, expected] of Object.entries(darkExpected)) {
      expect(darkMap.get(token), `dark ${token}`).toBe(expected);
    }
    for (const [token, expected] of Object.entries(lightExpected)) {
      expect(mediaLightMap.get(token), `media-light ${token}`).toBe(expected);
      expect(dataLightMap.get(token), `data-light ${token}`).toBe(expected);
    }
    for (const [name, value] of darkMap) {
      const alias = value.match(/^var\((--fh-[a-z0-9-]+)\)$/);
      if (alias) {
        expect(darkMap.has(alias[1]!), `dangling workbench alias ${name} -> ${alias[1]}`).toBe(true);
      }
    }
  });

  it('applies §4.2 shape, control, typography, scrollbar, and icon rules globally by default', () => {
    const wbDark = STYLE_SOURCE.match(/:root,\[data-theme="dark"\]\{([^}]*)\}/)?.[1] ?? '';
    expect(wbDark).toContain('--fh-radius-ctrl:2px');
    expect(wbDark).toContain('--fh-radius-card:4px');
    expect(wbDark).toContain('--fh-radius-row:0px');
    expect(wbDark).toContain('--fh-radius-pill:999px');
    expect(wbDark).toContain('--fh-font-mono:"Cascadia Code","JetBrains Mono",Consolas,monospace');
    expect(wbDark).toContain('--fh-scroll-thumb:rgba(121,121,121,.4)');
    expect(wbDark).toContain('--fh-icon-stroke:1.5');
    expect(STYLE_SOURCE).toContain('::-webkit-scrollbar{width:10px;height:10px}');
    expect(STYLE_SOURCE).toContain('svg.ic{\n  stroke-width:var(--fh-icon-stroke);');
    expect(STYLE_SOURCE).toContain('letter-spacing:0.05em');
    expect(STYLE_SOURCE).not.toContain('data-workbench="1"');
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

  it('uses bright blue --fh-running tokens across all running indicators in dark and light themes', () => {
    const noComments = STYLE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
    const wbDark = noComments.match(/:root,\[data-theme="dark"\]\{([^}]*)\}/)?.[1] ?? '';
    const wbMediaLight =
      noComments.match(/@media \(prefers-color-scheme: light\)\{:root:not\(\[data-theme="dark"\]\)\{([^}]*)\}\}/)?.[1] ?? '';
    const wbDataLight = noComments.match(/\[data-theme="light"\]\{([^}]*)\}/)?.[1] ?? '';

    expect(wbDark).toContain('--fh-running:#38bdf8;');
    expect(wbMediaLight).toContain('--fh-running:#0284c7;');
    expect(wbDataLight).toContain('--fh-running:#0284c7;');

    expect(STYLE_SOURCE).toContain('.wb-topics-list .wb-topic-row .topic-dot.running{background:var(--fh-running)');
    expect(STYLE_SOURCE).toContain('.wb-topics-list .wb-topic-row .topic-age.run{color:var(--fh-running)}');
    expect(STYLE_SOURCE).toContain('.topic-fold.running{color:var(--fh-running);border-color:var(--fh-running)}');
    expect(STYLE_SOURCE).toContain('.fh-fb-chip[data-fb-value="running"] .fh-fb-chip-icon');
    expect(STYLE_SOURCE).toContain('[data-status-id="status.running"] .wb-status-ok-icon');
    expect(STYLE_SOURCE).toContain('.wb-topic-editor .wb-topic-pill[data-tone="ok"]{background:var(--fh-running-bg);color:var(--fh-running)}');
    expect(STYLE_SOURCE).toContain('.fh-schedules-view .sched-row-age.is-running{color:var(--fh-running)');
    expect(STYLE_SOURCE).toContain('.fh-palette-topic-ic.is-running {\n  color: var(--fh-running);');
    expect(STYLE_SOURCE).toContain('.fh-dot--live { background: var(--dot-live); }');
  });

  it('defines typography scale tokens with 14px UI chrome and 15px transcript/composer body text', () => {
    const wbDark = STYLE_SOURCE.match(/:root,\[data-theme="dark"\]\{([^}]*)\}/)?.[1] ?? '';
    expect(wbDark).toContain('--fh-fs-2xs:11px;');
    expect(wbDark).toContain('--fh-fs-xs:12px;');
    expect(wbDark).toContain('--fh-fs-sm:13px;');
    expect(wbDark).toContain('--fh-fs-ui:14px;');
    expect(wbDark).toContain('--fh-fs-body:15px;');
    expect(wbDark).toContain('--fh-fs-lg:16px;');
    expect(wbDark).toContain('--fh-fs-xl:18px;');
    expect(STYLE_SOURCE).toContain('font-size:var(--fh-fs-ui);line-height:var(--fh-lh-ui)');
    expect(STYLE_SOURCE).toContain('font-size:var(--fh-fs-body);line-height:var(--fh-lh-body)');
  });
});
