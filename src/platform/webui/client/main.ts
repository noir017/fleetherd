// Web UI client entrypoint: services, WorkbenchShell, ContributionRegistry, 12 built-in plugins,
// SSE stream dispatch, login gate, and startup sequence.
// Bundled by `scripts/webui-client.mjs` into `dist/webui-assets/app-<hash>.js` with two build-time
// markers replaced before bundling with `clientIcons()` (`icons.ts`) and `CACHE_CORE` (`cache-script.ts`).

import type { OfflineMachine, SlashCommandSpec } from '../../../types.js';
import type { WebEvent, WebMessage } from '../protocol.js';
import type { Topic } from '../topics.js';
import { Emitter } from './base/event.js';
import type { ClientIconsBundle } from './build-markers.d.ts';
import { createCodeViewLoader } from './features/reader/index.js';
import { inlineCodeHtml as inl } from './features/settings/render.js';
import type { SettingsPluginBridge } from './features/settings/plugin.js';
import { createStatusNotifyBridge } from './features/status/notify-bridge.js';
import type { StatusNotifyBridge, StatusPluginError } from './features/status/types.js';
import { TERMINAL_TOGGLE_COMMAND } from './features/terminal/plugin.js';
import type { LocalBubbleMessage } from './features/topic/composer/index.js';
import type { ComposerTopicStatusBridge } from './features/topic/composer/types.js';
import type { TopicEditorElements, TopicEditorHandle } from './features/topic/editor/index.js';
import { stClock } from './features/topic/status/index.js';
import type { HandoffAction, LaunchChoice, TranscriptMessage, WorkdirScreen } from './features/topic/transcript/index.js';
import { isRowCurrent, type TopicSnapshotPayload } from './features/topics/index.js';
import { applyDomI18n, getLocale, initLocale, onLocaleChange, setLocale, t as tr } from './i18n/index.js';
import { getTheme, setTheme } from './theme.js';
import type { TopicInfo } from './plugins/api.js';
import {
  createDefaultBuiltinPluginFactories,
  registerBuiltinPlugins,
  type BuiltinPluginsDeps,
} from './plugins/builtin.js';
import { PluginManager } from './plugins/host.js';
import { ExternalPluginLoader, type PluginLoadFailure } from './plugins/loader.js';
import { ContributionRegistry, WebuiEventBus } from './plugins/registry.js';
import { createApiClient, post, type ApiClient } from './services/api.js';
import { readBootConfig, type BootConfig } from './services/boot.js';
import {
  collectCacheableMessages,
  createCacheService,
  type CacheCopy,
  type CacheCore,
  type CacheMessage,
  type CacheService,
} from './services/cache.js';
import { CommandRegistry } from './services/commands.js';
import { KeybindingService } from './services/keybindings.js';
import { OverlayManager } from './services/overlays.js';
import { createReadsService, type ReadsService } from './services/reads.js';
import { StorageService } from './services/storage.js';
import {
  applyTopicRows,
  createStreamClient,
  type StreamClient,
  type StreamEventPayload,
} from './services/stream.js';
import { mountWorkbench, type WorkbenchShell } from './workbench/shell.js';

const READER_OPEN_COMMAND = 'reader.open';
const READER_OPEN_IMAGE_COMMAND = 'reader.openImage';
const LOCAL_CACHE_WAIT_MS = 300;
const AUTO_FILL_TOP_BUFFER_PX = 240;
const MAX_AUTO_FILL_PAGES = 3;

interface CacheCoreBundle extends CacheCore {
  readonly snapshotMsgs: (d: TopicSnapshotPayload) => CacheMessage[];
}

interface TopicEditorSession {
  panelId: string;
  pinned: boolean;
  editor: TopicEditorHandle | null;
  topicId: string;
  data: Record<string, TranscriptMessage | undefined>;
  els: Record<string, HTMLElement | undefined>;
  synced: boolean;
  entering: boolean;
  stale: boolean;
  launch: LaunchChoice | null;
  launchWdSeq: number;
  launchSetupTopic: string;
  launchSetupSeq: number;
  seedWorkdir: WorkdirScreen | null;
  settleOnResume: boolean;
  enterToken: number;
  hasMore: boolean;
  oldestSeq: number;
  loadingOlder: boolean;
  olderError: boolean;
  autoFillPages: number;
  resumeHealAttempted: boolean;
}

interface AppState {
  topics: Topic[];
  topic: string;
  focusedPanelId: string;
  epoch: number;
  epochConfirmed: boolean;
  offline: OfflineMachine[];
  commands: SlashCommandSpec[];
  sessions: Map<string, TopicEditorSession>;
  sessionByRoot: WeakMap<HTMLElement, TopicEditorSession>;
  bootstrapped: boolean;
  creatingTopic: boolean;
  readonly workdirCache: Map<string, WorkdirScreen>;
  insertHandler: ((topicId: string, text: string) => boolean) | null;
  settingsBridge: SettingsPluginBridge | null;
  streamConnected: boolean;
  pendingJumpMsgId: string;
}

interface AppRuntime {
  readonly boot: BootConfig;
  readonly icons: ClientIconsBundle;
  readonly storage: StorageService;
  readonly overlays: OverlayManager;
  readonly commands: CommandRegistry;
  readonly keybindings: KeybindingService;
  readonly api: ApiClient;
  readonly events: WebuiEventBus;
  readonly registry: ContributionRegistry;
  readonly shell: WorkbenchShell;
  readonly pluginManager: PluginManager;
  readonly cacheCore: CacheCoreBundle;
  readonly codeView: ReturnType<typeof createCodeViewLoader>;
  readonly updateEmitter: Emitter<boolean>;
  readonly externalPluginErrors: StatusPluginError[];
  readonly externalPluginErrorEmitter: Emitter<StatusPluginError>;
  readonly state: AppState;
  readonly gate: HTMLElement | null;
  readonly gateForm: HTMLFormElement | null;
  readonly secretInput: HTMLInputElement | null;
  readonly errEl: HTMLElement | null;
  readonly workbenchRoot: HTMLElement;
  readonly notifyBridge: StatusNotifyBridge;
  streamClient: StreamClient;
  cacheService: CacheService;
  readsService: ReadsService;
  externalPluginsStarted: boolean;
  externalPluginLoader?: ExternalPluginLoader;
}

function loadCacheCore(): CacheCoreBundle {
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- replaced at build time with CACHE_CORE
  __FH_CACHE_CORE__;
  return { STORE, cacheOpen, newer, cacheRecord, cachePut, cacheEvict, snapshotMsgs };
}

function keyOf(m: TranscriptMessage): string {
  return m._local ? m.id : `${m._g}:${m.id}`;
}

function isHistory(state: AppState, m: TranscriptMessage | undefined): boolean {
  return Boolean(m) && !m?._local && state.epoch !== 0 && m?._g !== state.epoch;
}

function toTopicInfos(topics: readonly Topic[]): readonly TopicInfo[] {
  return topics as unknown as readonly TopicInfo[];
}

function topicById(state: AppState, id: string): Topic | undefined {
  return state.topics.find((t) => t.id === id);
}

function currentTopicUrl(topicId: string): string {
  const url = new URL(location.href);
  if (topicId) url.searchParams.set('t', topicId);
  else url.searchParams.delete('t');
  return `${url.pathname}${url.search}${url.hash}`;
}

function readInitialJumpMsgId(): string {
  const fromQuery = new URLSearchParams(location.search).get('m');
  if (fromQuery) return fromQuery;
  const hash = location.hash;
  return hash.startsWith('#m=') ? decodeURIComponent(hash.slice(3)) : '';
}

const MAIN_PANEL_ID = 'topic:active';

function createSession(): TopicEditorSession {
  return {
    panelId: '',
    pinned: false,
    editor: null,
    topicId: '',
    data: {},
    els: {},
    synced: false,
    entering: true,
    stale: false,
    launch: null,
    launchWdSeq: 0,
    launchSetupTopic: '',
    launchSetupSeq: 0,
    seedWorkdir: null,
    settleOnResume: false,
    enterToken: 0,
    hasMore: false,
    oldestSeq: 0,
    loadingOlder: false,
    olderError: false,
    autoFillPages: 0,
    resumeHealAttempted: false,
  };
}

function getOrCreateSession(state: AppState, root: HTMLElement): TopicEditorSession {
  let session = state.sessionByRoot.get(root);
  if (!session) {
    session = createSession();
    state.sessionByRoot.set(root, session);
  }
  return session;
}

function mainSession(state: AppState): TopicEditorSession | null {
  return state.sessions.get(MAIN_PANEL_ID) ?? null;
}

function focusedSession(state: AppState): TopicEditorSession | null {
  const focused = state.sessions.get(state.focusedPanelId);
  if (focused) return focused;
  const main = mainSession(state);
  if (main) return main;
  for (const s of state.sessions.values()) return s;
  return null;
}

function sessionsForTopic(state: AppState, topicId: string): TopicEditorSession[] {
  const out: TopicEditorSession[] = [];
  for (const s of state.sessions.values()) {
    if (s.topicId === topicId) out.push(s);
  }
  return out;
}

function subscribedTopics(state: AppState): string[] {
  const out: string[] = [];
  const main = mainSession(state);
  if (main?.topicId) out.push(main.topicId);
  for (const s of state.sessions.values()) {
    if (s.topicId && !out.includes(s.topicId)) out.push(s.topicId);
  }
  if (out.length === 0 && state.topic) out.push(state.topic);
  return out;
}

function visibleTopicIds(rt: AppRuntime): string[] {
  const out: string[] = [];
  for (const group of rt.shell.dock.getGroups()) {
    const panelId = group.activePanelId;
    if (!panelId) continue;
    const session = rt.state.sessions.get(panelId);
    if (session?.topicId && !out.includes(session.topicId)) out.push(session.topicId);
  }
  if (out.length === 0 && rt.state.topic) out.push(rt.state.topic);
  return out;
}

function setFocusedTopicSession(rt: AppRuntime, panelId: string): void {
  const session = rt.state.sessions.get(panelId);
  if (!session) return;
  const changed = rt.state.focusedPanelId !== panelId || rt.state.topic !== session.topicId;
  rt.state.focusedPanelId = panelId;
  if (session.topicId) rt.state.topic = session.topicId;
  if (!changed) return;
  if (session.topicId) {
    rt.readsService.markTopicFromList(session.topicId, rt.state.topics);
    rt.readsService.reportSeen();
    const active = topicById(rt.state, session.topicId);
    rt.events.emit('topic.active', { id: session.topicId, topic: active as unknown as TopicInfo | undefined });
  }
}

function markVisibleTopicsRead(rt: AppRuntime): void {
  for (const id of visibleTopicIds(rt)) {
    rt.readsService.markTopicFromList(id, rt.state.topics);
  }
  rt.readsService.reportSeen();
}

function ensureTopicEditorOpen(rt: AppRuntime, topicId: string): void {
  const panel = rt.shell.dock.getPanel(MAIN_PANEL_ID);
  const session = mainSession(rt.state);
  const existing = session?.editor ?? null;
  if (panel && existing) {
    if (existing.getTopicId() !== topicId) {
      rt.shell.editors.open('topic', { topicId }, { id: MAIN_PANEL_ID });
    } else if (rt.shell.getMode() !== 'mobile' || rt.shell.dock.getActiveGroupPanel() !== MAIN_PANEL_ID) {
      existing.update?.({ topicId });
      panel.focus();
    } else {
      existing.update?.({ topicId });
    }
    if (rt.shell.getMode() === 'mobile' && document.activeElement === existing.els.input) {
      existing.els.input.blur();
    }
    return;
  }
  rt.shell.editors.open('topic', { topicId }, { id: MAIN_PANEL_ID });
}

function resetSessionView(session: TopicEditorSession, id: string): void {
  const editor = session.editor;
  session.topicId = id;
  session.data = {};
  session.els = {};
  session.stale = false;
  session.entering = true;
  session.synced = false;
  session.launch = null;
  session.launchSetupTopic = '';
  session.launchSetupSeq = 0;
  session.seedWorkdir = null;
  session.settleOnResume = false;
  session.hasMore = false;
  session.oldestSeq = 0;
  session.loadingOlder = false;
  session.olderError = false;
  session.autoFillPages = 0;
  session.resumeHealAttempted = false;
  if (editor) {
    editor.transcript?.setOlderState({ hasMore: false, loading: false });
    editor.els.log.replaceChildren();
    editor.transcript?.subagents.reset();
    editor.status?.closeModelPop();
    editor.status?.setStatus(null);
    editor.status?.setPending([]);
  }
}

function canResumeFromCache(c: CacheCopy | null, epoch: number): c is CacheCopy {
  return Boolean(c && c.msgs.length && c.last && epoch && c.epoch === epoch);
}

function adoptCachedCopy(
  rt: AppRuntime,
  session: TopicEditorSession,
  id: string,
  c: CacheCopy,
  resume: boolean,
): void {
  const editor = session.editor;
  const composer = editor?.composer;
  if (composer) {
    for (const msg of c.msgs) composer.claim(msg as unknown as WebMessage);
  }
  if (resume) {
    session.stale = c.stale;
    session.hasMore = Boolean(c.hasMore);
    session.oldestSeq = c.oldestSeq || 0;
    session.olderError = false;
  }
  if (!c.msgs.length) return;
  const row = topicById(rt.state, id);
  const current = resume && isRowCurrent(row, c.last, (a, b) => rt.cacheService.isNewer(a, b));
  editor?.transcript?.adopt(c.msgs as unknown as readonly TranscriptMessage[], current);
  if (resume) syncOlderIndicator(session);
}

function syncOlderIndicator(session: TopicEditorSession): void {
  session.editor?.transcript?.setOlderState({
    hasMore: session.hasMore && session.oldestSeq > 0,
    loading: session.loadingOlder,
    error: session.olderError,
  });
}

interface OlderMessagesPage {
  readonly topic: string;
  readonly epoch: number;
  readonly messages: readonly WebMessage[];
  readonly hasMore: boolean;
  readonly oldestSeq?: number;
  readonly totalCount: number;
}

async function loadOlderPage(
  rt: AppRuntime,
  session: TopicEditorSession,
  opts?: { readonly limit?: number },
): Promise<boolean> {
  const topicId = session.topicId;
  if (!topicId || !session.hasMore || session.loadingOlder || session.oldestSeq <= 0) return false;
  const token = session.enterToken;
  const before = session.oldestSeq;
  const limit = opts?.limit ?? 50;
  session.loadingOlder = true;
  session.olderError = false;
  syncOlderIndicator(session);
  try {
    const res = await fetch(
      `api/messages?t=${encodeURIComponent(topicId)}&before=${encodeURIComponent(String(before))}&limit=${limit}`,
      { credentials: 'same-origin', cache: 'no-store' },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const page = (await res.json()) as OlderMessagesPage;
    if (token !== session.enterToken || topicId !== session.topicId) return false;
    session.loadingOlder = false;
    session.hasMore = Boolean(page.hasMore);
    session.oldestSeq = page.oldestSeq ?? 0;
    session.editor?.transcript?.prependOlder(page.messages as unknown as readonly TranscriptMessage[]);
    syncOlderIndicator(session);
    rt.cacheService.scheduleSave(topicId);
    return true;
  } catch {
    if (token !== session.enterToken || topicId !== session.topicId) return false;
    session.loadingOlder = false;
    session.olderError = true;
    syncOlderIndicator(session);
    return false;
  }
}

function maybeFillShortViewport(rt: AppRuntime, session: TopicEditorSession): void {
  const log = session.editor?.els.log;
  if (!log || log.clientHeight <= 0) return;
  if (!session.hasMore || session.oldestSeq <= 0 || session.loadingOlder || session.olderError) return;
  if (session.autoFillPages >= MAX_AUTO_FILL_PAGES) return;
  if (log.scrollHeight > log.clientHeight + AUTO_FILL_TOP_BUFFER_PX) return;
  const token = session.enterToken;
  const topicId = session.topicId;
  session.autoFillPages += 1;
  void loadOlderPage(rt, session).then((ok) => {
    if (!ok || token !== session.enterToken || topicId !== session.topicId) return;
    maybeFillShortViewport(rt, session);
  });
}

async function jumpToMessage(rt: AppRuntime, session: TopicEditorSession, msgId: string): Promise<boolean> {
  if (!msgId || !session.editor?.transcript) return false;
  if (session.editor.transcript.scrollToMessage(msgId)) return true;
  const topicId = session.topicId;
  const token = session.enterToken;
  while (session.hasMore && session.oldestSeq > 0 && topicId === session.topicId && token === session.enterToken) {
    const ok = await loadOlderPage(rt, session, { limit: 100 });
    if (!ok) return false;
    if (session.editor?.transcript?.scrollToMessage(msgId)) return true;
  }
  return Boolean(session.editor?.transcript?.scrollToMessage(msgId));
}

function consumePendingJump(rt: AppRuntime, session: TopicEditorSession): void {
  const target = rt.state.pendingJumpMsgId;
  if (!target || session.panelId !== MAIN_PANEL_ID) return;
  rt.state.pendingJumpMsgId = '';
  void jumpToMessage(rt, session, target);
}

function applyCachedTopicEntry(
  rt: AppRuntime,
  session: TopicEditorSession,
  id: string,
  c: CacheCopy | null,
): boolean {
  const resume = canResumeFromCache(c, rt.state.epoch);
  if (c) adoptCachedCopy(rt, session, id, c, resume);
  if (id) session.editor?.composer?.showUnsent(id);
  if (resume && c) {
    rt.streamClient.setLastEventId(c.last, id);
    session.settleOnResume = true;
  } else if (id) {
    rt.streamClient.clearLastEventId(id);
  }
  return resume;
}

function enterSession(
  rt: AppRuntime,
  session: TopicEditorSession,
  id: string,
  opts?: { readonly skipCache?: boolean },
): void {
  const mine = ++session.enterToken;
  let used = false;
  const multi = rt.state.sessions.size > 1;
  const v = id ? rt.cacheService.getVersion(id) : undefined;
  if (!multi) rt.streamClient.close();
  const here = (): boolean =>
    mine === session.enterToken &&
    id === session.topicId &&
    rt.state.sessions.get(session.panelId) === session;

  const go = (c: CacheCopy | null): void => {
    if (used) return;
    used = true;
    if (!here()) return;
    const resume = applyCachedTopicEntry(rt, session, id, c);
    if (multi) {
      rt.streamClient.connect(true, true);
    } else {
      rt.streamClient.connect(resume);
    }
  };

  if (opts?.skipCache || !id) {
    go(null);
    return;
  }
  const m = rt.cacheService.memCopy(id);
  if (m) {
    go(m);
    return;
  }
  void rt.cacheService.get(id).then((c) => {
    if (!used) {
      go(c);
      return;
    }
    if (c && c.msgs.length && here()) {
      session.editor?.transcript?.adopt(c.msgs as unknown as readonly TranscriptMessage[]);
    }
  });
  const epoch = rt.state.epoch;
  if (epoch && rt.cacheService.isDbAvailable() && (!v || (v.last && v.epoch === epoch))) {
    setTimeout(() => go(null), LOCAL_CACHE_WAIT_MS);
  } else {
    go(null);
  }
}

interface SwitchTopicOptions {
  readonly fresh?: boolean;
  readonly alreadyLeft?: boolean;
  readonly launch?: LaunchChoice;
  readonly workdir?: WorkdirScreen;
}

function leaveSessionTopic(rt: AppRuntime, session: TopicEditorSession | null, topicId: string): void {
  rt.cacheService.leave(topicId);
  session?.editor?.transcript?.scroll.saveView(topicId, session.entering);
  session?.editor?.composer?.stashDraft(topicId);
}

function mountSeededLaunch(rt: AppRuntime, session: TopicEditorSession, opts: SwitchTopicOptions): void {
  if (!opts.launch) {
    session.editor?.transcript?.banners.showSkeleton();
    return;
  }
  session.launch = opts.launch;
  if (opts.workdir) {
    cacheWorkdirScreen(rt.state, opts.workdir);
    session.seedWorkdir = opts.workdir;
  }
  session.editor?.transcript?.banners.syncLaunch(true);
}

function closeMobileSidebar(rt: AppRuntime): void {
  if (rt.shell.getMode() === 'mobile' && rt.shell.isPartVisible('sidebar')) {
    rt.shell.setPartVisible('sidebar', false);
  }
}

function switchTopic(rt: AppRuntime, id: string, opts?: SwitchTopicOptions): void {
  if (!id) return;
  const session = mainSession(rt.state);
  const prev = session ? session.topicId : rt.state.topic;
  if (prev && prev !== id && !opts?.alreadyLeft) leaveSessionTopic(rt, session, prev);
  rt.state.topic = id;
  rt.state.focusedPanelId = MAIN_PANEL_ID;
  if (prev !== id) {
    if (session) resetSessionView(session, id);
    history.replaceState(null, '', currentTopicUrl(id));
    ensureTopicEditorOpen(rt, id);
    const activeMain = mainSession(rt.state);
    rt.readsService.markTopicFromList(id, rt.state.topics);
    rt.readsService.reportSeen();
    const active = topicById(rt.state, id);
    rt.events.emit('topic.active', { id, topic: active as unknown as TopicInfo | undefined });
    if (activeMain) {
      mountSeededLaunch(rt, activeMain, opts ?? {});
      enterSession(rt, activeMain, id, opts?.fresh ? { skipCache: true } : undefined);
    }
  } else {
    ensureTopicEditorOpen(rt, id);
    rt.readsService.reportSeen();
    const active = topicById(rt.state, id);
    rt.events.emit('topic.active', { id, topic: active as unknown as TopicInfo | undefined });
  }
  closeMobileSidebar(rt);
}

interface CreateTopicResponse {
  readonly id?: string;
  readonly topic?: Topic;
  readonly agents?: LaunchChoice;
  readonly workdir?: WorkdirScreen;
  readonly error?: string;
}

function beginCreateTopicView(rt: AppRuntime, prevTopic: string): void {
  closeMobileSidebar(rt);
  const session = mainSession(rt.state);
  if (session) ++session.enterToken;
  if (!prevTopic) return;
  leaveSessionTopic(rt, session, prevTopic);
  ensureTopicEditorOpen(rt, prevTopic);
  const editor = mainSession(rt.state)?.editor;
  if (!editor) return;
  editor.els.log.replaceChildren();
  editor.transcript?.banners.resetForTopicSwitch();
  editor.transcript?.banners.showSkeleton();
}

function prependCreatedTopic(rt: AppRuntime, topic: Topic | undefined): void {
  if (!topic || rt.state.topics.some((t) => t.id === topic.id)) return;
  rt.state.topics = [topic, ...rt.state.topics];
  rt.events.emit('topic.list', { topics: toTopicInfos(rt.state.topics) });
}

function restoreAfterCreateFailure(rt: AppRuntime, prevTopic: string, message?: string): void {
  const session = mainSession(rt.state);
  const current = session ? session.topicId : rt.state.topic;
  if (prevTopic && prevTopic === current) {
    if (session) session.topicId = '';
    rt.state.topic = '';
    switchTopic(rt, prevTopic);
  }
  const editor = mainSession(rt.state)?.editor;
  if (message && editor) {
    editor.els.noteEl.textContent = message;
  }
}

function applyCreatedTopicDraft(rt: AppRuntime, id: string, draft: string | undefined): void {
  if (!draft) return;
  const editor = mainSession(rt.state)?.editor;
  if (editor?.composer) {
    editor.composer.seedDraft(id, draft);
  } else {
    editor?.insertIntoComposer(draft);
  }
}

interface CreateTopicSeed {
  readonly text?: string;
  readonly draft?: string;
  readonly agent?: string;
  readonly cwd?: string;
  readonly onError?: (err: string) => void;
}

function buildCreateTopicBody(seed?: CreateTopicSeed): Record<string, string> {
  const body: Record<string, string> = {};
  if (seed?.agent) body.agent = seed.agent;
  if (seed?.cwd) body.cwd = seed.cwd;
  return body;
}

function finishCreatedTopic(
  rt: AppRuntime,
  id: string,
  prevTopic: string,
  data: CreateTopicResponse,
  draft: string | undefined,
): void {
  prependCreatedTopic(rt, data.topic);
  switchTopic(rt, id, {
    fresh: true,
    alreadyLeft: Boolean(prevTopic),
    ...(data.agents ? { launch: data.agents } : {}),
    ...(data.workdir ? { workdir: data.workdir } : {}),
  });
  applyCreatedTopicDraft(rt, id, draft);
}

async function createTopic(rt: AppRuntime, seed?: CreateTopicSeed): Promise<boolean> {
  if (rt.state.creatingTopic) return false;
  rt.state.creatingTopic = true;
  const prevTopic = mainSession(rt.state)?.topicId || rt.state.topic;
  beginCreateTopicView(rt, prevTopic);
  try {
    const res = await post('api/topics', buildCreateTopicBody(seed), 0);
    const data = (await res.json().catch(() => ({}))) as CreateTopicResponse;
    const id = res.ok ? (data.topic?.id ?? data.id) : undefined;
    if (!id) {
      restoreAfterCreateFailure(rt, prevTopic, res.ok ? undefined : data.error || tr('common.networkError'));
      if (!res.ok) seed?.onError?.(data.error || `HTTP ${res.status}`);
      return false;
    }
    finishCreatedTopic(rt, id, prevTopic, data, seed?.draft);
    return true;
  } catch {
    restoreAfterCreateFailure(rt, prevTopic, tr('common.networkError'));
    seed?.onError?.(tr('topic.createReachErr'));
    return false;
  } finally {
    rt.state.creatingTopic = false;
  }
}

function buildHandoffDraft(
  handoff: {
    readonly fromAgent: string;
    readonly sessionId: string;
    readonly workdir?: string;
    readonly fromTopicId?: string;
    readonly fromTopicTitle?: string;
  },
  fallbackTopic: { readonly id: string; readonly title?: string } | null | undefined,
): string {
  const lines = [tr('msg.handoffDraftHead', { agent: handoff.fromAgent, sessionId: handoff.sessionId })];
  if (handoff.workdir) {
    lines.push(tr('msg.handoffDraftWorkdir', { workdir: handoff.workdir }));
  }
  const topicId = handoff.fromTopicId || fallbackTopic?.id;
  const title = handoff.fromTopicTitle || fallbackTopic?.title;
  let link: string | undefined;
  if (topicId) {
    const rel = `?t=${encodeURIComponent(topicId)}`;
    try {
      link = new URL(rel, window.location.href).href;
    } catch {
      link = rel;
    }
  }
  if (title && link) {
    lines.push(tr('msg.handoffDraftTopicWithLink', { title, link }));
  } else if (link) {
    lines.push(tr('msg.handoffDraftTopicLinkOnly', { link }));
  } else if (title) {
    lines.push(tr('msg.handoffDraftTopicTitleOnly', { title }));
  }
  return `${lines.join('\n')}\n\n`;
}

async function deleteTopic(rt: AppRuntime, id: string): Promise<void> {
  await post('api/topics/delete', { topic: id }, 0);
}

async function forkTopic(rt: AppRuntime, id: string): Promise<void> {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  await post('api/send', { topic: id, text: '/fork', nonce }, 0);
}

function buildTopicEditorDeps(rt: AppRuntime) {
  return {
    transcriptDeps: (els: TopicEditorElements, getTopicId: () => string) =>
      buildTranscriptDeps(rt, els, getTopicId),
    statusDeps: (els: TopicEditorElements, getTopicId: () => string) =>
      buildStatusDeps(rt, els, getTopicId),
    composerDeps: (els: TopicEditorElements, getTopicId: () => string) =>
      buildComposerDeps(rt, els, getTopicId),
  };
}

const MAX_WORKDIR_CACHE = 40;

function cacheWorkdirScreen(state: AppState, screen: WorkdirScreen, isRoot = false): void {
  if (screen.error) return;
  const dirKey = `${screen.agentId}\0${screen.browsing}`;
  if (state.workdirCache.has(dirKey)) state.workdirCache.delete(dirKey);
  state.workdirCache.set(dirKey, screen);
  if (isRoot || (screen.root && screen.browsing === screen.root)) {
    if (state.workdirCache.has(screen.agentId)) state.workdirCache.delete(screen.agentId);
    state.workdirCache.set(screen.agentId, screen);
  }
  while (state.workdirCache.size > MAX_WORKDIR_CACHE) {
    const oldest = state.workdirCache.keys().next().value;
    if (oldest === undefined) break;
    state.workdirCache.delete(oldest);
  }
}

function loadLaunchWorkdirs(
  rt: AppRuntime,
  session: TopicEditorSession,
  tid: string,
  agentId: string,
  opts?: { readonly dir?: string; readonly atRoot?: boolean; readonly silent?: boolean },
): void {
  const seq = ++session.launchWdSeq;
  const params = new URLSearchParams({ t: tid, agent: agentId });
  if (opts?.dir) params.set('dir', opts.dir);
  if (opts?.atRoot) params.set('root', '1');
  void fetch(`api/topics/workdirs?${params.toString()}`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? (r.json() as Promise<WorkdirScreen>) : null))
    .then((screen) => {
      if (seq !== session.launchWdSeq || session.topicId !== tid) return;
      const banners = session.editor?.transcript?.banners;
      if (screen && typeof screen.browsing === 'string') {
        cacheWorkdirScreen(rt.state, screen, Boolean(opts?.atRoot || !opts?.dir));
        banners?.setLaunchWorkdir(screen, false);
      } else if (opts?.silent) {
        banners?.clearLaunchWorkdirLoading();
      } else {
        banners?.setLaunchWorkdir(null, false);
      }
    })
    .catch(() => {
      if (seq !== session.launchWdSeq || session.topicId !== tid) return;
      const banners = session.editor?.transcript?.banners;
      if (opts?.silent) banners?.clearLaunchWorkdirLoading();
      else banners?.setLaunchWorkdir(null, false);
    });
}

function normalizeCachedWorkdir(screen: WorkdirScreen, cwd: string): WorkdirScreen {
  return {
    ...screen,
    current: cwd,
    selectCurrent: { ...screen.selectCurrent, current: screen.selectCurrent.path === cwd },
    entries: (screen.entries ?? []).map((e) => ({ ...e, current: e.path === cwd })),
  };
}

function handleLaunchShown(rt: AppRuntime, session: TopicEditorSession, tid: string, agentId: string): void {
  if (!tid) return;
  const banners = session.editor?.transcript?.banners;
  const seeded = session.seedWorkdir;
  session.seedWorkdir = null;
  if (seeded && seeded.agentId === agentId) {
    banners?.setLaunchWorkdir(seeded, false);
    return;
  }
  const cached = rt.state.workdirCache.get(agentId);
  if (cached) {
    const cwd = topicById(rt.state, tid)?.dir?.path || cached.root || cached.browsing;
    banners?.setLaunchWorkdir(normalizeCachedWorkdir(cached, cwd), false);
    loadLaunchWorkdirs(rt, session, tid, agentId, { silent: true });
    return;
  }
  loadLaunchWorkdirs(rt, session, tid, agentId);
}

function rollbackAgentChoice(
  session: TopicEditorSession,
  els: TopicEditorElements,
  prevLaunch: LaunchChoice | null,
  prevScreen: WorkdirScreen | null,
  errorMsg: string,
): void {
  ++session.launchWdSeq;
  const banners = session.editor?.transcript?.banners;
  if (prevLaunch && session.launch) {
    session.launch = prevLaunch;
    banners?.setLaunchAgent(prevLaunch.current, { fold: Boolean(prevLaunch.agentChosen) });
  }
  if (prevScreen) banners?.setLaunchWorkdir(prevScreen, false);
  else banners?.setLaunchWorkdir(null, false);
  els.noteEl.textContent = errorMsg;
}

function selectLaunchAgent(
  rt: AppRuntime,
  session: TopicEditorSession,
  els: TopicEditorElements,
  tid: string,
  agentId: string,
): void {
  const { state } = rt;
  const banners = session.editor?.transcript?.banners;
  const prevLaunch = session.launch;
  const prevScreen = banners?.getLaunchWorkdir() ?? null;
  const sameAgent = prevLaunch?.current === agentId;
  const setupSeq = ++session.launchSetupSeq;
  session.launchSetupTopic = tid;

  if (session.launch) session.launch = { ...session.launch, current: agentId, agentChosen: true };
  banners?.setLaunchAgent(agentId, { fold: true });
  session.editor?.status?.onAgentChosen();

  // Keep the picker interactive when re-confirming the current agent or hitting client cache.
  const keepCurrent = sameAgent && prevScreen?.agentId === agentId;
  const cached = keepCurrent ? null : state.workdirCache.get(agentId);
  if (cached) {
    banners?.setLaunchWorkdir(normalizeCachedWorkdir(cached, cached.root || cached.browsing), false);
    loadLaunchWorkdirs(rt, session, tid, agentId, { atRoot: true, silent: true });
  } else if (!keepCurrent) {
    banners?.setLaunchWorkdir(null, true);
    loadLaunchWorkdirs(rt, session, tid, agentId, { atRoot: true });
  }

  void post('api/topics/setup', { topic: tid, agent: agentId }, 1)
    .then((r) => r.json().then((j: { ok?: boolean; agent?: string; cwd?: string; error?: string }) => ({ r, j })))
    .then(({ r, j }) => {
      if (session.topicId !== tid || setupSeq !== session.launchSetupSeq) return;
      if (!r.ok || !j.ok) {
        rollbackAgentChoice(session, els, prevLaunch, prevScreen, j.error || tr('common.networkError'));
        return;
      }
      if (j.cwd) banners?.setLaunchCwd(j.cwd);
      session.editor?.status?.peekOptions();
    })
    .catch(() => {
      if (session.topicId !== tid || setupSeq !== session.launchSetupSeq) return;
      rollbackAgentChoice(session, els, prevLaunch, prevScreen, tr('common.networkError'));
    });
}

function browseLaunchWorkdir(rt: AppRuntime, session: TopicEditorSession, tid: string, dir: string): void {
  const agentId = session.launch?.current;
  if (!tid || !agentId) return;
  const banners = session.editor?.transcript?.banners;
  const cached = rt.state.workdirCache.get(`${agentId}\0${dir}`);
  if (cached) {
    const cwd = banners?.getLaunchWorkdir()?.current || cached.root || cached.browsing;
    banners?.setLaunchWorkdir(normalizeCachedWorkdir(cached, cwd), false);
    loadLaunchWorkdirs(rt, session, tid, agentId, { dir, silent: true });
    return;
  }
  banners?.setLaunchWorkdir(null, true);
  loadLaunchWorkdirs(rt, session, tid, agentId, { dir });
}

function pickLaunchWorkdir(
  session: TopicEditorSession,
  els: TopicEditorElements,
  tid: string,
  cwd: string,
): void {
  const agentId = session.launch?.current;
  if (!tid || !agentId) return;
  const setupSeq = ++session.launchSetupSeq;
  session.launchSetupTopic = tid;
  // Cancel any in-flight background directory refresh so it cannot overwrite the chosen path.
  ++session.launchWdSeq;
  if (session.launch) session.launch = { ...session.launch, agentChosen: true, cwdChosen: true };
  session.editor?.transcript?.banners.setLaunchCwd(cwd, { fold: true });
  session.editor?.status?.onAgentChosen();
  void post('api/topics/setup', { topic: tid, agent: agentId, cwd }, 1)
    .then((r) => r.json().then((j: { ok?: boolean; agent?: string; cwd?: string; error?: string }) => ({ r, j })))
    .then(({ r, j }) => {
      if (session.topicId !== tid || setupSeq !== session.launchSetupSeq) return;
      if (!r.ok || !j.ok) {
        els.noteEl.textContent = j.error || tr('common.networkError');
        return;
      }
      if (j.cwd) session.editor?.transcript?.banners.setLaunchCwd(j.cwd);
      session.editor?.status?.peekOptions();
    })
    .catch(() => {
      if (session.topicId !== tid || setupSeq !== session.launchSetupSeq) return;
      els.noteEl.textContent = tr('common.networkError');
    });
}

function buildTranscriptDeps(rt: AppRuntime, els: TopicEditorElements, getTopicId: () => string) {
  const { state, icons, codeView } = rt;
  const session = getOrCreateSession(state, els.root);
  return {
    log: els.log,
    btwBox: els.btwBox,
    btwQ: els.btwQ,
    btwBody: els.btwBody,
    btwClose: els.btwClose,
    machineNoteEl: els.machineNoteEl,
    subagentTrayEl: els.subagentTrayEl,
    forkNote: els.forkNote,
    getExtraCodeRoots: () => Array.from(document.querySelectorAll<HTMLElement>('.wb-reader-editor')),
    getData: () => session.data,
    getEls: () => session.els,
    getTopic: getTopicId,
    getTopics: () => state.topics,
    topicById: (id: string) => topicById(state, id) ?? null,
    getEpoch: () => state.epoch,
    isSynced: () => session.synced,
    isStale: () => session.stale,
    isEntering: () => session.entering,
    getLaunch: () => session.launch,
    keyOf,
    isHistory: (m: TranscriptMessage | undefined) => isHistory(state, m),
    getIcons: () => icons,
    formatStatusClock: stClock,
    codeView,
    copyText: (s: string, cb: (ok: boolean) => void) => session.editor?.composer?.copyText(s, cb),
    hasOutbox: (nonce: string) => Boolean(session.editor?.composer?.hasOutbox(nonce)),
    claim: (m: TranscriptMessage) => Boolean(session.editor?.composer?.claim(m as unknown as WebMessage)),
    adoptLegacy: (m: TranscriptMessage) => Boolean(session.editor?.composer?.adoptLegacy(m as unknown as WebMessage)),
    showUnsent: (tId: string) => session.editor?.composer?.showUnsent(tId),
    cacheSave: () => rt.cacheService.scheduleSave(session.topicId),
    getHistoryMessage: () => undefined,
    repaintHistoryMessage: () => {},
    paintTopics: () => rt.events.emit('topic.list', { topics: toTopicInfos(state.topics) }),
    paintStatus: () => session.editor?.status?.paintStatus(),
    switchTopic: (id: string) => switchTopic(rt, id),
    isNarrow: () => rt.shell.getMode() !== 'desktop',
    setSidebar: (open: boolean) => rt.shell.setPartVisible('sidebar', open),
    openShot: (img: HTMLImageElement) => {
      void rt.commands.execute(READER_OPEN_IMAGE_COMMAND, { src: img.src, alt: img.alt, restoreFocus: img });
    },
    sendCommand: (cmd: string) => session.editor?.composer?.command(cmd),
    onLaunchShown: (agentId: string) => handleLaunchShown(rt, session, getTopicId(), agentId),
    selectLaunchAgent: (agentId: string) => {
      const tid = getTopicId();
      if (tid) selectLaunchAgent(rt, session, els, tid, agentId);
    },
    browseLaunchWorkdir: (dir: string) => browseLaunchWorkdir(rt, session, getTopicId(), dir),
    pickLaunchWorkdir: (cwd: string) => pickLaunchWorkdir(session, els, getTopicId(), cwd),
    openReader: (link: Element) => {
      void rt.commands.execute(READER_OPEN_COMMAND, link);
    },
    onHandoff: (handoff: HandoffAction, btn: HTMLButtonElement) => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('busy');
      const cur = topicById(state, session.topicId || getTopicId());
      const draft = buildHandoffDraft(handoff, cur);
      const cwd = handoff.workdir && handoff.sameHost !== false ? handoff.workdir : undefined;
      let errMsg: string | undefined;
      void createTopic(rt, {
        agent: handoff.agentId,
        ...(cwd ? { cwd } : {}),
        draft,
        onError: (err) => {
          errMsg = err;
        },
      }).then((ok) => {
        btn.disabled = false;
        btn.classList.remove('busy');
        if (!ok) {
          els.noteEl.textContent = tr('topic.createFailed', { err: errMsg || tr('topic.createReachErr') });
        }
      });
    },
    deliverLocal: (nonce: string) => session.editor?.composer?.deliver(nonce),
    copyLocal: (nonce: string, btn: Element) => {
      if (btn instanceof HTMLElement) session.editor?.composer?.copyLocal(nonce, btn);
    },
    discardLocal: (nonce: string) => session.editor?.composer?.discardLocal(nonce),
    onLoadOlder: () => {
      void loadOlderPage(rt, session);
    },
    onViewportShown: () => {
      maybeFillShortViewport(rt, session);
    },
    onJumpToMessage: (msgId: string) => {
      void jumpToMessage(rt, session, msgId);
    },
  };
}

function buildStatusDeps(rt: AppRuntime, els: TopicEditorElements, getTopicId: () => string) {
  const { state, icons } = rt;
  const session = getOrCreateSession(state, els.root);
  return {
    statusEl: els.statusEl,
    pendingQueueEl: els.pendingQueueEl,
    modelPopEls: {
      modelPop: els.modelPop,
      mpList: els.mpList,
      mpFilter: els.mpFilter,
      mpAgent: els.mpAgent,
      mpHeading: els.mpHeading,
      mpFoot: els.mpFoot,
      mpClose: els.mpClose,
    },
    getTopic: getTopicId,
    isSynced: () => session.synced,
    hasLauncher: () => Boolean(session.editor?.transcript?.banners.hasLaunch()),
    hasMessages: () => Boolean(els.log.querySelector('.m')),
    narrow: () => rt.shell.getMode() !== 'desktop',
    getIcons: () => icons.icon,
    inl,
    setNote: (msg: string) => {
      els.noteEl.textContent = msg;
    },
    onRetireLocalNonce: (nonce: string) => session.editor?.composer?.retireLocalNonce(nonce),
    onRecallContent: (content: string) => session.editor?.composer?.recallContent(content),
  };
}

function buildComposerDeps(rt: AppRuntime, els: TopicEditorElements, getTopicId: () => string) {
  const { state, icons, boot, overlays } = rt;
  const session = getOrCreateSession(state, els.root);
  return {
    els: {
      input: els.input,
      chips: els.chips,
      hints: els.hints,
      note: els.noteEl,
      picker: els.picker,
      attachBtn: els.attachBtn,
      micBtn: els.micBtn,
      composerForm: els.composerForm,
      copyRefBtn: null,
      killBtn: document.createElement('button'),
      stopBtn: els.stopBtn,
    },
    overlays,
    instanceId: boot.instance || 'web',
    getTopic: getTopicId,
    getTopics: () => state.topics,
    topicById: (id: string) => topicById(state, id),
    getEpoch: () => state.epoch,
    isNarrow: () => rt.shell.getMode() !== 'desktop',
    isHistoryOpen: () => false,
    getHistoryRef: () => null,
    getIcons: () => icons.icon,
    openShot: (img: HTMLImageElement) => {
      void rt.commands.execute(READER_OPEN_IMAGE_COMMAND, { src: img.src, alt: img.alt, restoreFocus: img });
    },
    settleAdopted: () => {},
    cacheSave: () => rt.cacheService.scheduleSave(session.topicId),
    topicStatus: ({
      addLocalPending: (item) => session.editor?.status?.addLocalPending(item),
      removeLocalPending: (nonce) => session.editor?.status?.removeLocalPending(nonce) ?? false,
      hasLocalPending: (nonce) => session.editor?.status?.hasLocalPending(nonce) ?? false,
    }) satisfies ComposerTopicStatusBridge,
    transcript: {
      getMessage: (key: string) => session.data[key] as unknown as LocalBubbleMessage | undefined,
      setMessage: (key: string, msg: LocalBubbleMessage) => {
        session.data[key] = msg as unknown as TranscriptMessage;
      },
      deleteMessage: (key: string) => session.editor?.transcript?.retireLocalKey(key),
      hasElement: (key: string) => Boolean(session.els[key]),
      removeElement: (key: string) => {
        const el = session.els[key];
        if (el) {
          el.remove();
          delete session.els[key];
        }
      },
      adoptElement: (fromKey: string, toKey: string) => session.editor?.transcript?.transferLocalKey(fromKey, toKey),
      paint: (key: string) => session.editor?.transcript?.paint(key),
      drop: (key: string) => session.editor?.transcript?.drop(key),
      sinkLocals: () => session.editor?.transcript?.sinkLocals(),
      syncEmptyNote: () => session.editor?.transcript?.banners.syncEmptyNote(),
      atBottom: () => Boolean(session.editor?.transcript?.scroll.atBottom()),
      toBottom: () => session.editor?.transcript?.scroll.toBottom(),
      onBtwAsked: (key: string, msg: LocalBubbleMessage) => {
        const trCtrl = session.editor?.transcript;
        if (trCtrl && trCtrl.btwAsked(key, msg as unknown as TranscriptMessage) !== null) {
          trCtrl.btw.open(key);
        }
      },
      onClaimKeyMoved: (fromKey: string, toKey: string) => session.editor?.transcript?.btw.transferKey(fromKey, toKey),
    },
  };
}

function buildTopicPluginDeps(rt: AppRuntime): Pick<BuiltinPluginsDeps, 'topics' | 'topic'> {
  const { boot, icons, overlays, registry, shell, state } = rt;
  return {
    topics: {
      instanceId: boot.instance || 'web',
      overlays,
      registry,
      getIcons: () => icons.icon,
      getTopics: () => state.topics,
      getActiveTopicId: () => state.topic,
      unreadOf: (t) => rt.readsService.unreadOf(t),
      needsRead: (t) => rt.readsService.needsRead(t),
      canOpenInNewTab: () => shell.getMode() === 'desktop',
      onCreateTopic: () => createTopic(rt),
      prefetchDeps: {
        isDbAvailable: () => rt.cacheService.isDbAvailable(),
        isStreamParked: () => rt.streamClient.isParked(),
        isStreamOpen: () => rt.streamClient.isOpen(),
        getEpoch: () => state.epoch,
        isOpen: (id) => sessionsForTopic(state, id).length > 0,
        getVersion: (id) => rt.cacheService.getVersion(id),
        isNewer: (a, b) => rt.cacheService.isNewer(a, b),
        peekCache: (id) => rt.cacheService.peek(id),
        getCache: (id) => rt.cacheService.get(id),
        putCache: (id, msgs, meta) => rt.cacheService.put(id, msgs, meta),
        snapshotMsgs: (d) => rt.cacheCore.snapshotMsgs(d),
      },
      onStarTopic: async (id, nextStarred) => {
        await post('api/topics/star', { topic: id, starred: nextStarred }, 0);
      },
      onForkTopic: (id) => forkTopic(rt, id),
      onEndTopic: async (id) => {
        await post('api/send', { topic: id, text: '/kill' }, 0);
      },
      onDeleteTopic: (id) => deleteTopic(rt, id),
      onMarkAllRead: (visible) => {
        void rt.readsService.markAllRead(visible, 'topics', () => {});
      },
      onClearUnstarred: async () => {
        await post('api/topics/clear', {}, 0);
      },
    },
    topic: {
      registry,
      overlays,
      instanceId: boot.instance || 'web',
      resolveIcon: (name) => icons.icon[name] ?? '',
      getTopicTools: (topic) =>
        registry.listAvailableTopicTools(topic).map((tool) => ({
          id: tool.id,
          title: tool.title,
          icon: tool.icon,
          active:
            shell.isPartVisible(tool.defaultPart) &&
            shell.dock.getActivePartPanel(tool.defaultPart) === `tool:${tool.id}`,
        })),
      onToggleTopicTool: (toolId, topicId) => {
        shell.tools.toggle(toolId, { topicId });
        for (const s of state.sessions.values()) s.editor?.refreshHeader();
      },
      onToggleSidebar: () => {
        shell.setPartVisible('sidebar', !shell.isPartVisible('sidebar'));
      },
      onForkTopic: (id) => void forkTopic(rt, id),
      onDeleteTopic: (id) => void deleteTopic(rt, id),
      onCloseIdle: () => void rt.commands.execute('status.closeIdle'),
      onEditorCreated: (handle) => handleEditorMounted(rt, handle),
      onEditorFocused: (handle) => {
        const pid = handle.getPanelId();
        if (pid) setFocusedTopicSession(rt, pid);
      },
      onEditorDisposed: (handle) => handleEditorDisposed(rt, handle),
      onRegisterInsertHandler: (handler) => {
        state.insertHandler = handler;
      },
      ...buildTopicEditorDeps(rt),
    },
  };
}

function buildBuiltinDeps(rt: AppRuntime): BuiltinPluginsDeps {
  const { boot, icons, overlays, commands, keybindings, registry, shell, storage, state, codeView, api } = rt;
  return {
    ...buildTopicPluginDeps(rt),
    history: {
      getIcons: () => icons.icon,
      codeBlocks: (root) => {
        focusedSession(state)?.editor?.transcript?.codeBlocks.enhance(root);
      },
      openShot: (img) => {
        if (img instanceof HTMLImageElement) {
          void rt.commands.execute(READER_OPEN_IMAGE_COMMAND, {
            src: img.src,
            alt: img.alt,
            restoreFocus: img,
          });
        }
      },
    },
    schedules: {
      overlays,
      unreadOf: (t) => rt.readsService.unreadOf(t as unknown as Topic),
      markAllRead: async (list) => {
        await rt.readsService.markAllRead(list as unknown as Topic[], tr('topic.nounPlural'), (msg) =>
          console.warn('[schedules]', msg),
        );
      },
      onBadgeChange: () => registry.refreshActivityBadges(),
    },
    reviews: {
      overlays,
      createTopic: (seed) => createTopic(rt, seed),
      onBadgeChange: () => registry.refreshActivityBadges(),
    },
    skills: {
      icons: () => icons.icon,
      codeView,
      overlays,
    },
    settings: {
      instrOk: Boolean(boot.instructions),
      listDeviceSections: () => registry.listSettingsSections(),
      onDidChangeDeviceSections: registry.onDidChangeSettings,
      getEpoch: () => state.epoch,
      getTopic: () => state.topic,
      getTopics: () => state.topics,
      post,
      onReady: (bridge) => {
        state.settingsBridge = bridge;
      },
    },
    changes: {
      api,
      codeView,
      filesEnabled: Boolean(boot.files),
      narrow: () => shell.getMode() !== 'desktop',
    },
    files: {
      filesEnabled: Boolean(boot.files),
      api,
      codeView,
      codeBlocks: (root) => {
        focusedSession(state)?.editor?.transcript?.codeBlocks.enhance(root);
      },
      overlays,
    },
    terminal: {
      boot,
      toggleTool: (topicId) => shell.tools.toggle('terminal', { topicId }),
      minimizePanel: () => shell.setPartVisible('panel', false),
      post,
      storage,
      resolveIcon: (name) => icons.icon[name] ?? '',
    },
    reader: {
      boot,
      doc: document,
      win: window,
      fetchFn: (input, init) => fetch(input, init),
      overlays,
      codeView,
      codeBlocks: (root) => {
        focusedSession(state)?.editor?.transcript?.codeBlocks.enhance(root);
      },
    },
    status: {
      storage,
      overlays,
      appElement: rt.workbenchRoot,
      notify: rt.notifyBridge,
      version: boot.version ? `v${boot.version}` : boot.build ? boot.build.slice(0, 7) : '',
      getPluginErrors: () => [...rt.pluginManager.getErrors(), ...rt.externalPluginErrors],
      onPluginError: (cb) => {
        const sub1 = rt.pluginManager.onDidError(cb);
        const sub2 = rt.externalPluginErrorEmitter.event(cb);
        return {
          dispose: () => {
            sub1.dispose();
            sub2.dispose();
          },
        };
      },
      onUpdateAvailable: (cb) => rt.updateEmitter.event(cb),
      onBeforeReload: () => {
        for (const s of state.sessions.values()) {
          if (s.topicId) s.editor?.composer?.stashDraft(s.topicId);
        }
      },
      onResetLayout: () => shell.resetLayout(),
      onRefreshStatusBar: (id) => shell.statusBarApi.refresh(id),
      emitEvent: (key, payload) => rt.events.emit(key, payload),
      postFn: post,
    },
    palette: {
      commands,
      keybindings,
      overlays,
    },
  };
}

function handleEditorMounted(rt: AppRuntime, handle: TopicEditorHandle): void {
  const { state } = rt;
  const session = getOrCreateSession(state, handle.els.root);
  const panelId = handle.getPanelId() || MAIN_PANEL_ID;
  session.panelId = panelId;
  session.pinned = panelId !== MAIN_PANEL_ID;
  session.editor = handle;
  session.topicId = handle.getTopicId();
  state.sessions.set(panelId, session);
  if (state.commands.length > 0) handle.composer?.setCommands(state.commands);
  if (state.offline.length > 0) handle.transcript?.takeMachines(state.offline);
  if (!session.pinned) {
    if (session.topicId) state.topic = session.topicId;
    state.focusedPanelId = panelId;
    return;
  }
  if (state.bootstrapped && session.topicId) {
    setFocusedTopicSession(rt, panelId);
    handle.composer?.loadDraftIfEmpty(session.topicId);
    handle.transcript?.banners.showSkeleton();
    enterSession(rt, session, session.topicId);
  }
}

function handleEditorDisposed(rt: AppRuntime, handle: TopicEditorHandle): void {
  const { state } = rt;
  const panelId = handle.getPanelId() || MAIN_PANEL_ID;
  const session = state.sessions.get(panelId);
  if (!session || session.editor !== handle) return;
  if (session.topicId) rt.cacheService.leave(session.topicId);
  state.sessions.delete(panelId);
  if (state.focusedPanelId === panelId) {
    const next = focusedSession(state);
    state.focusedPanelId = next?.panelId || MAIN_PANEL_ID;
    if (next?.topicId) {
      state.topic = next.topicId;
      const active = topicById(state, next.topicId);
      rt.events.emit('topic.active', { id: next.topicId, topic: active as unknown as TopicInfo | undefined });
    }
  }
  if (state.bootstrapped && session.topicId && sessionsForTopic(state, session.topicId).length === 0) {
    rt.streamClient.connect(true, true);
  }
}

function resolveSyncTargets(rt: AppRuntime, topicId: string): { targets: TopicEditorSession[]; named: boolean } {
  const { state } = rt;
  const matched = sessionsForTopic(state, topicId);
  if (matched.length > 0) return { targets: matched, named: false };
  const main = mainSession(state);
  if (main && !main.topicId) {
    main.topicId = topicId;
    if (!state.topic) state.topic = topicId;
    ensureTopicEditorOpen(rt, topicId);
    history.replaceState(null, '', currentTopicUrl(topicId));
    return { targets: [main], named: true };
  }
  if (!state.topic) {
    state.topic = topicId;
    ensureTopicEditorOpen(rt, topicId);
    history.replaceState(null, '', currentTopicUrl(topicId));
    const created = mainSession(state);
    return { targets: created ? [created] : [], named: true };
  }
  return { targets: [], named: false };
}

function windowOverlapsSession(
  session: TopicEditorSession,
  ev: Extract<WebEvent, { t: 'sync' }>,
  epoch: number,
): boolean {
  for (let i = 0; i < ev.messages.length; i++) {
    const m = ev.messages[i];
    if (!m || !m.id || m.settings || m.wasSettings) continue;
    if (session.els[`${m.g || epoch}:${m.id}`]) return true;
  }
  return false;
}

function syncSessionFromEvent(
  rt: AppRuntime,
  session: TopicEditorSession,
  ev: Extract<WebEvent, { t: 'sync' }>,
  named: boolean,
  overlaps: boolean,
): void {
  const scroll = session.editor?.transcript?.scroll;
  const arriving = scroll ? scroll.isArriving(session.entering) : false;
  const stick = scroll ? scroll.atBottom() : false;
  session.entering = false;
  session.settleOnResume = false;
  session.synced = true;
  session.stale = Boolean(ev.stale);
  session.launch = mergeSyncLaunch(session, ev);
  applySyncToSession(rt, session, ev, named, arriving, stick, overlaps);
  if (named) adoptCachedTopicMessages(rt, session, ev.topic);
}

function mergeSyncLaunch(session: TopicEditorSession, ev: Extract<WebEvent, { t: 'sync' }>): LaunchChoice | null {
  if (ev.agents && session.launch && session.launchSetupTopic === ev.topic && session.launchSetupSeq > 0) {
    return {
      ...ev.agents,
      current: session.launch.current,
      ...(session.launch.agentChosen ? { agentChosen: true } : {}),
      ...(session.launch.cwdChosen ? { cwdChosen: true } : {}),
    };
  }
  return ev.agents || null;
}

function applySyncGlobals(
  rt: AppRuntime,
  ev: Extract<WebEvent, { t: 'sync' }>,
): { epochChanged: boolean; hasGlobals: boolean } {
  const { state } = rt;
  const prevEpoch = state.epoch;
  if (state.epochConfirmed && state.epoch && ev.epoch && ev.epoch !== state.epoch) rt.streamClient.checkBuild();
  state.epoch = ev.epoch || 0;
  state.epochConfirmed = state.epoch !== 0;
  const hasGlobals = ev.topics !== undefined;
  if (hasGlobals) {
    state.topics = ev.topics || [];
    state.offline = ev.offline || [];
  }
  if (ev.commands !== undefined) state.commands = ev.commands;
  if (ev.tv !== undefined) rt.streamClient.setTopicsVersion(ev.tv);
  return { epochChanged: Boolean(prevEpoch && state.epoch && prevEpoch !== state.epoch), hasGlobals };
}

function handleSyncEvent(rt: AppRuntime, ev: Extract<WebEvent, { t: 'sync' }>): void {
  const { state } = rt;
  const { targets, named } = resolveSyncTargets(rt, ev.topic);
  if (targets.length === 0) return;

  const { epochChanged, hasGlobals } = applySyncGlobals(rt, ev);
  for (const session of targets) {
    const overlaps = !epochChanged && windowOverlapsSession(session, ev, state.epoch);
    session.autoFillPages = 0;
    updateSessionPagingFromSync(session, ev, epochChanged, overlaps);
    syncSessionFromEvent(rt, session, ev, named, overlaps);
    consumePendingJump(rt, session);
    maybeFillShortViewport(rt, session);
  }

  if (visibleTopicIds(rt).includes(ev.topic)) {
    const count = ev.totalCount ?? topicById(state, ev.topic)?.msgCount ?? ev.messages.length;
    rt.readsService.setCount(ev.topic, count);
  }
  const activeId = focusedSession(state)?.topicId || ev.topic;
  state.topic = activeId;
  if (hasGlobals) rt.events.emit('topic.list', { topics: toTopicInfos(state.topics) });
  rt.events.emit('topic.active', { id: activeId, topic: topicById(state, activeId) as unknown as TopicInfo | undefined });
  rt.readsService.reportSeen();
  rt.registry.refreshActivityBadges();
}

function updateSessionPagingFromSync(
  session: TopicEditorSession,
  ev: Extract<WebEvent, { t: 'sync' }>,
  epochChanged: boolean,
  overlaps: boolean,
): void {
  const incomingHasMore = Boolean(ev.hasMore);
  const incomingOldest = ev.oldestSeq || 0;
  if (epochChanged || !incomingHasMore || !overlaps || session.oldestSeq <= 0) {
    session.hasMore = incomingHasMore;
    session.oldestSeq = incomingOldest;
  } else if (incomingOldest > 0 && incomingOldest < session.oldestSeq) {
    session.oldestSeq = incomingOldest;
  }
  session.loadingOlder = false;
  session.olderError = false;
}

function syncComposerAfterReconcile(
  composer: NonNullable<TopicEditorSession['editor']>['composer'],
  ev: Extract<WebEvent, { t: 'sync' }>,
): void {
  if (!composer) return;
  if (ev.recentNonces) {
    for (const nonce of ev.recentNonces) composer.retireLocalNonce(nonce);
  }
  composer.settleUnsure();
  if (ev.commands !== undefined) composer.setCommands(ev.commands);
}

function applySyncToSession(
  rt: AppRuntime,
  session: TopicEditorSession,
  ev: Extract<WebEvent, { t: 'sync' }>,
  named: boolean,
  arriving: boolean,
  stick: boolean,
  overlaps: boolean,
): void {
  const editor = session.editor;
  if (!editor) return;
  const { transcript, composer, status } = editor;
  if (named && composer) composer.loadDraftIfEmpty(session.topicId);
  if (transcript) {
    if (ev.topics !== undefined) transcript.takeMachines(ev.offline || []);
    transcript.repaintHistory();
  }
  if (composer) composer.showUnsent(session.topicId);
  const partial = Boolean(ev.hasMore) && overlaps;
  const dropDisconnected = Boolean(ev.hasMore) && !overlaps;
  if (transcript) transcript.reconcile(ev.messages, { partial, dropDisconnected });
  syncComposerAfterReconcile(composer, ev);
  if (transcript) {
    syncOlderIndicator(session);
    transcript.banners.placeDivider();
    transcript.banners.syncEmptyNote();
    if (transcript.btw.isOpen()) transcript.btw.render(false);
  }
  rt.cacheService.scheduleSave(session.topicId);
  if (status) {
    status.setStatus(ev.status);
    status.setPending(ev.pending || []);
  }
  editor.els.noteEl.textContent = '';
  if (transcript) {
    if (arriving) transcript.scroll.land(session.els);
    else if (stick) transcript.scroll.toBottom();
    transcript.scroll.clearView();
  }
  editor.refreshHeader();
  syncSessionStopButton(rt, session);
}

function adoptCachedTopicMessages(rt: AppRuntime, session: TopicEditorSession, topicId: string): void {
  const token = session.enterToken;
  void rt.cacheService.get(topicId).then((c) => {
    if (
      c &&
      c.msgs.length &&
      topicId === session.topicId &&
      rt.state.sessions.get(session.panelId) === session &&
      token === session.enterToken &&
      !(session.panelId === MAIN_PANEL_ID && rt.state.creatingTopic)
    ) {
      session.editor?.transcript?.adopt(c.msgs as unknown as readonly TranscriptMessage[]);
    }
  });
}

function eventTargetTopic(state: AppState, evTopic?: string): string {
  return evTopic || mainSession(state)?.topicId || state.topic;
}

function handleMessageEvent(rt: AppRuntime, msg: WebMessage, evTopic?: string): void {
  const { state } = rt;
  if (state.settingsBridge?.handleMessage(msg)) return;
  const targetTopic = eventTargetTopic(state, evTopic);
  const targets = sessionsForTopic(state, targetTopic);
  for (const session of targets) {
    const editor = session.editor;
    editor?.composer?.claim(msg);
    editor?.transcript?.upsert(msg);
    editor?.transcript?.btw.onArrived(msg);
    editor?.status?.onMessageArrived();
  }
  rt.cacheService.scheduleSave(targetTopic);
  if (visibleTopicIds(rt).includes(targetTopic)) {
    rt.readsService.increment(targetTopic);
  }
  const cur = topicById(state, targetTopic);
  if (cur) cur.msgCount = (cur.msgCount || 0) + 1;
  rt.events.emit('topic.message', { topicId: targetTopic, message: msg });
  rt.events.emit('topic.list', { topics: toTopicInfos(state.topics) });
  rt.registry.refreshActivityBadges();
}

function handleTopicsEvent(
  rt: AppRuntime,
  ev: Extract<WebEvent, { t: 'topics' | 'topic-rows' }>,
): void {
  const { state } = rt;
  state.topics = ev.t === 'topics' ? ev.topics || [] : applyTopicRows(state.topics, ev);
  rt.streamClient.setTopicsVersion(ev.tv || 0);
  rt.events.emit('topic.list', { topics: toTopicInfos(state.topics) });
  rt.readsService.reportSeen();
  const known = new Set(state.topics.map((t) => t.id));
  for (const session of [...state.sessions.values()]) {
    if (session.pinned && session.topicId && !known.has(session.topicId)) {
      rt.shell.dock.removePanel(session.panelId);
    }
  }
  const main = mainSession(state);
  if (main?.topicId && !known.has(main.topicId)) {
    const first = state.topics[0];
    if (first) switchTopic(rt, first.id);
    else void createTopic(rt);
  }
  rt.registry.refreshActivityBadges();
  for (const session of state.sessions.values()) {
    session.editor?.refreshHeader();
    syncSessionStopButton(rt, session);
  }
}

function syncSessionStopButton(rt: AppRuntime, session: TopicEditorSession): void {
  const editor = session.editor;
  if (!editor || !session.topicId) return;
  const cur = topicById(rt.state, session.topicId);
  const childRunning = hasRunningDescendant(rt.state.topics, session.topicId);
  const showStop = Boolean(cur?.running || childRunning);
  editor.els.stopBtn.hidden = !showStop;
  if (childRunning && !cur?.running) {
    editor.els.stopBtn.title = tr('composer.stopSubTitle');
  } else {
    editor.els.stopBtn.title = tr('composer.stopTitle');
  }
}

function hasRunningDescendant(topics: readonly Topic[], rootId: string): boolean {
  const seen = new Set<string>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const t of topics) {
      if (t.parent && seen.has(t.parent) && !seen.has(t.id)) {
        if (t.running) return true;
        seen.add(t.id);
        added = true;
      }
    }
  }
  return false;
}

function handleReactEvent(rt: AppRuntime, ev: Extract<WebEvent, { t: 'react' }>): void {
  const targetTopic = eventTargetTopic(rt.state, ev.topic);
  const rk = `${rt.state.epoch}:${ev.id}`;
  let updated = false;
  for (const session of sessionsForTopic(rt.state, targetTopic)) {
    const m = session.data[rk];
    if (!m) continue;
    const kept = (m.reactions || []).filter((e) => e !== ev.emoji);
    m.reactions = ev.on ? kept.concat([ev.emoji]) : kept;
    session.editor?.transcript?.paint(rk);
    updated = true;
  }
  if (updated) rt.cacheService.scheduleSave(targetTopic);
}

function handleTypingEvent(rt: AppRuntime, on: boolean, evTopic?: string): void {
  const targetTopic = eventTargetTopic(rt.state, evTopic);
  const cur = topicById(rt.state, targetTopic);
  if (cur) cur.running = on;
  rt.events.emit('topic.list', { topics: toTopicInfos(rt.state.topics) });
  for (const session of sessionsForTopic(rt.state, targetTopic)) {
    const editor = session.editor;
    if (editor) editor.els.typingEl.hidden = !on;
    if (!on) editor?.transcript?.codeBlocks.sweep();
    editor?.refreshHeader();
    syncSessionStopButton(rt, session);
  }
  if (!on) rt.events.emit('topic.turnEnd', { topicId: targetTopic });
}

function countLoadedMessages(session: TopicEditorSession): number {
  let count = 0;
  for (const k of Object.keys(session.els)) {
    const m = session.data[k];
    if (m && !m._local) count += 1;
  }
  return count;
}

function finishSessionResume(rt: AppRuntime, session: TopicEditorSession, visibleCount?: number): void {
  if (session.synced) return;
  // Self-heal cached transcripts whose paging cursor was lost (e.g. written before sw.ts kept hasMore/oldestSeq).
  if (
    !(session.hasMore && session.oldestSeq > 0) &&
    !session.resumeHealAttempted &&
    typeof visibleCount === 'number' &&
    visibleCount > countLoadedMessages(session)
  ) {
    session.resumeHealAttempted = true;
    rt.streamClient.clearLastEventId(session.topicId);
    rt.streamClient.connect(rt.state.sessions.size > 1, true);
    return;
  }
  const editor = session.editor;
  session.synced = true;
  session.entering = false;
  session.autoFillPages = 0;
  const settle = session.settleOnResume;
  session.settleOnResume = false;
  if (editor) {
    const { transcript, composer, status } = editor;
    if (settle && composer) composer.settleUnsure();
    if (transcript) {
      transcript.repaintHistory();
      transcript.banners.clearSyncing();
      transcript.banners.placeDivider();
      transcript.banners.syncEmptyNote();
      transcript.banners.paintMachineNote();
      if (transcript.btw.isOpen()) transcript.btw.render(false);
      transcript.scroll.clearView();
    }
    // Re-evaluate status now that session.synced is true: `status` events arrive before `resumed`.
    if (status) {
      status.paintStatus();
      status.paintPending();
    }
    editor.els.noteEl.textContent = '';
    editor.refreshHeader();
  }
  syncOlderIndicator(session);
  rt.cacheService.scheduleSave(session.topicId);
  syncSessionStopButton(rt, session);
  consumePendingJump(rt, session);
  maybeFillShortViewport(rt, session);
}

function handleResumedEvent(rt: AppRuntime, ev: Extract<WebEvent, { t: 'resumed' }>): void {
  const { state } = rt;
  if (ev.epoch) {
    if (state.epochConfirmed && state.epoch && ev.epoch !== state.epoch) rt.streamClient.checkBuild();
    state.epoch = ev.epoch;
    state.epochConfirmed = true;
  }
  const targetTopic = eventTargetTopic(state, ev.topic);
  for (const session of sessionsForTopic(rt.state, targetTopic)) {
    finishSessionResume(rt, session, ev.visibleCount);
  }
  if (visibleTopicIds(rt).includes(targetTopic)) {
    rt.readsService.markTopicFromList(targetTopic, state.topics);
  }
  const activeId = focusedSession(state)?.topicId || targetTopic;
  if (activeId) {
    state.topic = activeId;
    rt.events.emit('topic.active', { id: activeId, topic: topicById(state, activeId) as unknown as TopicInfo | undefined });
  }
  rt.readsService.reportSeen();
  rt.registry.refreshActivityBadges();
}

function handleStreamEvent(rt: AppRuntime, raw: StreamEventPayload): void {
  const ev = raw as unknown as WebEvent;
  if (typeof ev.t === 'string' && ev.t.startsWith('plugin:')) {
    rt.events.emit(ev.t as `plugin:${string}:${string}`, (ev as { readonly data?: unknown }).data);
    return;
  }
  const { state } = rt;
  const handlers: Record<WebEvent['t'], () => void> = {
    sync: () => handleSyncEvent(rt, ev as Extract<WebEvent, { t: 'sync' }>),
    msg: () => {
      const e = ev as Extract<WebEvent, { t: 'msg' }>;
      handleMessageEvent(rt, e.msg, e.topic);
    },
    del: () => {
      const e = ev as Extract<WebEvent, { t: 'del' }>;
      const targetTopic = eventTargetTopic(state, e.topic);
      for (const s of sessionsForTopic(state, targetTopic)) {
        s.editor?.transcript?.drop(`${state.epoch}:${e.id}`);
      }
      rt.cacheService.scheduleSave(targetTopic);
    },
    react: () => handleReactEvent(rt, ev as Extract<WebEvent, { t: 'react' }>),
    typing: () => {
      const e = ev as Extract<WebEvent, { t: 'typing' }>;
      handleTypingEvent(rt, e.on, e.topic);
    },
    commands: () => {
      const cmds = (ev as Extract<WebEvent, { t: 'commands' }>).commands || [];
      state.commands = cmds;
      for (const s of state.sessions.values()) s.editor?.composer?.setCommands(cmds);
    },
    status: () => {
      const e = ev as Extract<WebEvent, { t: 'status' }>;
      const targetTopic = eventTargetTopic(state, e.topic);
      for (const s of sessionsForTopic(state, targetTopic)) s.editor?.status?.setStatus(e.status);
    },
    pending: () => {
      const e = ev as Extract<WebEvent, { t: 'pending' }>;
      const targetTopic = eventTargetTopic(state, e.topic);
      for (const s of sessionsForTopic(state, targetTopic)) s.editor?.status?.setPending(e.items || []);
    },
    machines: () => {
      const offline = (ev as Extract<WebEvent, { t: 'machines' }>).offline || [];
      state.offline = offline;
      for (const s of state.sessions.values()) s.editor?.transcript?.setMachines(offline);
    },
    topics: () => handleTopicsEvent(rt, ev as Extract<WebEvent, { t: 'topics' }>),
    'topic-rows': () => handleTopicsEvent(rt, ev as Extract<WebEvent, { t: 'topic-rows' }>),
    resumed: () => handleResumedEvent(rt, ev as Extract<WebEvent, { t: 'resumed' }>),
    bye: () => {},
  };
  handlers[ev.t]?.();
}

function wireStreamAndCache(rt: AppRuntime): void {
  const { state, boot, cacheCore } = rt;
  rt.streamClient = createStreamClient({
    getTopic: () => mainSession(state)?.topicId || state.topic,
    getTopics: () => subscribedTopics(state),
    isLoggedOut: () => rt.workbenchRoot.hidden && Boolean(rt.gateForm && !rt.gateForm.hidden),
    getBuild: () => boot.build,
    onBeforeConnect: () => {
      rt.events.emit('stream.state', { state: 'connecting' });
      for (const s of state.sessions.values()) {
        if (!s.synced) s.editor?.transcript?.banners.showSkeleton();
      }
    },
    onOpen: (info) => {
      const fresh = rt.workbenchRoot.hidden || !info.quiet;
      if (rt.gateForm) rt.gateForm.hidden = true;
      if (rt.gate) rt.gate.hidden = true;
      rt.workbenchRoot.hidden = false;
      for (const s of state.sessions.values()) {
        if (s.editor) s.editor.els.noteEl.textContent = '';
      }
      rt.events.emit('stream.state', { state: 'open' });
      startExternalPlugins(rt);
      if (fresh && rt.shell.getMode() === 'desktop') {
        focusedSession(state)?.editor?.focus?.();
      }
    },
    onReconnecting: () => {
      rt.events.emit('stream.state', { state: 'reconnecting' });
      for (const s of state.sessions.values()) {
        if (s.editor) s.editor.els.noteEl.textContent = tr('chat.reconnecting');
      }
    },
    onRestarting: () => {
      rt.events.emit('stream.state', { state: 'reconnecting' });
      for (const s of state.sessions.values()) {
        if (s.editor) s.editor.els.noteEl.textContent = tr('chat.restarting');
      }
    },
    onAuthExpired: () => {
      rt.workbenchRoot.hidden = true;
      if (rt.gateForm) rt.gateForm.hidden = false;
      if (rt.gate) rt.gate.hidden = false;
      rt.events.emit('stream.state', { state: 'closed' });
    },
    onBuildOutdated: () => {
      rt.updateEmitter.fire(true);
    },
    onVisibilityResume: () => {},
  });
  rt.streamClient.onEvent((ev) => handleStreamEvent(rt, ev));
  rt.streamClient.attachWindowEvents(document, window);

  rt.cacheService = createCacheService({
    core: cacheCore,
    getIndexedDB: () => window.indexedDB,
    getTopic: () => mainSession(state)?.topicId || state.topic,
    getEpoch: () => state.epoch,
    isSynced: () => Boolean(mainSession(state)?.synced),
    isStale: () => Boolean(mainSession(state)?.stale),
    getLastEventId: () => rt.streamClient.getLastEventId(mainSession(state)?.topicId || state.topic),
    collectScreenMessages: () => {
      const s = mainSession(state);
      const log = s?.editor?.els.log;
      if (!s || !log) return [];
      return collectCacheableMessages(log, s.data as Record<string, CacheMessage | undefined>);
    },
    getTopicState: (topicId) => {
      const s = sessionsForTopic(state, topicId)[0];
      if (!s) return null;
      return {
        synced: s.synced,
        stale: s.stale,
        lastEventId: rt.streamClient.getLastEventId(topicId),
        hasMore: s.hasMore,
        oldestSeq: s.oldestSeq,
        collectMessages: () => {
          const log = s.editor?.els.log;
          if (!log) return [];
          return collectCacheableMessages(log, s.data as Record<string, CacheMessage | undefined>);
        },
      };
    },
    getOpenTopics: () => subscribedTopics(state),
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') rt.cacheService.leave();
  });
  window.addEventListener('pagehide', () => {
    rt.cacheService.leave();
  });

  rt.readsService = createReadsService({
    getActiveTopic: () => state.topic,
    getVisibleTopics: () => visibleTopicIds(rt),
    getTopics: () => state.topics,
    isOverlayBlocking: () => false,
    postSeen: (topicId) => post('api/seen', { topic: topicId }, 0),
    onChanged: () => {
      rt.events.emit('topic.list', { topics: toTopicInfos(state.topics) });
      rt.registry.refreshActivityBadges();
    },
  });
  rt.readsService.attachWindowEvents(document, window);
}

const BUILTIN_MORE_IDS = new Set(['reviews', 'history', 'settings']);

function syncMobileMoreState(rt: AppRuntime): void {
  const activities = rt.registry.listActivities();
  const revAct = activities.find((a) => a.id === 'reviews');
  const revCount = revAct?.badge?.();
  const extraItems = activities
    .slice(3)
    .filter((a) => !BUILTIN_MORE_IDS.has(a.id))
    .map((a) => {
      const b = a.badge?.();
      return {
        id: a.id,
        title: a.title,
        icon: a.icon,
        view: a.view,
        badge: typeof b === 'number' && b > 0 ? String(b) : undefined,
      };
    });
  let runningCount = 0;
  let idleCount = 0;
  for (const topic of rt.state.topics) {
    if (topic.running || topic.asking) runningCount += 1;
    else if (topic.live) idleCount += 1;
  }
  rt.shell.setMobileMoreState({
    prefsBadge: typeof revCount === 'number' && revCount > 0 ? String(revCount) : undefined,
    extraItems,
    notificationsEnabled: rt.notifyBridge.getState().enabled,
    lowAttention: rt.workbenchRoot.classList.contains('calm'),
    theme: getTheme(),
    locale: getLocale(),
    connected: rt.state.streamConnected,
    version: rt.boot.version ? `v${rt.boot.version}` : rt.boot.build ? rt.boot.build.slice(0, 7) : undefined,
    runningCount,
    idleCount,
    onOpenPrefs: () => {
      if (!rt.shell.editors.open('review-prefs', {})) {
        rt.shell.views.reveal('reviews');
      }
    },
    onOpenReviews: () => { rt.shell.views.reveal('reviews'); },
    onOpenHistory: () => { rt.shell.views.reveal('history'); },
    onOpenSettings: () => { rt.shell.views.reveal('settings'); },
    onOpenExtra: (viewId) => { rt.shell.views.reveal(viewId); },
    onToggleNotifications: () => {
      void Promise.resolve(rt.commands.execute('status.toggleNotify')).finally(() => syncMobileMoreState(rt));
    },
    onToggleLowAttention: () => {
      void rt.commands.execute('status.toggleCalm');
      syncMobileMoreState(rt);
    },
    onChangeTheme: (next) => {
      setTheme(next);
      rt.events.emit('theme.change', { theme: next });
      syncMobileMoreState(rt);
    },
    onChangeLocale: (next) => {
      setLocale(next);
      syncMobileMoreState(rt);
    },
    onCloseIdle: () => void rt.commands.execute('status.closeIdle'),
  });
}

function wireMobileMore(rt: AppRuntime): void {
  const sync = (): void => syncMobileMoreState(rt);
  rt.notifyBridge.onDidChange(sync);
  rt.registry.onDidChangeActivity(sync);
  rt.registry.onDidChangeActivityBadges(sync);
  rt.events.on('stream.state', ({ state }) => {
    rt.state.streamConnected = state === 'open';
    sync();
  });
  rt.events.on('topic.list', sync);
  rt.shell.onDidModeChange(sync);
  sync();
}

function wireLoginGate(rt: AppRuntime): void {
  rt.gateForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!rt.boot.password) {
      location.reload();
      return;
    }
    if (rt.errEl) rt.errEl.textContent = '';
    const token = rt.secretInput ? rt.secretInput.value : '';
    void post('api/login', { token }, 0)
      .then((r) => {
        if (r.ok) {
          if (rt.secretInput) rt.secretInput.value = '';
          rt.streamClient.connect();
          return;
        }
        if (rt.errEl) {
          rt.errEl.textContent =
            r.status === 429 ? tr('gate.tooManyAttempts') : tr('gate.wrongToken');
        }
      })
      .catch(() => {
        if (rt.errEl) rt.errEl.textContent = tr('common.reachServerError');
      });
  });
}

function startExternalPlugins(rt: AppRuntime): void {
  if (rt.externalPluginsStarted || rt.boot.plugins.length === 0) return;
  rt.externalPluginsStarted = true;
  const basePath = new URL('.', location.href).pathname;
  const loader = new ExternalPluginLoader({
    manager: rt.pluginManager,
    doc: document,
    basePath,
    onError: (failure: PluginLoadFailure) => {
      console.warn(`[webui:plugin:${failure.pluginId}] failed during ${failure.phase}: ${failure.message}`);
      // Activation errors are already recorded by PluginManager.onDidError.
      if (failure.phase === 'activate') return;
      const record: StatusPluginError = {
        pluginId: failure.pluginId,
        phase: failure.phase,
        message: failure.message,
        timestamp: failure.timestamp,
      };
      rt.externalPluginErrors.push(record);
      rt.externalPluginErrorEmitter.fire(record);
    },
  });
  rt.externalPluginLoader = loader;
  void loader.load(rt.boot.plugins).catch((err: unknown) => {
    console.warn('[webui] external plugin loader failed:', err);
  });
}

function bootstrap(): void {
  initLocale();
  applyDomI18n(document);

  const boot = readBootConfig(document);
  const icons = __FH_ICONS__;
  const cacheCore = loadCacheCore();
  const codeView = createCodeViewLoader(boot.codeview);
  const storage = new StorageService();
  const overlays = new OverlayManager();
  overlays.attach(document);
  const commands = new CommandRegistry();
  const keybindings = new KeybindingService({
    executeCommand: (id, ...a) => commands.execute(id, ...a),
  });
  keybindings.attach(document);
  const api = createApiClient();
  const events = new WebuiEventBus();
  const registry = new ContributionRegistry({ commands, keybindings });

  const workbenchRoot = document.getElementById('workbench-root');
  if (!workbenchRoot) throw new Error('Missing required element #workbench-root');

  const shell = mountWorkbench(document, {
    storage,
    registry,
    resolveIcon: (name) => icons.icon[name] ?? '',
  });
  if (!shell) throw new Error('Failed to mount WorkbenchShell');

  const state: AppState = {
    topics: [],
    topic: new URLSearchParams(location.search).get('t') || '',
    focusedPanelId: MAIN_PANEL_ID,
    epoch: 0,
    epochConfirmed: false,
    offline: [],
    commands: [],
    sessions: new Map(),
    sessionByRoot: new WeakMap(),
    bootstrapped: false,
    creatingTopic: false,
    workdirCache: new Map<string, WorkdirScreen>(),
    insertHandler: null,
    settingsBridge: null,
    streamConnected: false,
    pendingJumpMsgId: readInitialJumpMsgId(),
  };

  const notifyBridge = createStatusNotifyBridge({ doc: document, win: window, postFn: post });

  const rt = {
    boot,
    icons,
    storage,
    overlays,
    commands,
    keybindings,
    api,
    events,
    registry,
    shell,
    cacheCore,
    codeView,
    updateEmitter: new Emitter<boolean>(),
    externalPluginErrors: [] as StatusPluginError[],
    externalPluginErrorEmitter: new Emitter<StatusPluginError>(),
    externalPluginsStarted: false,
    state,
    gate: document.getElementById('login'),
    gateForm: document.getElementById('gate') as HTMLFormElement | null,
    secretInput: document.getElementById('secret') as HTMLInputElement | null,
    errEl: document.getElementById('err'),
    workbenchRoot,
    notifyBridge,
  } as unknown as AppRuntime;

  wireStreamAndCache(rt);

  const pluginManager = new PluginManager({
    registry,
    events,
    topics: {
      list: () => toTopicInfos(state.topics),
      active: () => topicById(state, state.topic) as unknown as TopicInfo | undefined,
      open: (id) => switchTopic(rt, id),
      insertIntoComposer: (id, text) => {
        if (state.insertHandler?.(id, text)) return;
        if (id && id !== state.topic) switchTopic(rt, id);
        focusedSession(state)?.editor?.insertIntoComposer(text);
      },
    },
    api,
    storage,
  });
  (rt as { pluginManager: PluginManager }).pluginManager = pluginManager;

  registerBuiltinPlugins(pluginManager, createDefaultBuiltinPluginFactories(buildBuiltinDeps(rt)));
  void pluginManager.activateAll().then(() => finishBootstrap(rt));
  wireShellEventsAndLocale(rt);

  commands.register('workbench.resetLayout', () => shell.resetLayout(), { title: 'Reset Layout' });
  commands.register('workbench.toggleTerminal', () => void commands.execute(TERMINAL_TOGGLE_COMMAND));

  overlays.registerFallback(() => {
    const editor = focusedSession(state)?.editor ?? null;
    if (editor?.composer?.isHintsOpen()) {
      editor.composer.closeHints();
      return true;
    }
    if (editor?.transcript?.btw.isOpen()) {
      editor.transcript.btw.close(true);
      return true;
    }
    return false;
  });

  wireLoginGate(rt);
}

function dropPinnedIfNonDesktop(rt: AppRuntime): void {
  if (rt.shell.getMode() === 'desktop') return;
  for (const s of [...rt.state.sessions.values()]) {
    if (s.pinned) rt.shell.dock.removePanel(s.panelId);
  }
}

function reconcileRestoredMainSession(rt: AppRuntime, urlTopic: string): void {
  const { state } = rt;
  const restoredMain = mainSession(state);
  if (restoredMain) {
    const targetId = urlTopic || restoredMain.topicId;
    if (targetId && targetId !== restoredMain.topicId) {
      resetSessionView(restoredMain, targetId);
      ensureTopicEditorOpen(rt, targetId);
    } else if (targetId) {
      state.topic = targetId;
    }
    return;
  }
  if (state.sessions.size === 0 || (urlTopic && sessionsForTopic(state, urlTopic).length === 0)) {
    ensureTopicEditorOpen(rt, urlTopic || state.topic);
  }
}

function finishBootstrap(rt: AppRuntime): void {
  const { shell, state } = rt;
  const restored = shell.restoreLayout();
  dropPinnedIfNonDesktop(rt);
  shell.views.reveal('topics', { openPart: !restored && shell.getMode() === 'desktop' });
  reconcileRestoredMainSession(rt, new URLSearchParams(location.search).get('t') || '');
  const activePanel = shell.dock.getActiveGroupPanel();
  const activeSession = activePanel ? state.sessions.get(activePanel) : undefined;
  if (activePanel && activeSession) {
    state.focusedPanelId = activePanel;
    if (activeSession.topicId) state.topic = activeSession.topicId;
  }
  wireMobileMore(rt);
  const initialSessions: Array<{ session: TopicEditorSession; topicId: string; token: number }> = [];
  for (const session of state.sessions.values()) {
    if (!session.topicId) continue;
    session.editor?.composer?.loadDraftIfEmpty(session.topicId);
    initialSessions.push({ session, topicId: session.topicId, token: session.enterToken });
  }
  state.bootstrapped = true;
  startBootstrapStream(rt, initialSessions);
}

function startBootstrapStream(
  rt: AppRuntime,
  initialSessions: ReadonlyArray<{ session: TopicEditorSession; topicId: string; token: number }>,
): void {
  if (initialSessions.length === 0 || !rt.cacheService.isDbAvailable()) {
    rt.streamClient.connect();
    return;
  }
  let connected = false;
  let resumeAny = false;
  const startStream = (): void => {
    if (connected) return;
    connected = true;
    rt.streamClient.connect(resumeAny);
  };
  const timer = setTimeout(startStream, LOCAL_CACHE_WAIT_MS);
  void Promise.all(
    initialSessions.map(({ session, topicId, token }) =>
      rt.cacheService.get(topicId).then((c) => {
        if (
          !c ||
          !c.msgs.length ||
          topicId !== session.topicId ||
          rt.state.sessions.get(session.panelId) !== session ||
          token !== session.enterToken ||
          (session.panelId === MAIN_PANEL_ID && rt.state.creatingTopic)
        ) {
          return;
        }
        const canResume = !connected && Boolean(c.last && c.epoch);
        if (canResume && c.epoch > rt.state.epoch) {
          // Seed epoch before adopting so older-run history messages and pre-`resumed` replays key accurately.
          rt.state.epoch = c.epoch;
        }
        adoptCachedCopy(rt, session, topicId, c, canResume);
        session.editor?.composer?.showUnsent(topicId);
        if (canResume) {
          rt.streamClient.setLastEventId(c.last, topicId);
          session.settleOnResume = true;
          resumeAny = true;
        }
      }),
    ),
  ).then(() => {
    clearTimeout(timer);
    startStream();
  });
}

function wireShellEventsAndLocale(rt: AppRuntime): void {
  const { shell, state, events } = rt;
  shell.dock.onDidActivePanelChange((ref) => {
    if (ref && state.sessions.has(ref.id)) setFocusedTopicSession(rt, ref.id);
  });
  shell.dock.onDidLayoutChange(() => {
    if (state.bootstrapped) markVisibleTopicsRead(rt);
  });
  shell.onDidModeChange(() => dropPinnedIfNonDesktop(rt));
  onLocaleChange((locale) => {
    applyDomI18n(document);
    events.emit('locale.change', { locale });
    for (const s of state.sessions.values()) {
      s.editor?.transcript?.refreshI18n();
      s.editor?.composer?.onLocaleChange();
      s.editor?.status?.onLocaleChange();
      s.editor?.refreshHeader();
    }
    shell.statusBarApi.refresh();
    shell.refreshMobileTabs();
    syncMobileMoreState(rt);
  });
}

bootstrap();
