import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { DisposableStore } from '../../base/lifecycle.js';
import { createList, type ListGroup, type ListItem } from '../../components/index.js';
import { icon } from '../../../icons.js';
import type { PluginContext } from '../../plugins/api.js';
import { text } from '../../services/api.js';
import type {
  SettingsEditorInput,
  SettingsPluginDeps,
  SettingsRuntime,
  WorkbenchPanelComponent,
} from './workbench-types.js';

interface CatalogItemData {
  readonly scope: 'gateway' | 'device';
  readonly sectionId: string;
  readonly kind: 'group' | 'orphans' | 'instructions' | 'device';
}

function itemKey(scope: 'gateway' | 'device', sectionId: string): string {
  return `${scope}:${sectionId}`;
}

function buildCatalogGroups(
  ctx: PluginContext,
  runtime: SettingsRuntime,
  query: string,
): ListGroup<CatalogItemData>[] {
  const q = query.trim().toLowerCase();
  const matches = (label: string, id: string): boolean =>
    !q || label.toLowerCase().includes(q) || id.toLowerCase().includes(q);

  const gwSections = runtime.getGatewaySections();
  const gwItems: ListItem<CatalogItemData>[] = [];
  if (gwSections.length === 0) {
    const label = ctx.i18n.t('menu.allSettings');
    if (matches(label, 'all')) {
      gwItems.push({
        id: itemKey('gateway', 'all'),
        label,
        data: { scope: 'gateway', sectionId: 'all', kind: 'group' },
      });
    }
  } else {
    for (const sec of gwSections) {
      if (!matches(sec.label, sec.id)) continue;
      gwItems.push({
        id: itemKey('gateway', sec.id),
        label: sec.label,
        trailing: sec.count !== undefined ? String(sec.count) : undefined,
        data: { scope: 'gateway', sectionId: sec.id, kind: sec.kind },
      });
    }
  }
  if (runtime.instrOk) {
    const instrLabel = ctx.i18n.t('wb.settings.instrLabel');
    if (matches(instrLabel, 'instructions')) {
      gwItems.push({
        id: itemKey('gateway', 'instructions'),
        label: instrLabel,
        data: { scope: 'gateway', sectionId: 'instructions', kind: 'instructions' },
      });
    }
  }

  const devSections = runtime.listDeviceSections();
  const devItems: ListItem<CatalogItemData>[] = [];
  for (const sec of devSections) {
    if (sec.scope !== 'device') continue;
    if (!matches(sec.title, sec.id)) continue;
    devItems.push({
      id: itemKey('device', sec.id),
      label: sec.title,
      data: { scope: 'device', sectionId: sec.id, kind: 'device' },
    });
  }

  const groups: ListGroup<CatalogItemData>[] = [];
  if (gwItems.length > 0) {
    groups.push({
      id: 'gateway',
      label: ctx.i18n.t('wb.settings.gatewayGroup'),
      items: gwItems,
    });
  }
  if (devItems.length > 0) {
    groups.push({
      id: 'device',
      label: ctx.i18n.t('wb.settings.deviceGroup'),
      items: devItems,
    });
  }
  return groups;
}

function selectedKeyFrom(input: SettingsEditorInput | undefined): string | null {
  if (!input?.scope || !input.sectionId) return null;
  return itemKey(input.scope, input.sectionId);
}

export function createSettingsCatalogComponent(
  ctx: PluginContext,
  runtime: SettingsRuntime,
  deps: SettingsPluginDeps,
): WorkbenchPanelComponent {
  const doc = deps.doc ?? document;
  const disposables = new DisposableStore();

  const root = doc.createElement('div');
  root.className = 'wb-set-catalog';

  const head = doc.createElement('div');
  head.className = 'wb-set-cat-head';
  head.innerHTML = '<span class="wb-set-cat-title">' + text(ctx.i18n.t('settings.title')) + '</span>';

  const searchWrap = doc.createElement('div');
  searchWrap.className = 'wb-set-cat-search';
  searchWrap.innerHTML =
    '<span class="wb-set-cat-search-icon" aria-hidden="true">' +
    icon('search') +
    '</span>' +
    '<input type="search" class="wb-set-cat-input" placeholder="' +
    text(ctx.i18n.t('wb.settings.searchPlaceholder')) +
    '" aria-label="' +
    text(ctx.i18n.t('wb.settings.searchPlaceholder')) +
    '">';

  const searchInput = searchWrap.querySelector<HTMLInputElement>('.wb-set-cat-input')!;
  const titleEl = head.querySelector<HTMLElement>('.wb-set-cat-title')!;
  const listHost = doc.createElement('div');
  listHost.className = 'wb-set-cat-list';
  const mobileFooter = doc.createElement('div');
  mobileFooter.className = 'wb-set-cat-footer';
  mobileFooter.textContent = ctx.i18n.t('wb.settings.mobileGatewayFooter');

  root.append(head, searchWrap, listHost, mobileFooter);

  const openFromItem = (item: ListItem<CatalogItemData>): void => {
    const data = item.data;
    if (!data) return;
    if (data.kind === 'orphans') {
      runtime.openInstruction({ orphans: true });
      return;
    }
    if (data.kind === 'instructions') {
      runtime.setSelection({ scope: 'gateway', sectionId: 'instructions' });
      runtime.openInstruction({ all: true });
      return;
    }
    const next: SettingsEditorInput = {
      scope: data.scope,
      sectionId: data.sectionId === 'all' ? undefined : data.sectionId,
    };
    runtime.setSelection(next);
    runtime.openSettings(next);
  };

  const list = createList<CatalogItemData>({
    groups: buildCatalogGroups(ctx, runtime, ''),
    selectedId: selectedKeyFrom(runtime.getSelection()),
    ariaLabel: ctx.i18n.t('settings.title'),
    empty: { title: ctx.i18n.t('files.noMatches') },
    onActivate: openFromItem,
  });
  disposables.add(list);
  listHost.appendChild(list.el);

  const refresh = (): void => {
    list.setGroups(buildCatalogGroups(ctx, runtime, searchInput.value));
    list.setSelected(selectedKeyFrom(runtime.getSelection()));
  };

  disposables.add(addDisposableListener(searchInput, 'input', refresh));
  disposables.add(runtime.onDidChangeGateway(refresh));
  disposables.add(runtime.onDidChangeSelection(refresh));
  if (runtime.onDidChangeDeviceSections) {
    disposables.add(runtime.onDidChangeDeviceSections(refresh));
  }
  disposables.add(
    ctx.events.on('locale.change', () => {
      titleEl.textContent = ctx.i18n.t('settings.title');
      searchInput.placeholder = ctx.i18n.t('wb.settings.searchPlaceholder');
      searchInput.setAttribute('aria-label', ctx.i18n.t('wb.settings.searchPlaceholder'));
      mobileFooter.textContent = ctx.i18n.t('wb.settings.mobileGatewayFooter');
      refresh();
    }),
  );

  return {
    element: root,
    init() {
      refresh();
    },
    update() {
      refresh();
    },
    focus() {
      focusSafely(searchInput);
    },
    dispose() {
      disposables.dispose();
    },
  };
}
