import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { DisposableStore } from '../../base/lifecycle.js';
import { icon } from '../../../icons.js';
import type { FilesPanel, FilesSource } from '../../panels/files.js';
import { createInstructionsPanel, type InstructionsPanel } from '../../panels/instructions.js';
import type { PluginContext, SettingsSectionContribution } from '../../plugins/api.js';
import { post as defaultPost, text } from '../../services/api.js';
import { createSettingsFeature } from './controller.js';
import { inlineCodeHtml } from './render.js';
import type { SettingsFeature, SettingsWebMessage } from './types.js';
import {
  isSettingsEditorInput,
  type SettingsEditorInput,
  type SettingsPluginDeps,
  type SettingsRuntime,
  type WorkbenchPanelComponent,
  type WorkbenchPanelInitContext,
} from './workbench-types.js';

interface MountedDeviceSection {
  readonly contribution: SettingsSectionContribution;
  readonly component: WorkbenchPanelComponent;
  readonly wrapper: HTMLElement;
}

interface SettingsEditorDom {
  readonly root: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly topicEl: HTMLElement;
  readonly refreshBtn: HTMLButtonElement;
  readonly pageEl: HTMLElement;
  readonly gatewayPageEl: HTMLElement;
  readonly gatewayBodyEl: HTMLElement;
  readonly emptyGatewayEl: HTMLElement;
  readonly deviceWrapEl: HTMLElement;
  readonly deviceHeadingEl: HTMLElement;
  readonly deviceListEl: HTMLElement;
  readonly hiddenCloseBtn: HTMLButtonElement;
  readonly hiddenOpenBtn: HTMLButtonElement;
}

function buildSettingsEditorDom(doc: Document, ctx: PluginContext): SettingsEditorDom {
  const root = doc.createElement('div');
  root.className = 'wb-set-editor';

  const head = doc.createElement('div');
  head.className = 'wb-set-head';
  head.innerHTML =
    '<div class="wb-set-titles">' +
    '<h2 class="wb-set-title">' +
    text(ctx.i18n.t('settings.title')) +
    '</h2>' +
    '<span class="wb-set-topic"></span>' +
    '</div>' +
    '<div class="wb-set-actions">' +
    '<button type="button" class="fh-btn fh-btn--secondary wb-set-refresh" title="' +
    text(ctx.i18n.t('common.refresh')) +
    '" aria-label="' +
    text(ctx.i18n.t('common.refresh')) +
    '">' +
    icon('refresh') +
    '</button>' +
    '</div>';

  const pageEl = doc.createElement('div');
  pageEl.className = 'wb-set-page';

  const gatewayPageEl = doc.createElement('div');
  gatewayPageEl.className = 'wb-set-gateway';
  gatewayPageEl.hidden = true;

  const gatewayBodyEl = doc.createElement('div');
  gatewayBodyEl.className = 'wb-set-gateway-body';
  gatewayPageEl.appendChild(gatewayBodyEl);

  const emptyGatewayEl = doc.createElement('div');
  emptyGatewayEl.className = 'wb-set-empty';
  emptyGatewayEl.hidden = true;

  const deviceWrapEl = doc.createElement('section');
  deviceWrapEl.className = 'wb-set-device';
  deviceWrapEl.hidden = true;

  const deviceHeadingEl = doc.createElement('h3');
  deviceHeadingEl.className = 'set-group wb-set-device-heading';
  deviceHeadingEl.textContent = ctx.i18n.t('wb.settings.deviceGroup');

  const deviceListEl = doc.createElement('div');
  deviceListEl.className = 'wb-set-device-list';

  deviceWrapEl.append(deviceHeadingEl, deviceListEl);
  pageEl.append(gatewayPageEl, emptyGatewayEl, deviceWrapEl);
  root.append(head, pageEl);

  const hiddenCloseBtn = doc.createElement('button');
  const hiddenOpenBtn = doc.createElement('button');

  return {
    root,
    titleEl: head.querySelector<HTMLElement>('.wb-set-title')!,
    topicEl: head.querySelector<HTMLElement>('.wb-set-topic')!,
    refreshBtn: head.querySelector<HTMLButtonElement>('.wb-set-refresh')!,
    pageEl,
    gatewayPageEl,
    gatewayBodyEl,
    emptyGatewayEl,
    deviceWrapEl,
    deviceHeadingEl,
    deviceListEl,
    hiddenCloseBtn,
    hiddenOpenBtn,
  };
}

function createInstructionBridgeFilesPanel(
  doc: Document,
  runtime: SettingsRuntime,
  getLastClicked: () => { agent?: string; orphans?: boolean },
): FilesPanel {
  let activeSource: FilesSource | null = null;
  const dummyPreview = doc.createElement('div');
  return {
    open(_topic: string, path?: string, src?: FilesSource | null): void {
      activeSource = src ?? null;
      const meta = getLastClicked();
      runtime.openInstruction({
        agent: meta.agent,
        orphans: meta.orphans,
        fileId: path || undefined,
        title: src?.title,
        source: src ?? undefined,
      });
    },
    openEditor(): void {},
    close(): void {
      activeSource = null;
    },
    isOpen: () => activeSource !== null,
    isCustomOpen: () => activeSource !== null,
    paintTree(): void {
      if (activeSource) runtime.notifyTreePaint(activeSource);
    },
    currentSource: () => activeSource,
    previewEl: () => dummyPreview,
    repaint(): void {},
  };
}

function scrollTargetIntoView(el: HTMLElement | null): void {
  if (!el) return;
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'start' });
  }
}

function clearTargetHighlights(root: HTMLElement): void {
  const prev = root.querySelectorAll('.is-target');
  for (let i = 0; i < prev.length; i++) {
    prev[i]?.classList.remove('is-target');
  }
}

function locateSectionElement(dom: SettingsEditorDom, input: SettingsEditorInput): HTMLElement | null {
  if (input.scope === 'device') {
    if (!input.sectionId) return dom.deviceWrapEl.hidden ? null : dom.deviceWrapEl;
    const secs = dom.deviceListEl.querySelectorAll<HTMLElement>('.wb-set-device-sec');
    for (let i = 0; i < secs.length; i++) {
      if (secs[i]?.getAttribute('data-section-id') === input.sectionId) return secs[i] ?? null;
    }
    return null;
  }
  if (!input.sectionId) return dom.gatewayBodyEl;
  if (input.sectionId === 'orphans') {
    return dom.gatewayBodyEl.querySelector<HTMLElement>('[data-instr-orphans]');
  }
  const sections = dom.gatewayBodyEl.querySelectorAll<HTMLElement>('.set-sec');
  for (let i = 0; i < sections.length; i++) {
    const heading = sections[i]?.querySelector<HTMLElement>('.set-group');
    if (heading?.textContent?.trim() === input.sectionId) return sections[i] ?? null;
  }
  return null;
}

function reconcileDeviceSections(
  doc: Document,
  dom: SettingsEditorDom,
  mounted: Map<string, MountedDeviceSection>,
  sections: readonly SettingsSectionContribution[],
  panelCtx: WorkbenchPanelInitContext | null,
): void {
  const allowed = sections.filter((s) => s.scope === 'device');
  const nextIds = new Set(allowed.map((s) => s.id));

  for (const [id, entry] of mounted) {
    if (nextIds.has(id)) continue;
    entry.component.dispose();
    entry.wrapper.remove();
    mounted.delete(id);
  }

  for (const sec of allowed) {
    let entry = mounted.get(sec.id);
    if (!entry) {
      const wrapper = doc.createElement('div');
      wrapper.className = 'wb-set-device-sec';
      wrapper.setAttribute('data-section-id', sec.id);

      const title = doc.createElement('h4');
      title.className = 'wb-set-device-title';
      title.textContent = sec.title;

      const host = doc.createElement('div');
      host.className = 'wb-set-device-body';

      const component = sec.component();
      if (panelCtx) component.init(undefined, panelCtx);
      host.appendChild(component.element);
      wrapper.append(title, host);
      entry = { contribution: sec, component, wrapper };
      mounted.set(sec.id, entry);
    }
    dom.deviceListEl.appendChild(entry.wrapper);
  }

  dom.deviceWrapEl.hidden = allowed.length === 0;
}

export function resolveSettingsEditorTitle(
  ctx: PluginContext,
  runtime: SettingsRuntime,
  input: unknown,
): string {
  if (isSettingsEditorInput(input) && input.sectionId) {
    if (input.scope === 'device') {
      const found = runtime.listDeviceSections().find((s) => s.id === input.sectionId);
      if (found) return `${ctx.i18n.t('settings.title')} · ${found.title}`;
    }
    if (input.scope === 'gateway' && input.sectionId !== 'all') {
      return `${ctx.i18n.t('settings.title')} · ${input.sectionId}`;
    }
  }
  return ctx.i18n.t('settings.title');
}

function bindInstructionClickTracker(
  bodyEl: HTMLElement,
  onPick: (meta: { agent?: string; orphans?: boolean }) => void,
): ReturnType<typeof addDisposableListener> {
  return addDisposableListener(bodyEl, 'click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    if (target.closest('[data-instr-orphans]')) {
      onPick({ orphans: true });
      return;
    }
    const btn = target.closest('[data-instr-agent]');
    const agent = btn?.getAttribute('data-instr-agent');
    if (agent) onPick({ agent });
  });
}

function createSettingsPair(
  doc: Document,
  dom: SettingsEditorDom,
  runtime: SettingsRuntime,
  deps: SettingsPluginDeps,
  filesBridge: FilesPanel,
): { readonly feature: SettingsFeature; readonly instrPanel: InstructionsPanel } {
  const postFn = deps.post ?? defaultPost;
  let instrPanelRef: InstructionsPanel | null = null;
  const feature = createSettingsFeature({
    settingsPage: dom.gatewayPageEl,
    settingsBody: dom.gatewayBodyEl,
    settingsTopicEl: dom.topicEl,
    settingsClose: dom.hiddenCloseBtn,
    settingsOpenBtn: dom.hiddenOpenBtn,
    instrOk: runtime.instrOk,
    getTopic: () => runtime.getTopic(),
    getTopics: () => runtime.getTopics(),
    getEpoch: deps.getEpoch ?? (() => 1),
    closeMenus: () => {},
    instructions: {
      ensure: () => instrPanelRef?.ensure(),
      renderOrphans: () => instrPanelRef?.renderOrphans() ?? '',
      renderAgent: (row, index) => instrPanelRef?.renderAgent(row, index) ?? '',
    },
    post: postFn,
    doc,
    fadeMs: deps.fadeMs,
    waitMs: deps.waitMs,
  });
  const instrPanel = createInstructionsPanel({
    instrOk: runtime.instrOk,
    settingsPage: dom.gatewayPageEl,
    settingsBody: dom.gatewayBodyEl,
    filesPanel: filesBridge,
    getSettingsMsg: () => feature.getMessage(),
    getSettingsTopic: () => feature.getTopic() || '',
    getTopic: () => runtime.getTopic(),
    renderSettings: () => feature.render(),
    text,
    inl: inlineCodeHtml,
    post: (path, body, tries) => postFn(path, body, tries),
  });
  instrPanelRef = instrPanel;
  return { feature, instrPanel };
}

export function createSettingsEditorComponent(
  ctx: PluginContext,
  runtime: SettingsRuntime,
  deps: SettingsPluginDeps,
): WorkbenchPanelComponent {
  const doc = deps.doc ?? document;
  const dom = buildSettingsEditorDom(doc, ctx);
  const disposables = new DisposableStore();
  const mountedDevice = new Map<string, MountedDeviceSection>();

  let panelCtx: WorkbenchPanelInitContext | null = null;
  let pendingTarget: SettingsEditorInput | undefined;
  let lastClickedInstr: { agent?: string; orphans?: boolean } = {};

  const filesBridge = createInstructionBridgeFilesPanel(doc, runtime, () => lastClickedInstr);

  // Track which agent/orphans button was clicked so the instruction editor receives full metadata.
  if (runtime.instrOk) {
    disposables.add(
      bindInstructionClickTracker(dom.gatewayBodyEl, (meta) => {
        lastClickedInstr = meta;
      }),
    );
  }

  const { feature } = createSettingsPair(doc, dom, runtime, deps, filesBridge);
  disposables.add(feature);

  const applyTarget = (input: SettingsEditorInput | undefined): void => {
    pendingTarget = input;
    if (!input) return;
    clearTargetHighlights(dom.root);
    const el = locateSectionElement(dom, input);
    if (!el) return;
    el.classList.add('is-target');
    scrollTargetIntoView(el);
  };

  const syncDeviceSections = (): void => {
    reconcileDeviceSections(doc, dom, mountedDevice, runtime.listDeviceSections(), panelCtx);
    if (pendingTarget?.scope === 'device') applyTarget(pendingTarget);
  };

  const requestGateway = (): void => {
    const topic = runtime.getTopic();
    if (!topic) {
      dom.emptyGatewayEl.textContent = ctx.i18n.t('wb.settings.noTopic');
      dom.emptyGatewayEl.hidden = false;
      return;
    }
    dom.emptyGatewayEl.hidden = true;
    feature.open();
  };

  const handleMessage = (msg: SettingsWebMessage | null | undefined): boolean => {
    const handled = feature.handleMessage(msg);
    if (handled) {
      dom.emptyGatewayEl.hidden = true;
      runtime.setGatewayMessage(feature.getMessage());
      if (pendingTarget?.scope === 'gateway') applyTarget(pendingTarget);
    }
    return handled;
  };

  disposables.add(runtime.registerEditor({ handleMessage, refresh: requestGateway, focusSection: applyTarget }));
  disposables.add(addDisposableListener(dom.refreshBtn, 'click', requestGateway));
  if (runtime.onDidChangeDeviceSections) {
    disposables.add(runtime.onDidChangeDeviceSections(() => syncDeviceSections()));
  }
  disposables.add(
    ctx.events.on('locale.change', () => {
      dom.titleEl.textContent = ctx.i18n.t('settings.title');
      dom.deviceHeadingEl.textContent = ctx.i18n.t('wb.settings.deviceGroup');
      dom.refreshBtn.title = ctx.i18n.t('common.refresh');
      dom.refreshBtn.setAttribute('aria-label', ctx.i18n.t('common.refresh'));
      feature.onLocaleChange();
    }),
  );

  return {
    element: dom.root,
    init(params, initCtx) {
      panelCtx = initCtx;
      const input = isSettingsEditorInput(params) ? params : undefined;
      syncDeviceSections();
      const cached = runtime.getGatewayMessage();
      if (cached) {
        dom.emptyGatewayEl.hidden = true;
        feature.take(cached);
      } else {
        requestGateway();
      }
      applyTarget(input);
    },
    update(params) {
      const input = isSettingsEditorInput(params) ? params : undefined;
      panelCtx?.api.setTitle(resolveSettingsEditorTitle(ctx, runtime, input));
      applyTarget(input);
    },
    focus() {
      focusSafely(dom.refreshBtn);
    },
    dispose() {
      for (const entry of mountedDevice.values()) {
        entry.component.dispose();
      }
      mountedDevice.clear();
      disposables.dispose();
    },
  };
}
