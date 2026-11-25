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
import { StackShell } from './client/workbench/stack-shell.js';
import { WorkbenchShell } from './client/workbench/shell.js';
import { renderPage } from './page.js';

function makeDummyPanel(text: string): PanelComponent {
  const el = document.createElement('div');
  el.textContent = text;
  return {
    element: el,
    init() {},
    dispose() {
      el.remove();
    },
  };
}

describe('wb2-mobile: login, stack-shell, sheet, grouped form, and palette', () => {
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

  it('supports StackShell large title, multi-level push/pop, detail subtitle/badge, and built-in More view', () => {
    const onCloseIdle = vi.fn();
    const onToggleNotifications = vi.fn();
    const onChangeTheme = vi.fn();
    const stack = new StackShell({
      moreState: {
        reviewsBadge: '3 pending',
        skillsCount: 12,
        notificationsEnabled: false,
        lowAttention: false,
        theme: 'system',
        locale: 'en',
        connected: true,
        version: 'v3.39.0',
        runningCount: 2,
        idleCount: 5,
        onCloseIdle,
        onToggleNotifications,
        onChangeTheme,
      },
    });
    document.body.appendChild(stack.element);

    expect(stack.element.querySelector('.wb-stack-large-title')?.textContent).toBe('Topics');

    stack.selectTab('more');
    expect(stack.element.querySelector('.wb-stack-large-title')?.textContent).toBe('More');
    expect(stack.element.querySelector('.wb-stack-more')?.textContent).toContain('3 pending');
    expect(stack.element.querySelector('.wb-stack-more')?.textContent).toContain('v3.39.0');

    const notifySwitch = stack.element.querySelector<HTMLButtonElement>('[data-group-item="notifications"] .fh-switch')!;
    notifySwitch.click();
    expect(onToggleNotifications).toHaveBeenCalledWith(true);

    stack.element.querySelector<HTMLButtonElement>('.fh-mgroup-textbtn')!.click();
    expect(onCloseIdle).toHaveBeenCalledTimes(1);

    stack.element.querySelector<HTMLButtonElement>('[data-group-item="appearance"]')!.click();
    expect(stack.getMode()).toBe('detail');
    expect(stack.getStackDepth()).toBe(1);
    const darkRadio = stack.element.querySelector<HTMLButtonElement>('[data-radio-value="dark"]')!;
    darkRadio.click();
    expect(onChangeTheme).toHaveBeenCalledWith('dark');

    stack.pushPage({
      title: 'Nested page',
      subtitle: 'Details',
      backBadge: 4,
      tools: [{ id: 'nested', title: 'Nested', component: makeDummyPanel('nested body') }],
    });
    expect(stack.getStackDepth()).toBe(2);
    expect(stack.element.querySelector('.wb-stack-subtitle')?.textContent).toBe('Details');
    expect(stack.element.querySelector('.wb-stack-back-badge')?.textContent).toBe('4');

    stack.popPage();
    expect(stack.getStackDepth()).toBe(1);
    expect(stack.getMode()).toBe('detail');

    stack.popPage();
    expect(stack.getStackDepth()).toBe(0);
    expect(stack.getMode()).toBe('list');

    stack.dispose();
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

  it('routes editors.open(kind, input) and openMobileView() into StackShell with multi-level Back on <640px', () => {
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

    const stack = shell.getStackShell();
    expect(shell.openMobileView('settings', 'Settings')).toBe(true);
    expect(stack.getMode()).toBe('detail');
    expect(stack.getStackDepth()).toBe(1);
    expect(stack.element.querySelector('.wb-stack-title')?.textContent).toBe('Settings');
    expect((stack.element.querySelector('.wb-stack-tools') as HTMLElement).hidden).toBe(true);

    const ref = shell.editors.open('settings', { scope: 'gateway', sectionId: 'Delegation' });
    expect(ref).toBeDefined();
    expect(stack.getStackDepth()).toBe(2);
    expect(stack.element.querySelector('.wb-stack-title')?.textContent).toBe('Delegation');
    expect(stack.element.querySelector('[data-mobile-settings-section="Delegation"]')).not.toBeNull();

    shell.editors.open('instruction', { title: 'common.md' });
    expect(stack.getStackDepth()).toBe(3);
    expect(stack.element.querySelector('.wb-stack-title')?.textContent).toBe('common.md');

    // Pop instruction -> back to Delegation -> back to Settings catalog -> back to list
    stack.popPage();
    expect(stack.getStackDepth()).toBe(2);
    expect(disposed).toContain('editor:instruction');
    expect(stack.element.querySelector('.wb-stack-title')?.textContent).toBe('Delegation');

    stack.popPage();
    expect(stack.getStackDepth()).toBe(1);
    expect(disposed).toContain('editor:settings');
    expect(stack.element.querySelector('.wb-stack-title')?.textContent).toBe('Settings');

    stack.popPage();
    expect(stack.getStackDepth()).toBe(0);
    expect(stack.getMode()).toBe('list');
    expect(disposed).toContain('view:settings');

    // Also verify schedule, history, review, review-prefs, skill all push to StackShell
    for (const kind of ['schedule', 'history', 'review', 'review-prefs', 'skill']) {
      shell.editors.open(kind, { title: `${kind}-page` });
      expect(stack.getMode()).toBe('detail');
      expect(stack.element.querySelector('.wb-stack-title')?.textContent).toBe(`${kind}-page`);
      stack.popPage();
      expect(stack.getMode()).toBe('list');
    }

    shell.dispose();
  });
});
