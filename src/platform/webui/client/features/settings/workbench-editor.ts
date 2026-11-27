import { addDisposableListener, focusSafely } from '../../base/dom.js';
import { DisposableStore } from '../../base/lifecycle.js';
import { icon } from '../../../icons.js';
import { createInstructionsController, type InstructionsController } from './instructions-source.js';
import type { PluginContext, SettingsSectionContribution } from '../../plugins/api.js';
import { post as defaultPost, text } from '../../services/api.js';
import { createSettingsFeature } from './controller.js';
import { inlineCodeHtml } from './render.js';
import {
  applyModifiedIndicators,
  applySettingsFilter,
  captureBaseline,
  computeModifiedMap,
  type SettingBaselineEntry,
} from './search-modified.js';
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
  readonly toolbarEl: HTMLElement;
  readonly searchInput: HTMLInputElement;
  readonly searchClearBtn: HTMLButtonElement;
  readonly searchCountEl: HTMLElement;
  readonly modFilterBtn: HTMLButtonElement;
  readonly searchEmptyEl: HTMLElement;
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
    '</div>' +
    '<div class="wb-set-actions">' +
    '<span class="wb-set-topic">' +
    text(ctx.i18n.t('wb.settings.gatewaySubtitle')) +
    '</span>' +
    '<button type="button" class="fh-btn fh-btn--ghost fh-btn--icon wb-set-refresh" title="' +
    text(ctx.i18n.t('common.refresh')) +
    '" aria-label="' +
    text(ctx.i18n.t('common.refresh')) +
    '">' +
    icon('refresh') +
    '</button>' +
    '</div>';

  const pageEl = doc.createElement('div');
  pageEl.className = 'wb-set-page';
  const colEl = doc.createElement('div');
  colEl.className = 'wb-set-col';

  const toolbarEl = doc.createElement('div');
  toolbarEl.className = 'wb-set-toolbar';
  toolbarEl.innerHTML =
    '<div class="wb-set-search-box">' +
    '<span class="wb-set-search-icon" aria-hidden="true">' +
    icon('search') +
    '</span>' +
    '<input type="search" class="wb-set-search-input" placeholder="' +
    text(ctx.i18n.t('wb.settings.searchPlaceholder')) +
    '" aria-label="' +
    text(ctx.i18n.t('wb.settings.searchPlaceholder')) +
    '">' +
    '<button type="button" class="wb-set-search-clear" hidden title="' +
    text(ctx.i18n.t('wb.settings.clearSearch')) +
    '" aria-label="' +
    text(ctx.i18n.t('wb.settings.clearSearch')) +
    '">' +
    icon('cross') +
    '</button>' +
    '</div>' +
    '<span class="wb-set-search-count" role="status" hidden></span>' +
    '<button type="button" class="fh-btn fh-btn--secondary wb-set-mod-filter" aria-pressed="false" hidden></button>';

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

  const searchEmptyEl = doc.createElement('div');
  searchEmptyEl.className = 'wb-set-search-empty';
  searchEmptyEl.textContent = ctx.i18n.t('wb.settings.noMatch');
  searchEmptyEl.hidden = true;

  deviceWrapEl.append(deviceHeadingEl, deviceListEl);
  colEl.append(gatewayPageEl, emptyGatewayEl, deviceWrapEl, searchEmptyEl);
  pageEl.appendChild(colEl);
  root.append(head, toolbarEl, pageEl);

  const hiddenCloseBtn = doc.createElement('button');
  const hiddenOpenBtn = doc.createElement('button');

  return {
    root,
    titleEl: head.querySelector<HTMLElement>('.wb-set-title')!,
    topicEl: head.querySelector<HTMLElement>('.wb-set-topic')!,
    refreshBtn: head.querySelector<HTMLButtonElement>('.wb-set-refresh')!,
    toolbarEl,
    searchInput: toolbarEl.querySelector<HTMLInputElement>('.wb-set-search-input')!,
    searchClearBtn: toolbarEl.querySelector<HTMLButtonElement>('.wb-set-search-clear')!,
    searchCountEl: toolbarEl.querySelector<HTMLElement>('.wb-set-search-count')!,
    modFilterBtn: toolbarEl.querySelector<HTMLButtonElement>('.wb-set-mod-filter')!,
    searchEmptyEl,
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
const SCROLL_SPY_THRESHOLD_PX = 24;
const SCROLL_LOCK_MS = 450;

interface ScrollSpySection {
  readonly el: HTMLElement;
  readonly scope: 'gateway' | 'device';
  readonly sectionId: string;
}

interface ScrollSpyHandle {
  lock(): void;
  dispose(): void;
}

function scrollSectionIntoPage(pageEl: HTMLElement, el: HTMLElement): void {
  if (typeof pageEl.scrollTo === 'function') {
    const pageRect = pageEl.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const top = Math.max(0, pageEl.scrollTop + (elRect.top - pageRect.top) - 16);
    pageEl.scrollTo({ top, behavior: 'smooth' });
    return;
  }
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
  if (!input.sectionId) return dom.gatewayPageEl.hidden ? null : dom.gatewayBodyEl;
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

function isTargetHiddenByFilter(
  dom: SettingsEditorDom,
  el: HTMLElement | null,
  input: SettingsEditorInput,
): boolean {
  if (input.scope === 'device' && dom.deviceWrapEl.hidden) return true;
  return el ? el.hidden : false;
}

function collectVisibleSections(dom: SettingsEditorDom): ScrollSpySection[] {
  const out: ScrollSpySection[] = [];
  if (!dom.gatewayPageEl.hidden) {
    const gwSections = dom.gatewayBodyEl.querySelectorAll<HTMLElement>('.set-sec');
    for (let i = 0; i < gwSections.length; i++) {
      const sec = gwSections[i];
      if (!sec || sec.hidden) continue;
      const heading = sec.querySelector<HTMLElement>('.set-group')?.textContent?.trim();
      if (heading) out.push({ el: sec, scope: 'gateway', sectionId: heading });
    }
  }
  if (!dom.deviceWrapEl.hidden) {
    const devSections = dom.deviceListEl.querySelectorAll<HTMLElement>('.wb-set-device-sec');
    for (let i = 0; i < devSections.length; i++) {
      const sec = devSections[i];
      if (!sec || sec.hidden) continue;
      const sectionId = sec.getAttribute('data-section-id')?.trim();
      if (sectionId) out.push({ el: sec, scope: 'device', sectionId });
    }
  }
  return out;
}

function pickActiveSection(
  pageEl: HTMLElement,
  sections: readonly ScrollSpySection[],
  threshold: number,
): ScrollSpySection | undefined {
  if (sections.length === 0) return undefined;
  const scrollable = pageEl.scrollHeight > pageEl.clientHeight;
  if (scrollable && pageEl.scrollTop + pageEl.clientHeight >= pageEl.scrollHeight - 2) {
    return sections[sections.length - 1];
  }
  const containerTop = pageEl.getBoundingClientRect().top;
  let active = sections[0];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (!sec) continue;
    if (sec.el.getBoundingClientRect().top - containerTop <= threshold) {
      active = sec;
    }
  }
  return active;
}

function createScrollSpy(
  dom: SettingsEditorDom,
  runtime: SettingsRuntime,
  isValuesScreen: () => boolean,
): ScrollSpyHandle {
  const subs = new DisposableStore();
  let locked = false;
  let lockTimer: ReturnType<typeof setTimeout> | null = null;
  let rafId: number | null = null;

  const clearLockTimer = (): void => {
    if (lockTimer !== null) {
      clearTimeout(lockTimer);
      lockTimer = null;
    }
  };

  const unlock = (): void => {
    locked = false;
    clearLockTimer();
  };

  const lock = (): void => {
    locked = true;
    clearLockTimer();
    lockTimer = setTimeout(() => {
      locked = false;
      lockTimer = null;
    }, SCROLL_LOCK_MS);
  };

  const syncFromScroll = (): void => {
    rafId = null;
    if (locked || isValuesScreen()) return;
    const active = pickActiveSection(dom.pageEl, collectVisibleSections(dom), SCROLL_SPY_THRESHOLD_PX);
    if (!active) return;
    const cur = runtime.getSelection();
    if (cur?.scope === active.scope && cur.sectionId === active.sectionId) return;
    runtime.setSelection({ scope: active.scope, sectionId: active.sectionId });
  };

  const onScroll = (): void => {
    if (locked || rafId !== null) return;
    rafId = globalThis.requestAnimationFrame(syncFromScroll);
  };

  subs.add(addDisposableListener(dom.pageEl, 'scroll', onScroll, { passive: true }));
  subs.add(addDisposableListener(dom.pageEl, 'wheel', unlock, { passive: true }));
  subs.add(addDisposableListener(dom.pageEl, 'touchstart', unlock, { passive: true }));
  subs.add(addDisposableListener(dom.pageEl, 'pointerdown', unlock, { passive: true }));

  return {
    lock,
    dispose() {
      unlock();
      if (rafId !== null) {
        globalThis.cancelAnimationFrame(rafId);
        rafId = null;
      }
      subs.dispose();
    },
  };
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

export function resolveSettingsEditorTitle(ctx: PluginContext): string {
  return ctx.i18n.t('settings.title');
}

function createSettingsPair(
  doc: Document,
  dom: SettingsEditorDom,
  runtime: SettingsRuntime,
  deps: SettingsPluginDeps,
  onAfterRender: () => void,
): { readonly feature: SettingsFeature; readonly instrPanel: InstructionsController } {
  const postFn = deps.post ?? defaultPost;
  let instrPanelRef: InstructionsController | null = null;
  const feature = createSettingsFeature({
    settingsPage: dom.gatewayPageEl,
    settingsBody: dom.gatewayBodyEl,
    settingsTopicEl: doc.createElement('span'),
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
  const instrPanel = createInstructionsController({
    instrOk: runtime.instrOk,
    settingsPage: dom.gatewayPageEl,
    settingsBody: dom.gatewayBodyEl,
    onOpen: (ev) => {
      runtime.openInstruction({
        agent: ev.agent,
        orphans: ev.orphans,
        fileId: ev.fileId,
        title: ev.title,
        source: ev.source,
      });
    },
    onPaintTree: (src) => runtime.notifyTreePaint(src),
    getSettingsMsg: () => feature.getMessage(),
    renderSettings: () => {
      feature.render();
      onAfterRender();
    },
    text,
    inl: inlineCodeHtml,
    post: (path, body, tries) => postFn(path, body, tries),
  });
  instrPanelRef = instrPanel;
  return { feature, instrPanel };
}

function syncSearchAndModified(
  doc: Document,
  ctx: PluginContext,
  dom: SettingsEditorDom,
  feature: SettingsFeature,
  baseline: Map<string, SettingBaselineEntry>,
  modifiedOnly: boolean,
): { modifiedCount: number; modifiedOnly: boolean } {
  const msg = feature.getMessage();
  const screen = msg?.settings;
  const isValues = screen?.level === 'values';
  dom.toolbarEl.hidden = isValues;
  if (isValues) {
    dom.searchEmptyEl.hidden = true;
    return { modifiedCount: 0, modifiedOnly };
  }
  let modifiedCount = 0;
  if (screen && screen.level === 'list') {
    captureBaseline(screen, baseline);
    const modified = computeModifiedMap(screen, baseline);
    modifiedCount = modified.size;
    applyModifiedIndicators(doc, dom.gatewayBodyEl, screen, modified, {
      modifiedBadge: ctx.i18n.t('wb.settings.modified'),
      resetLabel: ctx.i18n.t('wb.settings.reset'),
      initialTitle: (v) => ctx.i18n.t('wb.settings.initialValue', { value: v || ctx.i18n.t('settings.notSet') }),
    });
  }
  const nextModifiedOnly = modifiedCount > 0 ? modifiedOnly : false;
  dom.modFilterBtn.hidden = modifiedCount === 0;
  dom.modFilterBtn.textContent = ctx.i18n.t('wb.settings.modifiedFilter', { count: modifiedCount });
  dom.modFilterBtn.setAttribute('aria-pressed', nextModifiedOnly ? 'true' : 'false');
  dom.modFilterBtn.classList.toggle('is-active', nextModifiedOnly);

  const query = dom.searchInput.value;
  const hasQuery = query.trim().length > 0;
  dom.searchClearBtn.hidden = !hasQuery && !nextModifiedOnly;
  const counts = applySettingsFilter(dom.gatewayBodyEl, dom.deviceWrapEl, dom.deviceListEl, query, nextModifiedOnly);
  const filtering = hasQuery || nextModifiedOnly;
  dom.searchCountEl.hidden = !filtering;
  if (filtering) {
    dom.searchCountEl.textContent = ctx.i18n.t('wb.settings.matchCount', {
      matched: counts.matched,
      total: counts.total,
    });
  }
  dom.searchEmptyEl.hidden = !(filtering && counts.matched === 0);
  return { modifiedCount, modifiedOnly: nextModifiedOnly };
}

function bindResetClickHandler(
  bodyEl: HTMLElement,
  feature: SettingsFeature,
  runtime: SettingsRuntime,
  postFn: NonNullable<SettingsPluginDeps['post']>,
  waitMs?: number,
): ReturnType<typeof addDisposableListener> {
  return addDisposableListener(
    bodyEl,
    'click',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const resetBtn = target?.closest<HTMLButtonElement>('[data-reset-btn]');
      if (!resetBtn || resetBtn.disabled) return;
      e.stopPropagation();
      const buttonId = resetBtn.getAttribute('data-reset-btn');
      const msg = feature.getMessage();
      const topic = feature.getTopic() || runtime.getTopic();
      if (!buttonId || !msg || !topic) return;
      resetBtn.disabled = true;
      resetBtn.classList.add('busy');
      void postFn('api/click', { topic, messageId: msg.id, buttonId }, 2, waitMs);
    },
    true,
  );
}

function applyLocaleStrings(ctx: PluginContext, dom: SettingsEditorDom): void {
  dom.titleEl.textContent = ctx.i18n.t('settings.title');
  dom.topicEl.textContent = ctx.i18n.t('wb.settings.gatewaySubtitle');
  dom.deviceHeadingEl.textContent = ctx.i18n.t('wb.settings.deviceGroup');
  dom.refreshBtn.title = ctx.i18n.t('common.refresh');
  dom.refreshBtn.setAttribute('aria-label', ctx.i18n.t('common.refresh'));
  dom.searchInput.placeholder = ctx.i18n.t('wb.settings.searchPlaceholder');
  dom.searchInput.setAttribute('aria-label', ctx.i18n.t('wb.settings.searchPlaceholder'));
  dom.searchClearBtn.title = ctx.i18n.t('wb.settings.clearSearch');
  dom.searchClearBtn.setAttribute('aria-label', ctx.i18n.t('wb.settings.clearSearch'));
  dom.searchEmptyEl.textContent = ctx.i18n.t('wb.settings.noMatch');
}

interface EditorListenerBindings {
  readonly ctx: PluginContext;
  readonly dom: SettingsEditorDom;
  readonly runtime: SettingsRuntime;
  readonly feature: SettingsFeature;
  readonly postFn: NonNullable<SettingsPluginDeps['post']>;
  readonly waitMs?: number;
  readonly requestGateway: () => void;
  readonly refreshSearchState: () => void;
  readonly clearSearchFilter: () => void;
  readonly toggleModifiedFilter: () => void;
  readonly syncDeviceSections: () => void;
}

function bindEditorListeners(disposables: DisposableStore, b: EditorListenerBindings): void {
  disposables.add(addDisposableListener(b.dom.refreshBtn, 'click', b.requestGateway));
  disposables.add(addDisposableListener(b.dom.searchInput, 'input', b.refreshSearchState));
  disposables.add(addDisposableListener(b.dom.searchClearBtn, 'click', b.clearSearchFilter));
  disposables.add(addDisposableListener(b.dom.modFilterBtn, 'click', b.toggleModifiedFilter));
  disposables.add(bindResetClickHandler(b.dom.gatewayBodyEl, b.feature, b.runtime, b.postFn, b.waitMs));
  if (b.runtime.onDidChangeDeviceSections) {
    disposables.add(b.runtime.onDidChangeDeviceSections(b.syncDeviceSections));
  }
  disposables.add(
    b.ctx.events.on('locale.change', () => {
      applyLocaleStrings(b.ctx, b.dom);
      b.feature.onLocaleChange();
      b.refreshSearchState();
    }),
  );
}

interface TargetNavigator {
  applyTarget(input: SettingsEditorInput | undefined): void;
  selectFirstVisibleIfUnset(): void;
  onGatewayRendered(): void;
  onDeviceSynced(gatewayReady: boolean): void;
}

function createTargetNavigator(
  dom: SettingsEditorDom,
  runtime: SettingsRuntime,
  scrollSpy: ScrollSpyHandle,
  hasActiveFilter: () => boolean,
  clearFilter: () => void,
): TargetNavigator {
  let pendingScrollTarget: SettingsEditorInput | undefined;
  let hasInitialSelection = Boolean(runtime.getSelection()?.sectionId);

  const selectFirstVisibleIfUnset = (): void => {
    if (hasInitialSelection || runtime.getSelection()?.sectionId) return;
    const first = collectVisibleSections(dom)[0];
    if (!first) return;
    hasInitialSelection = true;
    runtime.setSelection({ scope: first.scope, sectionId: first.sectionId });
  };

  const applyTarget = (input: SettingsEditorInput | undefined): void => {
    if (!input || (input.scope === undefined && input.sectionId === undefined)) {
      pendingScrollTarget = undefined;
      return;
    }
    if (input.sectionId) hasInitialSelection = true;
    let el = locateSectionElement(dom, input);
    if (hasActiveFilter() && isTargetHiddenByFilter(dom, el, input)) {
      clearFilter();
      el = locateSectionElement(dom, input);
    }
    if (!el) {
      pendingScrollTarget = input;
      return;
    }
    pendingScrollTarget = undefined;
    clearTargetHighlights(dom.root);
    el.classList.add('is-target');
    scrollSpy.lock();
    scrollSectionIntoPage(dom.pageEl, el);
  };

  return {
    applyTarget,
    selectFirstVisibleIfUnset,
    onGatewayRendered() {
      if (pendingScrollTarget?.scope === 'gateway') {
        applyTarget(pendingScrollTarget);
      } else {
        selectFirstVisibleIfUnset();
      }
    },
    onDeviceSynced(gatewayReady) {
      if (pendingScrollTarget?.scope === 'device') {
        applyTarget(pendingScrollTarget);
      } else if (gatewayReady) {
        selectFirstVisibleIfUnset();
      }
    },
  };
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
  const baseline = new Map<string, SettingBaselineEntry>();
  const postFn = deps.post ?? defaultPost;

  let panelCtx: WorkbenchPanelInitContext | null = null;
  let modifiedOnly = false;
  let featureRef: SettingsFeature | null = null;
  let updateSeq = 0;

  const refreshSearchState = (): void => {
    if (!featureRef) return;
    const res = syncSearchAndModified(doc, ctx, dom, featureRef, baseline, modifiedOnly);
    modifiedOnly = res.modifiedOnly;
  };

  const clearFilters = (): void => {
    dom.searchInput.value = '';
    modifiedOnly = false;
    refreshSearchState();
  };

  const { feature } = createSettingsPair(doc, dom, runtime, deps, refreshSearchState);
  featureRef = feature;
  disposables.add(feature);

  const scrollSpy = createScrollSpy(dom, runtime, () => feature.getMessage()?.settings?.level === 'values');
  disposables.add(scrollSpy);

  const nav = createTargetNavigator(
    dom,
    runtime,
    scrollSpy,
    () => dom.searchInput.value.trim().length > 0 || modifiedOnly,
    clearFilters,
  );

  const syncDeviceSections = (): void => {
    reconcileDeviceSections(doc, dom, mountedDevice, runtime.listDeviceSections(), panelCtx);
    refreshSearchState();
    nav.onDeviceSynced(!runtime.getTopic() || Boolean(feature.getMessage()));
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
      if (feature.getMessage()) dom.gatewayPageEl.hidden = false;
      runtime.setGatewayMessage(feature.getMessage());
      refreshSearchState();
      nav.onGatewayRendered();
    }
    return handled;
  };

  disposables.add(
    runtime.registerEditor({
      handleMessage,
      refresh: requestGateway,
      focusSection: nav.applyTarget,
      getUpdateSeq: () => updateSeq,
    }),
  );
  bindEditorListeners(disposables, {
    ctx,
    dom,
    runtime,
    feature,
    postFn,
    waitMs: deps.waitMs,
    requestGateway,
    refreshSearchState,
    clearSearchFilter: () => {
      clearFilters();
      focusSafely(dom.searchInput);
    },
    toggleModifiedFilter: () => {
      modifiedOnly = !modifiedOnly;
      refreshSearchState();
    },
    syncDeviceSections,
  });

  return {
    element: dom.root,
    init(params, initCtx) {
      updateSeq++;
      panelCtx = initCtx;
      const input = isSettingsEditorInput(params) ? params : undefined;
      syncDeviceSections();
      const cached = runtime.getGatewayMessage();
      if (cached) {
        dom.emptyGatewayEl.hidden = true;
        feature.take(cached);
        dom.gatewayPageEl.hidden = false;
        refreshSearchState();
      } else {
        requestGateway();
      }
      nav.applyTarget(input);
      if (!input?.sectionId && (cached || !runtime.getTopic())) {
        nav.selectFirstVisibleIfUnset();
      }
    },
    update(params) {
      updateSeq++;
      const input = isSettingsEditorInput(params) ? params : undefined;
      panelCtx?.api.setTitle(resolveSettingsEditorTitle(ctx));
      nav.applyTarget(input);
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
