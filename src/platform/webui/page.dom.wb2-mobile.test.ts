// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from './client/base/html.js';
import { renderGroupedList, renderRadioGroup } from './client/components/form/index.js';
import { openBottomSheet } from './client/components/sheet/index.js';
import { createPalettePlugin } from './client/features/palette/index.js';
import { PluginManager } from './client/plugins/host.js';
import { ContributionRegistry, WebuiEventBus, type PluginTopicsBridge } from './client/plugins/registry.js';
import type { ApiClient } from './client/services/api.js';
import { CommandRegistry } from './client/services/commands.js';
import { KeybindingService } from './client/services/keybindings.js';
import { OverlayManager } from './client/services/overlays.js';
import { StorageService } from './client/services/storage.js';
import type { PanelComponent } from './client/workbench/contracts.js';
import { WorkbenchShell } from './client/workbench/shell.js';
import { createMobileMorePanel, MobileTabBar } from './client/workbench/mobile-tabbar.js';
import { renderPage } from './page.js';

describe('wb2-mobile: login, mobile drawer, sheet, grouped form, and palette', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders login card and SSO gate with logo, title, subtitle, and note', () => {
    const pwHtml = renderPage('fleetherd', false, true);
    expect(pwHtml).toContain('class="fh-login-gate"');
    expect(pwHtml).toContain('class="fh-login-card"');
    expect(pwHtml).toContain('class="fh-login-logo"');
    expect(pwHtml).toContain('<h1 class="fh-login-title">fleetherd</h1>');
    expect(pwHtml).toContain('data-i18n="gate.subtitle"');
    expect(pwHtml).toContain('data-i18n="gate.note"');

    const ssoHtml = renderPage('fleetherd', false, false);
    expect(ssoHtml).toContain('class="fh-login-card"');
    expect(ssoHtml).toContain('data-i18n="gate.ssoExpired"');
    expect(ssoHtml).toContain('data-i18n="gate.reload"');
  });

  it('opens and dismisses BottomSheet with actions, selection state, and OverlayManager Escape', () => {
    const overlays = new OverlayManager();
    const onSelect = vi.fn();
    const sheet = openBottomSheet({
      title: 'Slow cart API',
      subtitle: 'claude · ~/work/shop-api',
      showCancel: true,
      overlays,
      actions: [
        { id: 'star', label: 'Star', selected: true },
        { id: 'delete', label: 'Delete topic', danger: true },
      ],
      onSelect,
    });

    expect(sheet.el.querySelector('.fh-sheet-title')?.textContent).toBe('Slow cart API');
    expect(sheet.el.querySelector('.fh-sheet-check')).not.toBeNull();
    expect(sheet.el.querySelector('[data-sheet-action="delete"]')?.classList.contains('is-danger')).toBe(true);

    sheet.el.querySelector<HTMLButtonElement>('[data-sheet-action="star"]')!.click();
    expect(onSelect).toHaveBeenCalledWith('star', expect.objectContaining({ id: 'star' }));
    expect(sheet.isOpen()).toBe(false);

    const sheet2 = openBottomSheet({ title: 'Model', showCancel: true, overlays });
    expect(overlays.handleEscape()).toBe(true);
    expect(sheet2.isOpen()).toBe(false);
    overlays.dispose();
  });

  it('renders RadioGroup and GroupedList form controls', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onChange = vi.fn();
    render(
      renderRadioGroup({
        ariaLabel: 'Idle timeout',
        value: '1h',
        options: [
          { value: 'off', label: 'Off' },
          { value: '1h', label: '1 hour', description: 'Default' },
        ],
        onChange,
      }),
      host,
    );
    expect(host.querySelector('[data-radio-value="1h"]')?.getAttribute('aria-checked')).toBe('true');
    host.querySelector<HTMLButtonElement>('[data-radio-value="off"]')!.click();
    expect(onChange).toHaveBeenCalledWith('off');

    const onClick = vi.fn();
    render(
      renderGroupedList({
        header: 'Gateway',
        footer: 'Saved to config.yaml',
        items: [{ id: 'agents', label: 'Agents', value: '5', chevron: true, onClick }],
      }),
      host,
    );
    expect(host.querySelector('.fh-mgroup-head')?.textContent).toBe('Gateway');
    expect(host.querySelector('.fh-mgroup-foot')?.textContent).toBe('Saved to config.yaml');
    host.querySelector<HTMLButtonElement>('[data-group-item="agents"]')!.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('switches from topic quick-open to command palette when typing > and renders footer hints', async () => {
    const commands = new CommandRegistry();
    const keybindings = new KeybindingService({
      executeCommand: (id, ...args) => commands.execute(id, ...args),
      isMac: false,
    });
    const registry = new ContributionRegistry({ commands, keybindings });
    const events = new WebuiEventBus();
    const map = new Map<string, string>();
    const storage = new StorageService('', {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => { map.set(k, v); },
      removeItem: (k) => { map.delete(k); },
    });
    const overlays = new OverlayManager();
    const topics: PluginTopicsBridge = {
      list: () => [{ id: 't1', title: 'Alpha', lastAt: 100 }],
      active: () => undefined,
      open: vi.fn(),
      insertIntoComposer: vi.fn(),
    };
    const api: ApiClient = {
      get: vi.fn(async () => new Response('{}')),
      post: vi.fn(async () => new Response('{}')),
      getJson: async <T,>() => ({}) as T,
      postJson: async <T,>() => ({}) as T,
    };

    const manager = new PluginManager({ registry, events, topics, api, storage });
    manager.register(createPalettePlugin({ commands, keybindings, overlays, isMac: false }), { builtin: true });
    await manager.activate('palette');

    keybindings.handleKeydown({ key: 'k', ctrlKey: true });
    const topicQp = document.querySelector<HTMLElement>('.fh-palette-topics')!;
    expect(topicQp.querySelector('.fh-qp-foot')).not.toBeNull();

    const input = topicQp.querySelector<HTMLInputElement>('.fh-qp-input')!;
    input.value = '>palette';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const cmdQp = document.querySelector<HTMLElement>('.fh-palette-commands');
    expect(cmdQp).not.toBeNull();
    expect(cmdQp!.querySelectorAll('.fh-qp-kbd').length).toBeGreaterThan(0);
    expect(cmdQp!.querySelector('.fh-qp-foot')).not.toBeNull();

    manager.dispose();
    overlays.dispose();
    keybindings.dispose();
    registry.dispose();
    events.dispose();
  });

  it('opens editors in the workbench editor area and closes the sidebar drawer on <640px', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const shell = new WorkbenchShell({
      root,
      initialWidth: 390,
      initialHeight: 844,
      autoSaveLayout: false,
    });

    const disposed: string[] = [];
    const makeTracked = (tag: string): PanelComponent => {
      const el = document.createElement('div');
      el.textContent = tag;
      return {
        element: el,
        init(params) {
          el.dataset.params = JSON.stringify(params ?? null);
        },
        dispose() {
          disposed.push(tag);
          el.remove();
        },
      };
    };

    shell.views.register({
      id: 'settings',
      title: 'Settings',
      part: 'sidebar',
      component: () => makeTracked('view:settings'),
    });

    for (const kind of ['schedule', 'history', 'review', 'review-prefs', 'skill', 'settings', 'instruction']) {
      shell.editors.register({
        kind,
        title: (inp) => {
          const rec = inp as { sectionId?: string; title?: string } | undefined;
          return rec?.sectionId ?? rec?.title ?? kind;
        },
        component: () => makeTracked(`editor:${kind}`),
      });
    }

    shell.views.reveal('settings');
    shell.setPartVisible('sidebar', true);
    expect(shell.isPartVisible('sidebar')).toBe(true);

    const ref = shell.editors.open('settings', { scope: 'gateway', sectionId: 'Delegation' });
    expect(ref).toBeDefined();
    expect(shell.isPartVisible('sidebar')).toBe(false);
    expect(root.querySelector('.wb-editor-area')?.textContent).toContain('editor:settings');
    ref!.close();
    expect(disposed).toContain('editor:settings');

    shell.dispose();
  });

  it('renders mobile bottom tab bar with badges and More panel with Prefs, Skills, History, Settings, and Appearance subview', () => {
    const tabBar = new MobileTabBar({ doc: document });
    document.body.appendChild(tabBar.element);
    const selected: string[] = [];
    tabBar.onDidSelectTab((tab) => selected.push(tab.id));
    tabBar.setTabs([
      { id: 'topics', title: 'Topics', icon: 'chat', view: 'topics', badge: () => 4 },
      { id: 'schedules', title: 'Scheduled', icon: 'clock', view: 'schedules', badge: () => 'dot' },
      { id: 'reviews', title: 'Reviews', icon: 'eye', view: 'reviews' },
      { id: 'more', title: 'More', icon: 'more', view: 'more' },
    ]);
    expect(tabBar.element.querySelector('.wb-stack-tab[data-tab-id="topics"] .wb-badge')?.textContent).toBe('4');
    expect(tabBar.element.querySelector('.wb-stack-tab[data-tab-id="schedules"] .wb-badge-dot')).not.toBeNull();
    tabBar.setActive('history');
    expect(tabBar.getActiveTab()).toBe('more');
    tabBar.element.querySelector<HTMLButtonElement>('.wb-stack-tab[data-tab-id="schedules"]')!.click();
    expect(selected).toEqual(['schedules']);
    tabBar.dispose();

    const onOpenPrefs = vi.fn();
    const onOpenSkills = vi.fn();
    const onOpenHistory = vi.fn();
    const onOpenSettings = vi.fn();
    const onChangeTheme = vi.fn();
    const more = createMobileMorePanel({ doc: document });
    document.body.appendChild(more.component.element);
    more.setState({
      theme: 'dark',
      locale: 'en',
      connected: true,
      version: 'v3.39.0',
      prefsBadge: '2',
      onOpenPrefs,
      onOpenSkills,
      onOpenHistory,
      onOpenSettings,
      onChangeTheme,
    });
    expect(more.component.element.querySelector('[data-group-item="schedules"]')).toBeNull();
    expect(more.component.element.querySelector('[data-group-item="reviews"]')).toBeNull();
    const navIds = Array.from(
      more.component.element.querySelectorAll<HTMLElement>('.fh-mgroup:first-of-type [data-group-item]'),
    ).map((el) => el.dataset.groupItem);
    expect(navIds).toEqual(['review-prefs', 'skills', 'history', 'settings']);
    more.component.element.querySelector<HTMLButtonElement>('[data-group-item="review-prefs"]')!.click();
    more.component.element.querySelector<HTMLButtonElement>('[data-group-item="skills"]')!.click();
    more.component.element.querySelector<HTMLButtonElement>('[data-group-item="history"]')!.click();
    more.component.element.querySelector<HTMLButtonElement>('[data-group-item="settings"]')!.click();
    expect(onOpenPrefs).toHaveBeenCalledTimes(1);
    expect(onOpenSkills).toHaveBeenCalledTimes(1);
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    more.component.element.querySelector<HTMLButtonElement>('[data-group-item="appearance"]')!.click();
    more.component.element.querySelector<HTMLButtonElement>('[data-radio-value="light"]')!.click();
    expect(onChangeTheme).toHaveBeenCalledWith('light');
    more.component.element.querySelector<HTMLButtonElement>('.wb-stack-subback')!.click();
    expect(more.component.element.querySelector('[data-group-item="history"]')).not.toBeNull();
    more.component.dispose();
  });
});
