import { addDisposableListener } from '../base/dom.js';
import { type Disposable, DisposableStore, toDisposable } from '../base/lifecycle.js';
import { getLocale, localeLabel, nextLocale, setLocale, t as tr } from '../i18n/index.js';
import { StorageService } from '../services/storage.js';
import { THEMES, getTheme, initTheme, nextTheme, setTheme, themeLabel, type ThemeId } from '../theme.js';

export const NARROW_BREAKPOINT = 640;

export function isNarrowViewport(win: Window = window): boolean {
  return win.innerWidth <= NARROW_BREAKPOINT;
}

export interface LegacyPanelOpenOptions {
  readonly transient?: boolean;
  readonly force?: boolean;
}

export interface LegacyPanelConfig {
  readonly el: HTMLElement;
  readonly handle: HTMLElement;
  readonly side: 'left' | 'right';
  readonly min: number;
  readonly max: number;
  readonly width: number | (() => number);
  readonly maxWidth?: () => number;
  readonly storeKey?: string;
  readonly widthKey: string;
  readonly dockAt: number;
  readonly onPaint?: (open: boolean) => void;
  readonly onChange?: (open: boolean) => void;
  readonly storage?: StorageService;
  readonly win?: Window;
  readonly doc?: Document;
}

export interface LegacyPanel extends Disposable {
  readonly el: HTMLElement;
  isOpen(): boolean;
  setOpen(next: boolean, opts?: LegacyPanelOpenOptions): void;
  toggle(): void;
  width(): number;
  setWidth(w: number | null, keep?: boolean): void;
  docked(): boolean;
}

export interface LegacyMenuEntry {
  readonly btn: HTMLElement;
  readonly menu: HTMLElement;
}

export interface LegacyShellDeps {
  readonly app: HTMLElement;
  readonly sidebar: HTMLElement;
  readonly sidebarResize: HTMLElement;
  readonly collapseBtn: HTMLElement;
  readonly expandBtn: HTMLElement;
  readonly schedPanel: HTMLElement;
  readonly schedResize: HTMLElement;
  readonly schedToggle: HTMLElement;
  readonly backdrop: HTMLElement;
  readonly optsBtn: HTMLElement;
  readonly optsMenu: HTMLElement;
  readonly manageBtn: HTMLElement;
  readonly manageMenu: HTMLElement;
  readonly calmBtn: HTMLElement;
  readonly calmState: HTMLElement;
  readonly themeBtn: HTMLElement;
  readonly themeState: HTMLElement;
  readonly langBtn: HTMLElement | null;
  readonly langState: HTMLElement | null;
  readonly onSchedPaint: (open: boolean) => void;
  readonly onSchedOpen: () => void;
  readonly onSchedClose: () => void;
  readonly onCloseSchedules: () => void;
  readonly storage?: StorageService;
  readonly win?: Window;
  readonly doc?: Document;
}

export interface LegacyShell extends Disposable {
  readonly sbPane: LegacyPanel;
  readonly schedPane: LegacyPanel;
  narrow(): boolean;
  clampPanels(): void;
  setSidebar(open: boolean): void;
  setMenu(entry: LegacyMenuEntry | null, open: boolean): void;
  openMenu(): LegacyMenuEntry | null;
  closeMenus(): void;
  addMenu(btn: HTMLElement, menu: HTMLElement): LegacyMenuEntry;
  isCalm(): boolean;
  paintCalm(): void;
  paintTheme(): void;
  paintLang(): void;
  repaintI18n(): void;
}

const THEME_I18N_KEYS: Readonly<Record<ThemeId, 'menu.themeSystem' | 'menu.themeDark' | 'menu.themeLight'>> = {
  system: 'menu.themeSystem',
  dark: 'menu.themeDark',
  light: 'menu.themeLight',
};

function localizedThemeLabel(id: ThemeId): string {
  const key = THEME_I18N_KEYS[id];
  return key ? tr(key) : themeLabel(id);
}

export function makePanel(cfg: LegacyPanelConfig): LegacyPanel {
  const win = cfg.win ?? window;
  const doc = cfg.doc ?? document;
  const storage = cfg.storage ?? new StorageService();
  const disposables = new DisposableStore();
  let open = false;
  let drag: { edge: number } | null = null;

  const docked = (): boolean => win.innerWidth >= cfg.dockAt;

  const width = (): number => {
    const w = Number.parseFloat(cfg.el.style.getPropertyValue('--pw'));
    if (w > 0) return w;
    return typeof cfg.width === 'function' ? cfg.width() : cfg.width;
  };

  const maxWidth = (): number => {
    const cap = cfg.maxWidth ? cfg.maxWidth() : cfg.max;
    return Math.max(cfg.min, Math.min(cfg.max, cap));
  };

  const setWidth = (w: number | null, keep?: boolean): void => {
    if (w == null) {
      cfg.el.style.removeProperty('--pw');
      storage.remove(cfg.widthKey);
      return;
    }
    const clamped = Math.round(Math.max(cfg.min, Math.min(maxWidth(), w)));
    cfg.el.style.setProperty('--pw', `${clamped}px`);
    if (keep) storage.setRaw(cfg.widthKey, String(clamped));
  };

  const paint = (): void => {
    cfg.el.classList.toggle('collapsed', !open);
    if (open) cfg.el.removeAttribute('inert');
    else cfg.el.setAttribute('inert', '');
    cfg.onPaint?.(open);
  };

  const setOpen = (next: boolean, opts: LegacyPanelOpenOptions = {}): void => {
    if (next === open) {
      if (opts.force) paint();
      return;
    }
    open = next;
    if (!opts.transient && cfg.storeKey) {
      if (open) storage.setRaw(cfg.storeKey, '1');
      else storage.remove(cfg.storeKey);
    }
    paint();
    cfg.onChange?.(open);
  };

  disposables.add(
    addDisposableListener(cfg.handle, 'pointerdown', (ev) => {
      if (!docked()) return;
      ev.preventDefault();
      const rect = cfg.el.getBoundingClientRect();
      drag = { edge: cfg.side === 'left' ? rect.left : rect.right };
      cfg.handle.className = 'panel-resize dragging';
      doc.body.style.userSelect = 'none';
    }),
  );
  disposables.add(
    addDisposableListener(doc, 'pointermove', (ev) => {
      if (!drag) return;
      setWidth(cfg.side === 'left' ? ev.clientX - drag.edge : drag.edge - ev.clientX, false);
    }),
  );
  disposables.add(
    addDisposableListener(doc, 'pointerup', () => {
      if (!drag) return;
      drag = null;
      cfg.handle.className = 'panel-resize';
      doc.body.style.userSelect = '';
      const w = Number.parseFloat(cfg.el.style.getPropertyValue('--pw'));
      if (w > 0) setWidth(w, true);
    }),
  );
  disposables.add(
    addDisposableListener(cfg.handle, 'dblclick', () => {
      setWidth(null);
    }),
  );

  const saved = Number(storage.getRaw(cfg.widthKey) ?? 0);
  if (saved > 0) setWidth(saved, false);
  paint();

  return {
    el: cfg.el,
    isOpen: () => open,
    setOpen,
    toggle: () => setOpen(!open),
    width,
    setWidth,
    docked,
    dispose: () => disposables.dispose(),
  };
}

function setupDisclosureMenus(
  doc: Document,
  disposables: DisposableStore,
  initial: readonly LegacyMenuEntry[],
): {
  setMenu: (entry: LegacyMenuEntry | null, open: boolean) => void;
  openMenu: () => LegacyMenuEntry | null;
  addMenu: (btn: HTMLElement, menu: HTMLElement) => LegacyMenuEntry;
} {
  const menus: LegacyMenuEntry[] = [];
  const setMenu = (entry: LegacyMenuEntry | null, open: boolean): void => {
    for (const item of menus) {
      const on = open && item === entry;
      item.menu.hidden = !on;
      item.btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
  };
  const openMenu = (): LegacyMenuEntry | null => menus.find((item) => !item.menu.hidden) ?? null;
  const addMenu = (btn: HTMLElement, menu: HTMLElement): LegacyMenuEntry => {
    const entry: LegacyMenuEntry = { btn, menu };
    menus.push(entry);
    disposables.add(
      addDisposableListener(btn, 'click', () => {
        setMenu(entry, menu.hidden);
      }),
    );
    return entry;
  };
  for (const pair of initial) addMenu(pair.btn, pair.menu);
  disposables.add(
    addDisposableListener(doc, 'click', (ev) => {
      const active = openMenu();
      const target = ev.target as Node | null;
      if (!active || (target && (active.menu.contains(target) || active.btn.contains(target)))) return;
      setMenu(null, false);
    }),
  );
  return { setMenu, openMenu, addMenu };
}

function setupShellControls(
  deps: LegacyShellDeps,
  storage: StorageService,
  disposables: DisposableStore,
): {
  isCalm: () => boolean;
  paintCalm: () => void;
  paintTheme: () => void;
  paintLang: () => void;
} {
  let calm = storage.getRaw('aa_calm') === '1';
  const paintCalm = (): void => {
    deps.app.classList.toggle('calm', calm);
    deps.calmBtn.setAttribute('aria-pressed', calm ? 'true' : 'false');
    deps.calmState.textContent = calm ? tr('common.on') : tr('common.off');
  };
  disposables.add(
    addDisposableListener(deps.calmBtn, 'click', () => {
      calm = !calm;
      if (calm) storage.setRaw('aa_calm', '1');
      else storage.remove('aa_calm');
      paintCalm();
    }),
  );
  paintCalm();

  const paintTheme = (): void => {
    const current = getTheme();
    const label = localizedThemeLabel(current);
    const options = THEMES.map((entry) => localizedThemeLabel(entry.id)).join(' / ');
    deps.themeState.textContent = label;
    deps.themeBtn.setAttribute('aria-label', tr('menu.themeAria', { label }));
    deps.themeBtn.title = tr('menu.themeTitle', { label, options });
  };
  disposables.add(
    addDisposableListener(deps.themeBtn, 'click', () => {
      setTheme(nextTheme());
      paintTheme();
    }),
  );
  disposables.add(toDisposable(initTheme(paintTheme)));
  paintTheme();

  const paintLang = (): void => {
    if (deps.langState) deps.langState.textContent = localeLabel(getLocale());
  };
  if (deps.langBtn) {
    disposables.add(
      addDisposableListener(deps.langBtn, 'click', () => {
        setLocale(nextLocale(getLocale()));
      }),
    );
  }
  paintLang();

  return { isCalm: () => calm, paintCalm, paintTheme, paintLang };
}

export function createLegacyShell(deps: LegacyShellDeps): LegacyShell {
  const win = deps.win ?? window;
  const doc = deps.doc ?? document;
  const storage = deps.storage ?? new StorageService();
  const disposables = new DisposableStore();
  const narrow = (): boolean => isNarrowViewport(win);
  const schedRef: { current?: LegacyPanel } = {};

  const sbPane = disposables.add(
    makePanel({
      el: deps.sidebar,
      handle: deps.sidebarResize,
      side: 'left',
      min: 180,
      max: 640,
      width: 240,
      storeKey: 'aa_sb_open',
      widthKey: 'aa_sb_w',
      dockAt: NARROW_BREAKPOINT + 1,
      maxWidth: () => {
        const right = schedRef.current;
        return win.innerWidth - 360 - (right && right.isOpen() && right.docked() ? right.width() : 0);
      },
      onPaint: (open) => {
        deps.app.classList.toggle('sb-open', open);
        deps.expandBtn.hidden = open;
      },
      storage,
      win,
      doc,
    }),
  );

  const clampPanels = (): void => {
    const right = schedRef.current;
    if (!sbPane.docked() || !right) return;
    const w = Number.parseFloat(deps.sidebar.style.getPropertyValue('--pw'));
    if (w > 0) sbPane.setWidth(w, false);
    if (right.docked()) {
      const sw = Number.parseFloat(deps.schedPanel.style.getPropertyValue('--pw'));
      if (sw > 0) right.setWidth(sw, false);
    }
  };

  const schedPane = disposables.add(
    makePanel({
      el: deps.schedPanel,
      handle: deps.schedResize,
      side: 'right',
      min: 220,
      max: 640,
      width: () => Math.min(320, Math.max(240, Math.round(win.innerWidth * 0.2))),
      storeKey: 'aa_sched_open',
      widthKey: 'aa_sched_w',
      dockAt: 1024,
      maxWidth: () => win.innerWidth - sbPane.width() - 360,
      onPaint: (open) => {
        deps.app.classList.toggle('sched-open', open);
        deps.schedToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        deps.schedToggle.classList.toggle('on', open);
        deps.onSchedPaint(open);
      },
      onChange: (open) => {
        if (open) deps.onSchedOpen();
        else deps.onSchedClose();
        clampPanels();
      },
      storage,
      win,
      doc,
    }),
  );
  schedRef.current = schedPane;

  const setSidebar = (open: boolean): void => sbPane.setOpen(open);
  disposables.add(addDisposableListener(deps.collapseBtn, 'click', () => setSidebar(false)));
  disposables.add(addDisposableListener(deps.expandBtn, 'click', () => setSidebar(true)));
  disposables.add(
    addDisposableListener(deps.backdrop, 'click', () => {
      if (schedPane.isOpen()) deps.onCloseSchedules();
      if (sbPane.isOpen()) setSidebar(false);
    }),
  );

  const savedSbOpen = storage.getRaw('aa_sb_open') ?? (narrow() ? '0' : '1');
  if (savedSbOpen !== '0') sbPane.setOpen(true, { transient: true });

  const { setMenu, openMenu, addMenu } = setupDisclosureMenus(doc, disposables, [
    { btn: deps.optsBtn, menu: deps.optsMenu },
    { btn: deps.manageBtn, menu: deps.manageMenu },
  ]);
  const { isCalm, paintCalm, paintTheme, paintLang } = setupShellControls(deps, storage, disposables);

  return {
    sbPane,
    schedPane,
    narrow,
    clampPanels,
    setSidebar,
    setMenu,
    openMenu,
    closeMenus: () => setMenu(null, false),
    addMenu,
    isCalm,
    paintCalm,
    paintTheme,
    paintLang,
    repaintI18n: () => {
      paintLang();
      paintTheme();
      paintCalm();
    },
    dispose: () => disposables.dispose(),
  };
}
