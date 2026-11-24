// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageService } from '../services/storage.js';
import { getTheme, setTheme } from '../theme.js';
import { NARROW_BREAKPOINT, createLegacyShell, isNarrowViewport, makePanel } from './legacy-shell.js';

function makeMemoryStorage(initial: Record<string, string> = {}): StorageService {
  const map = new Map<string, string>(Object.entries(initial));
  return new StorageService('', {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  });
}

describe('workbench/legacy-shell', () => {
  beforeEach(() => {
    setTheme('system');
  });

  it('checks narrow viewport threshold at 640px', () => {
    expect(isNarrowViewport({ innerWidth: NARROW_BREAKPOINT } as Window)).toBe(true);
    expect(isNarrowViewport({ innerWidth: NARROW_BREAKPOINT + 1 } as Window)).toBe(false);
  });

  it('manages panel open/inert state, width clamping, and storage', () => {
    const el = document.createElement('div');
    const handle = document.createElement('div');
    const storage = makeMemoryStorage({ w_key: '300' });
    const onChange = vi.fn();

    const panel = makePanel({
      el,
      handle,
      side: 'left',
      min: 180,
      max: 500,
      width: 240,
      storeKey: 'open_key',
      widthKey: 'w_key',
      dockAt: 641,
      onChange,
      storage,
      win: { innerWidth: 1200 } as Window,
    });

    expect(panel.width()).toBe(300);
    expect(el.classList.contains('collapsed')).toBe(true);
    expect(el.hasAttribute('inert')).toBe(true);

    panel.setOpen(true);
    expect(panel.isOpen()).toBe(true);
    expect(el.hasAttribute('inert')).toBe(false);
    expect(storage.getRaw('open_key')).toBe('1');
    expect(onChange).toHaveBeenCalledWith(true);

    panel.setWidth(999, true);
    expect(panel.width()).toBe(500);
    expect(storage.getRaw('w_key')).toBe('500');

    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(panel.width()).toBe(240);
    expect(storage.getRaw('w_key')).toBeNull();
    panel.dispose();
  });

  it('wires sidebar, menus, calm mode, and theme toggle in createLegacyShell', () => {
    const app = document.createElement('div');
    const sidebar = document.createElement('div');
    const sidebarResize = document.createElement('div');
    const collapseBtn = document.createElement('button');
    const expandBtn = document.createElement('button');
    const schedPanel = document.createElement('div');
    const schedResize = document.createElement('div');
    const schedToggle = document.createElement('button');
    const backdrop = document.createElement('div');
    const optsBtn = document.createElement('button');
    const optsMenu = document.createElement('div');
    optsMenu.hidden = true;
    const manageBtn = document.createElement('button');
    const manageMenu = document.createElement('div');
    manageMenu.hidden = true;
    const calmBtn = document.createElement('button');
    const calmState = document.createElement('span');
    const themeBtn = document.createElement('button');
    const themeState = document.createElement('span');
    const langBtn = document.createElement('button');
    const langState = document.createElement('span');
    const storage = makeMemoryStorage();
    const onCloseSchedules = vi.fn();

    const shell = createLegacyShell({
      app,
      sidebar,
      sidebarResize,
      collapseBtn,
      expandBtn,
      schedPanel,
      schedResize,
      schedToggle,
      backdrop,
      optsBtn,
      optsMenu,
      manageBtn,
      manageMenu,
      calmBtn,
      calmState,
      themeBtn,
      themeState,
      langBtn,
      langState,
      onSchedPaint: vi.fn(),
      onSchedOpen: vi.fn(),
      onSchedClose: vi.fn(),
      onCloseSchedules,
      storage,
      win: { innerWidth: 1280 } as Window,
    });

    expect(shell.sbPane.isOpen()).toBe(true);
    collapseBtn.click();
    expect(shell.sbPane.isOpen()).toBe(false);
    expandBtn.click();
    expect(shell.sbPane.isOpen()).toBe(true);

    optsBtn.click();
    expect(optsMenu.hidden).toBe(false);
    manageBtn.click();
    expect(optsMenu.hidden).toBe(true);
    expect(manageMenu.hidden).toBe(false);
    document.body.click();
    expect(shell.openMenu()).toBeNull();

    expect(shell.isCalm()).toBe(false);
    calmBtn.click();
    expect(shell.isCalm()).toBe(true);
    expect(app.classList.contains('calm')).toBe(true);
    expect(storage.getRaw('aa_calm')).toBe('1');

    expect(getTheme()).toBe('system');
    themeBtn.click();
    expect(getTheme()).toBe('dark');

    backdrop.click();
    expect(shell.sbPane.isOpen()).toBe(false);
    shell.dispose();
  });
});
