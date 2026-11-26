import type { Disposable } from '../../base/lifecycle.js';

export interface SidebarActionBarVisibilityApi {
  readonly isVisible?: boolean;
  readonly onDidVisibilityChange?: (cb: (visible: boolean) => void) => Disposable;
}

export interface SidebarActionBarHostOptions {
  readonly viewEl: HTMLElement;
  readonly actionBarEl: HTMLElement;
  readonly fallbackHost?: HTMLElement;
  readonly api?: SidebarActionBarVisibilityApi;
  readonly canHostInTitleBar?: () => boolean;
}

export interface SidebarActionBarHost extends Disposable {
  sync(): void;
  setVisible(visible: boolean): void;
  isHostedInTitleBar(): boolean;
}

function findSidebarActionsHost(viewEl: HTMLElement): HTMLElement | null {
  return viewEl.closest('.wb-sidebar')?.querySelector<HTMLElement>('.wb-sidebar-head > .wb-part-actions') ?? null;
}

export function createSidebarActionBarHost(opts: SidebarActionBarHostOptions): SidebarActionBarHost {
  let visible = typeof opts.api?.isVisible === 'boolean' ? opts.api.isVisible : !opts.viewEl.hidden;
  let hosted = false;
  let disposed = false;

  const sync = (): void => {
    if (disposed) return;
    const allowTitleBar = opts.canHostInTitleBar ? opts.canHostInTitleBar() : true;
    const titleBarActions = visible && allowTitleBar ? findSidebarActionsHost(opts.viewEl) : null;
    if (titleBarActions) {
      if (opts.actionBarEl.parentElement !== titleBarActions) {
        titleBarActions.appendChild(opts.actionBarEl);
      }
      if (opts.fallbackHost) opts.fallbackHost.hidden = true;
      hosted = true;
      return;
    }
    if (opts.fallbackHost) {
      if (opts.actionBarEl.parentElement !== opts.fallbackHost) {
        opts.fallbackHost.appendChild(opts.actionBarEl);
      }
      opts.fallbackHost.hidden = false;
    } else if (opts.actionBarEl.parentElement) {
      opts.actionBarEl.remove();
    }
    hosted = false;
  };

  const sub = opts.api?.onDidVisibilityChange?.((next) => {
    visible = next;
    sync();
  });

  sync();

  return {
    sync,
    setVisible(next: boolean): void {
      visible = next;
      sync();
    },
    isHostedInTitleBar(): boolean {
      return hosted;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      sub?.dispose();
      if (opts.actionBarEl.parentElement) {
        opts.actionBarEl.remove();
      }
      hosted = false;
    },
  };
}
