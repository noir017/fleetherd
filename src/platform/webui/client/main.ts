// Web UI client entrypoint: services, WorkbenchShell, ContributionRegistry, 12 built-in plugins,
// SSE stream dispatch, login gate, and startup sequence.
// Bundled by `scripts/webui-client.mjs` into `dist/webui-assets/app-<hash>.js` with two build-time
// markers replaced before bundling with `clientIcons()` (`icons.ts`) and `CACHE_CORE` (`cache-script.ts`).

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
import type { LaunchChoice, TranscriptMessage, WorkdirScreen } from './features/topic/transcript/index.js';
import { isRowCurrent, type TopicSnapshotPayload } from './features/topics/index.js';
import { applyDomI18n, initLocale, onLocaleChange, t as tr } from './i18n/index.js';
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

interface CacheCoreBundle extends CacheCore {
  readonly snapshotMsgs: (d: TopicSnapshotPayload) => CacheMessage[];
}

interface AppState {
  data: Record<string, TranscriptMessage | undefined>;
  els: Record<string, HTMLElement | undefined>;
  topics: Topic[];
  topic: string;
  epoch: number;
  synced: boolean;
  entering: boolean;
  stale: boolean;
  launch: LaunchChoice | null;
  launchWdSeq: number;
  settleOnResume: boolean;
  enterToken: number;
  activeEditor: TopicEditorHandle | null;
  insertHandler: ((topicId: string, text: string) => boolean) | null;
  settingsBridge: SettingsPluginBridge | null;
  streamConnected: boolean;
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

function ensureTopicEditorOpen(rt: AppRuntime, topicId: string): void {
  const panel = rt.shell.dock.getPanel('topic:active');
  const existing = rt.state.activeEditor;
  if (panel && existing) {
    existing.update?.({ topicId });
    if (rt.shell.getMode() !== 'mobile') {
      panel.focus();
    } else if (rt.shell.dock.getActiveGroupPanel() !== 'topic:active') {
      panel.focus();
      if (document.activeElement === existing.els.input) {
        existing.els.input.blur();
      }
    }
    return;
  }
  rt.state.activeEditor = null;
  rt.shell.editors.open('topic', { topicId }, { id: 'topic:active' });
}

function resetTopicView(rt: AppRuntime, id: string): void {
  const editor = rt.state.activeEditor;
  rt.state.topic = id;
  rt.state.data = {};
  rt.state.els = {};
  rt.state.stale = false;
  rt.state.entering = true;
  rt.state.synced = false;
  if (editor) {
    editor.els.log.replaceChildren();
    editor.status?.closeModelPop();
    editor.status?.setStatus(null);
    editor.status?.setPending([]);
  }
}

function canResumeFromCache(c: CacheCopy | null, epoch: number): c is CacheCopy {
  return Boolean(c && c.msgs.length && c.last && epoch && c.epoch === epoch);
}

function adoptCachedCopy(rt: AppRuntime, id: string, c: CacheCopy, resume: boolean): void {
  const editor = rt.state.activeEditor;
  const composer = editor?.composer;
  if (composer) {
    for (const msg of c.msgs) composer.claim(msg as unknown as WebMessage);
  }
  if (resume) rt.state.stale = c.stale;
  if (!c.msgs.length) return;
  const row = topicById(rt.state, id);
  const current = resume && isRowCurrent(row, c.last, (a, b) => rt.cacheService.isNewer(a, b));
  editor?.transcript?.adopt(c.msgs as unknown as readonly TranscriptMessage[], current);
}

function applyCachedTopicEntry(rt: AppRuntime, id: string, c: CacheCopy | null): boolean {
  const resume = canResumeFromCache(c, rt.state.epoch);
  if (c) adoptCachedCopy(rt, id, c, resume);
  if (id) rt.state.activeEditor?.composer?.showUnsent(id);
  if (resume && c) {
    rt.streamClient.setLastEventId(c.last);
    rt.state.settleOnResume = true;
  }
  return resume;
}

function enterTopic(rt: AppRuntime, id: string): void {
  const mine = ++rt.state.enterToken;
  let used = false;
  const v = id ? rt.cacheService.getVersion(id) : undefined;
  rt.streamClient.close();
  const here = (): boolean => mine === rt.state.enterToken && id === rt.state.topic;

  const go = (c: CacheCopy | null): void => {
    if (used) return;
    used = true;
    if (!here()) return;
    const resume = applyCachedTopicEntry(rt, id, c);
    rt.streamClient.connect(resume);
  };

  const m = id ? rt.cacheService.memCopy(id) : null;
  if (m || !id) {
    go(m);
    return;
  }
  void rt.cacheService.get(id).then((c) => {
    if (!used) {
      go(c);
      return;
    }
    if (c && c.msgs.length && here()) {
      rt.state.activeEditor?.transcript?.adopt(c.msgs as unknown as readonly TranscriptMessage[]);
    }
  });
  const epoch = rt.state.epoch;
  if (epoch && rt.cacheService.isDbAvailable() && (!v || (v.last && v.epoch === epoch))) {
    setTimeout(() => go(null), LOCAL_CACHE_WAIT_MS);
  } else {
    go(null);
  }
}

function switchTopic(rt: AppRuntime, id: string): void {
  if (!id) return;
  const prev = rt.state.topic;
  if (prev && prev !== id) {
    rt.cacheService.leave();
    rt.state.activeEditor?.transcript?.scroll.saveView(prev, rt.state.entering);
    rt.state.activeEditor?.composer?.stashDraft(prev);
  }
  if (prev !== id) {
    resetTopicView(rt, id);
    history.replaceState(null, '', currentTopicUrl(id));
    ensureTopicEditorOpen(rt, id);
    rt.readsService.markTopicFromList(id, rt.state.topics);
    rt.readsService.reportSeen();
    const active = topicById(rt.state, id);
    rt.events.emit('topic.active', { id, topic: active as unknown as TopicInfo | undefined });
    rt.state.activeEditor?.transcript?.banners.showSkeleton();
    enterTopic(rt, id);
  } else {
    ensureTopicEditorOpen(rt, id);
    rt.readsService.reportSeen();
  }
  if (rt.shell.getMode() === 'mobile' && rt.shell.isPartVisible('sidebar')) {
    rt.shell.setPartVisible('sidebar', false);
  }
}

async function createTopic(rt: AppRuntime, seed?: { readonly text?: string; readonly draft?: string }): Promise<boolean> {
  try {
    const res = await post('api/topics', {}, 0);
    if (!res.ok) return false;
    const data = (await res.json()) as { id?: string; topic?: { id?: string } };
    const id = data.topic?.id ?? data.id;
    if (!id) return false;
    switchTopic(rt, id);
    if (seed?.draft) {
      rt.state.activeEditor?.insertIntoComposer(seed.draft);
    }
    return true;
  } catch {
    return false;
  }
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

function loadLaunchWorkdirs(
  rt: AppRuntime,
  tid: string,
  agentId: string,
  opts?: { readonly dir?: string; readonly atRoot?: boolean },
): void {
  const seq = ++rt.state.launchWdSeq;
  const params = new URLSearchParams({ t: tid, agent: agentId });
  if (opts?.dir) params.set('dir', opts.dir);
  if (opts?.atRoot) params.set('root', '1');
  void fetch(`api/topics/workdirs?${params.toString()}`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? (r.json() as Promise<WorkdirScreen>) : null))
    .then((screen) => {
      if (seq !== rt.state.launchWdSeq || rt.state.topic !== tid) return;
      if (screen && typeof screen.browsing === 'string') {
        rt.state.activeEditor?.transcript?.banners.setLaunchWorkdir(screen, false);
      } else {
        rt.state.activeEditor?.transcript?.banners.setLaunchWorkdir(null, false);
      }
    })
    .catch(() => {
      if (seq === rt.state.launchWdSeq && rt.state.topic === tid) {
        rt.state.activeEditor?.transcript?.banners.setLaunchWorkdir(null, false);
      }
    });
}

function buildTranscriptDeps(rt: AppRuntime, els: TopicEditorElements, getTopicId: () => string) {
  const { state, icons, codeView } = rt;
  return {
    log: els.log,
    btwBox: els.btwBox,
    btwQ: els.btwQ,
    btwBody: els.btwBody,
    btwClose: els.btwClose,
    machineNoteEl: els.machineNoteEl,
    forkNote: els.forkNote,
    getExtraCodeRoots: () => Array.from(document.querySelectorAll<HTMLElement>('.wb-reader-editor')),
    getData: () => state.data,
    getEls: () => state.els,
    getTopic: getTopicId,
    getTopics: () => state.topics,
    topicById: (id: string) => topicById(state, id) ?? null,
    getEpoch: () => state.epoch,
    isSynced: () => state.synced,
    isStale: () => state.stale,
    isEntering: () => state.entering,
    getLaunch: () => state.launch,
    keyOf,
    isHistory: (m: TranscriptMessage | undefined) => isHistory(state, m),
    getIcons: () => icons,
    formatStatusClock: stClock,
    codeView,
    copyText: (s: string, cb: (ok: boolean) => void) => state.activeEditor?.composer?.copyText(s, cb),
    hasOutbox: (nonce: string) => Boolean(state.activeEditor?.composer?.hasOutbox(nonce)),
    claim: (m: TranscriptMessage) => Boolean(state.activeEditor?.composer?.claim(m as unknown as WebMessage)),
    adoptLegacy: (m: TranscriptMessage) => Boolean(state.activeEditor?.composer?.adoptLegacy(m as unknown as WebMessage)),
    showUnsent: (tId: string) => state.activeEditor?.composer?.showUnsent(tId),
    cacheSave: () => rt.cacheService.scheduleSave(),
    getHistoryMessage: () => undefined,
    repaintHistoryMessage: () => {},
    paintTopics: () => rt.events.emit('topic.list', { topics: toTopicInfos(state.topics) }),
    paintStatus: () => state.activeEditor?.status?.paintStatus(),
    switchTopic: (id: string) => switchTopic(rt, id),
    isNarrow: () => rt.shell.getMode() !== 'desktop',
    setSidebar: (open: boolean) => rt.shell.setPartVisible('sidebar', open),
    openShot: (img: HTMLImageElement) => {
      void rt.commands.execute(READER_OPEN_IMAGE_COMMAND, { src: img.src, alt: img.alt, restoreFocus: img });
    },
    sendCommand: (cmd: string) => state.activeEditor?.composer?.command(cmd),
    onLaunchShown: (agentId: string) => {
      const tid = getTopicId();
      if (tid) loadLaunchWorkdirs(rt, tid, agentId);
    },
    selectLaunchAgent: (agentId: string) => {
      const tid = getTopicId();
      if (!tid) return;
      const prevAgent = state.launch?.current;
      if (state.launch) state.launch = { ...state.launch, current: agentId };
      state.activeEditor?.transcript?.banners.setLaunchAgent(agentId);
      state.activeEditor?.transcript?.banners.setLaunchWorkdir(null, true);
      state.activeEditor?.status?.onAgentChosen();
      void post('api/topics/setup', { topic: tid, agent: agentId }, 1)
        .then((r) => r.json().then((j: { ok?: boolean; agent?: string; cwd?: string; error?: string }) => ({ r, j })))
        .then(({ r, j }) => {
          if (state.topic !== tid) return;
          if (!r.ok || !j.ok) {
            if (prevAgent && state.launch) {
              state.launch = { ...state.launch, current: prevAgent };
              state.activeEditor?.transcript?.banners.setLaunchAgent(prevAgent);
            }
            state.activeEditor?.transcript?.banners.setLaunchWorkdir(null, false);
            els.noteEl.textContent = j.error || tr('common.networkError');
            return;
          }
          const chosen = j.agent || agentId;
          if (j.cwd) state.activeEditor?.transcript?.banners.setLaunchCwd(j.cwd);
          state.activeEditor?.status?.peekOptions();
          loadLaunchWorkdirs(rt, tid, chosen, { atRoot: true });
        })
        .catch(() => {
          if (state.topic !== tid) return;
          els.noteEl.textContent = tr('common.networkError');
        });
    },
    browseLaunchWorkdir: (dir: string) => {
      const tid = getTopicId();
      const agentId = state.launch?.current;
      if (!tid || !agentId) return;
      state.activeEditor?.transcript?.banners.setLaunchWorkdir(null, true);
      loadLaunchWorkdirs(rt, tid, agentId, { dir });
    },
    pickLaunchWorkdir: (cwd: string) => {
      const tid = getTopicId();
      const agentId = state.launch?.current;
      if (!tid || !agentId) return;
      state.activeEditor?.transcript?.banners.setLaunchCwd(cwd);
      state.activeEditor?.status?.onAgentChosen();
      void post('api/topics/setup', { topic: tid, agent: agentId, cwd }, 1)
        .then((r) => r.json().then((j: { ok?: boolean; agent?: string; cwd?: string; error?: string }) => ({ r, j })))
        .then(({ r, j }) => {
          if (state.topic !== tid) return;
          if (!r.ok || !j.ok) {
            els.noteEl.textContent = j.error || tr('common.networkError');
            return;
          }
          if (j.cwd) state.activeEditor?.transcript?.banners.setLaunchCwd(j.cwd);
          state.activeEditor?.status?.peekOptions();
        })
        .catch(() => {
          if (state.topic !== tid) return;
          els.noteEl.textContent = tr('common.networkError');
        });
    },
    openReader: (link: Element) => {
      void rt.commands.execute(READER_OPEN_COMMAND, link);
    },
    deliverLocal: (nonce: string) => state.activeEditor?.composer?.deliver(nonce),
    copyLocal: (nonce: string, btn: Element) => {
      if (btn instanceof HTMLElement) state.activeEditor?.composer?.copyLocal(nonce, btn);
    },
    discardLocal: (nonce: string) => state.activeEditor?.composer?.discardLocal(nonce),
  };
}

function buildStatusDeps(rt: AppRuntime, els: TopicEditorElements, getTopicId: () => string) {
  const { state, icons } = rt;
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
    isSynced: () => state.synced,
    hasLauncher: () => Boolean(state.activeEditor?.transcript?.banners.hasLaunch()),
    hasMessages: () => Boolean(els.log.querySelector('.m')),
    narrow: () => rt.shell.getMode() !== 'desktop',
    getIcons: () => icons.icon,
    inl,
    setNote: (msg: string) => {
      els.noteEl.textContent = msg;
    },
    onRetireLocalNonce: (nonce: string) => state.activeEditor?.composer?.retireLocalNonce(nonce),
    onRecallContent: (content: string) => state.activeEditor?.composer?.recallContent(content),
  };
}

function buildComposerDeps(rt: AppRuntime, els: TopicEditorElements, getTopicId: () => string) {
  const { state, icons, boot, overlays } = rt;
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
    cacheSave: () => rt.cacheService.scheduleSave(),
    topicStatus: ({
      addLocalPending: (item) => state.activeEditor?.status?.addLocalPending(item),
      removeLocalPending: (nonce) => state.activeEditor?.status?.removeLocalPending(nonce) ?? false,
      hasLocalPending: (nonce) => state.activeEditor?.status?.hasLocalPending(nonce) ?? false,
    }) satisfies ComposerTopicStatusBridge,
    transcript: {
      getMessage: (key: string) => state.data[key] as unknown as LocalBubbleMessage | undefined,
      setMessage: (key: string, msg: LocalBubbleMessage) => {
        state.data[key] = msg as unknown as TranscriptMessage;
      },
      deleteMessage: (key: string) => state.activeEditor?.transcript?.retireLocalKey(key),
      hasElement: (key: string) => Boolean(state.els[key]),
      removeElement: (key: string) => {
        const el = state.els[key];
        if (el) {
          el.remove();
          delete state.els[key];
        }
      },
      adoptElement: (fromKey: string, toKey: string) => state.activeEditor?.transcript?.transferLocalKey(fromKey, toKey),
      paint: (key: string) => state.activeEditor?.transcript?.paint(key),
      drop: (key: string) => state.activeEditor?.transcript?.drop(key),
      sinkLocals: () => state.activeEditor?.transcript?.sinkLocals(),
      syncEmptyNote: () => state.activeEditor?.transcript?.banners.syncEmptyNote(),
      atBottom: () => Boolean(state.activeEditor?.transcript?.scroll.atBottom()),
      toBottom: () => state.activeEditor?.transcript?.scroll.toBottom(),
      onBtwAsked: (key: string, msg: LocalBubbleMessage) => {
        const trCtrl = state.activeEditor?.transcript;
        if (trCtrl && trCtrl.btwAsked(key, msg as unknown as TranscriptMessage) !== null) {
          trCtrl.btw.open(key);
        }
      },
      onClaimKeyMoved: (fromKey: string, toKey: string) => state.activeEditor?.transcript?.btw.transferKey(fromKey, toKey),
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
      onCreateTopic: () => createTopic(rt),
      prefetchDeps: {
        isDbAvailable: () => rt.cacheService.isDbAvailable(),
        isStreamParked: () => rt.streamClient.isParked(),
        isStreamOpen: () => rt.streamClient.isOpen(),
        getEpoch: () => state.epoch,
        getVersion: (id) => rt.cacheService.getVersion(id),
        isNewer: (a, b) => rt.cacheService.isNewer(a, b),
        peekCache: (id) => rt.cacheService.peek(id),
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
        state.activeEditor?.refreshHeader();
      },
      onToggleSidebar: () => {
        shell.setPartVisible('sidebar', !shell.isPartVisible('sidebar'));
      },
      onForkTopic: (id) => void forkTopic(rt, id),
      onDeleteTopic: (id) => void deleteTopic(rt, id),
      onCloseIdle: () => void rt.commands.execute('status.closeIdle'),
      onEditorCreated: (handle) => {
        state.activeEditor = handle;
      },
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
        state.activeEditor?.transcript?.codeBlocks.enhance(root);
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
        state.activeEditor?.transcript?.codeBlocks.enhance(root);
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
        state.activeEditor?.transcript?.codeBlocks.enhance(root);
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
        if (state.topic) state.activeEditor?.composer?.stashDraft(state.topic);
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

function handleSyncEvent(rt: AppRuntime, ev: Extract<WebEvent, { t: 'sync' }>): void {
  const { state } = rt;
  if (state.topic && ev.topic !== state.topic) return;
  const named = !state.topic;
  state.topic = ev.topic;
  ensureTopicEditorOpen(rt, state.topic);
  const editor = state.activeEditor;
  history.replaceState(null, '', currentTopicUrl(state.topic));

  const scroll = editor?.transcript?.scroll;
  const arriving = scroll ? scroll.isArriving(state.entering) : false;
  const stick = scroll ? scroll.atBottom() : false;
  state.entering = false;
  if (state.epoch && ev.epoch && ev.epoch !== state.epoch) rt.streamClient.checkBuild();
  state.settleOnResume = false;
  state.epoch = ev.epoch || 0;
  state.synced = true;
  state.stale = Boolean(ev.stale);
  state.launch = ev.agents || null;

  applySyncToEditor(rt, editor, ev, named, arriving, stick);
  if (named) adoptCachedTopicMessages(rt, ev.topic);
  rt.readsService.setCount(state.topic, ev.messages.length);
  state.topics = ev.topics || [];
  rt.streamClient.setTopicsVersion(ev.tv || 0);
  const active = topicById(state, state.topic);
  rt.events.emit('topic.list', { topics: toTopicInfos(state.topics) });
  rt.events.emit('topic.active', { id: state.topic, topic: active as unknown as TopicInfo | undefined });
  rt.readsService.reportSeen();
  rt.registry.refreshActivityBadges();
}

function applySyncToEditor(
  rt: AppRuntime,
  editor: TopicEditorHandle | null,
  ev: Extract<WebEvent, { t: 'sync' }>,
  named: boolean,
  arriving: boolean,
  stick: boolean,
): void {
  if (!editor) return;
  const { transcript, composer, status } = editor;
  if (named && composer) composer.loadDraftIfEmpty(rt.state.topic);
  if (transcript) {
    transcript.takeMachines(ev.offline || []);
    transcript.repaintHistory();
  }
  if (composer) composer.showUnsent(rt.state.topic);
  if (transcript) transcript.reconcile(ev.messages);
  if (composer) {
    composer.settleUnsure();
    composer.setCommands(ev.commands || []);
  }
  if (transcript) {
    transcript.banners.placeDivider();
    transcript.banners.syncEmptyNote();
    if (transcript.btw.isOpen()) transcript.btw.render(false);
  }
  rt.cacheService.scheduleSave();
  if (status) {
    status.setStatus(ev.status);
    status.setPending(ev.pending || []);
  }
  editor.els.noteEl.textContent = '';
  if (transcript) {
    if (arriving) transcript.scroll.land(rt.state.els);
    else if (stick) transcript.scroll.toBottom();
    transcript.scroll.clearView();
  }
  editor.refreshHeader();
}

function adoptCachedTopicMessages(rt: AppRuntime, topicId: string): void {
  void rt.cacheService.get(topicId).then((c) => {
    if (c && c.msgs.length && topicId === rt.state.topic) {
      rt.state.activeEditor?.transcript?.adopt(c.msgs as unknown as readonly TranscriptMessage[]);
    }
  });
}

function handleMessageEvent(rt: AppRuntime, msg: WebMessage): void {
  const { state } = rt;
  if (state.settingsBridge?.handleMessage(msg)) return;
  const editor = state.activeEditor;
  editor?.composer?.claim(msg);
  editor?.transcript?.upsert(msg);
  editor?.transcript?.btw.onArrived(msg);
  rt.cacheService.scheduleSave();
  editor?.status?.onMessageArrived();
  rt.readsService.increment(state.topic);
  const cur = topicById(state, state.topic);
  if (cur) cur.msgCount = (cur.msgCount || 0) + 1;
  rt.events.emit('topic.message', { topicId: state.topic, message: msg });
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
  if (state.topic && !state.topics.some((t) => t.id === state.topic)) {
    const first = state.topics[0];
    if (first) switchTopic(rt, first.id);
    else void createTopic(rt);
  }
  rt.registry.refreshActivityBadges();
  state.activeEditor?.refreshHeader();
  syncActiveStopButton(rt);
}

function syncActiveStopButton(rt: AppRuntime): void {
  const editor = rt.state.activeEditor;
  if (!editor || !rt.state.topic) return;
  const cur = topicById(rt.state, rt.state.topic);
  const childRunning = hasRunningDescendant(rt.state.topics, rt.state.topic);
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
  const rk = `${rt.state.epoch}:${ev.id}`;
  const m = rt.state.data[rk];
  if (!m) return;
  const kept = (m.reactions || []).filter((e) => e !== ev.emoji);
  m.reactions = ev.on ? kept.concat([ev.emoji]) : kept;
  rt.state.activeEditor?.transcript?.paint(rk);
  rt.cacheService.scheduleSave();
}

function handleTypingEvent(rt: AppRuntime, on: boolean): void {
  const editor = rt.state.activeEditor;
  if (editor) editor.els.typingEl.hidden = !on;
  const cur = topicById(rt.state, rt.state.topic);
  if (cur) cur.running = on;
  rt.events.emit('topic.list', { topics: toTopicInfos(rt.state.topics) });
  if (!on) {
    editor?.transcript?.codeBlocks.sweep();
    rt.events.emit('topic.turnEnd', { topicId: rt.state.topic });
  }
  editor?.refreshHeader();
}

function handleResumedEvent(rt: AppRuntime): void {
  if (rt.state.synced) return;
  const editor = rt.state.activeEditor;
  rt.state.synced = true;
  rt.state.entering = false;
  if (rt.state.settleOnResume) {
    rt.state.settleOnResume = false;
    editor?.composer?.settleUnsure();
  }
  editor?.transcript?.banners.clearSyncing();
  editor?.transcript?.banners.placeDivider();
  editor?.transcript?.banners.syncEmptyNote();
  editor?.transcript?.scroll.clearView();
  rt.cacheService.scheduleSave();
  if (editor) editor.els.noteEl.textContent = '';
}

function handleStreamEvent(rt: AppRuntime, raw: StreamEventPayload): void {
  const ev = raw as unknown as WebEvent;
  if (typeof ev.t === 'string' && ev.t.startsWith('plugin:')) {
    rt.events.emit(ev.t as `plugin:${string}:${string}`, (ev as { readonly data?: unknown }).data);
    return;
  }
  const editor = rt.state.activeEditor;
  const trCtrl = editor ? editor.transcript : null;
  const stCtrl = editor ? editor.status : null;
  const cpCtrl = editor ? editor.composer : null;
  const handlers: Record<WebEvent['t'], () => void> = {
    sync: () => handleSyncEvent(rt, ev as Extract<WebEvent, { t: 'sync' }>),
    msg: () => handleMessageEvent(rt, (ev as Extract<WebEvent, { t: 'msg' }>).msg),
    del: () => {
      trCtrl?.drop(`${rt.state.epoch}:${(ev as Extract<WebEvent, { t: 'del' }>).id}`);
      rt.cacheService.scheduleSave();
    },
    react: () => handleReactEvent(rt, ev as Extract<WebEvent, { t: 'react' }>),
    typing: () => handleTypingEvent(rt, (ev as Extract<WebEvent, { t: 'typing' }>).on),
    commands: () => cpCtrl?.setCommands((ev as Extract<WebEvent, { t: 'commands' }>).commands || []),
    status: () => stCtrl?.setStatus((ev as Extract<WebEvent, { t: 'status' }>).status),
    pending: () => stCtrl?.setPending((ev as Extract<WebEvent, { t: 'pending' }>).items || []),
    machines: () => trCtrl?.setMachines((ev as Extract<WebEvent, { t: 'machines' }>).offline || []),
    topics: () => handleTopicsEvent(rt, ev as Extract<WebEvent, { t: 'topics' }>),
    'topic-rows': () => handleTopicsEvent(rt, ev as Extract<WebEvent, { t: 'topic-rows' }>),
    resumed: () => handleResumedEvent(rt),
    bye: () => {},
  };
  handlers[ev.t]?.();
}

function wireStreamAndCache(rt: AppRuntime): void {
  const { state, boot, cacheCore } = rt;
  rt.streamClient = createStreamClient({
    getTopic: () => state.topic,
    isLoggedOut: () => rt.workbenchRoot.hidden && Boolean(rt.gateForm && !rt.gateForm.hidden),
    getBuild: () => boot.build,
    onBeforeConnect: () => {
      rt.events.emit('stream.state', { state: 'connecting' });
      state.activeEditor?.transcript?.banners.showSkeleton();
    },
    onOpen: (info) => {
      const fresh = rt.workbenchRoot.hidden || !info.quiet;
      if (rt.gateForm) rt.gateForm.hidden = true;
      if (rt.gate) rt.gate.hidden = true;
      rt.workbenchRoot.hidden = false;
      if (state.activeEditor) state.activeEditor.els.noteEl.textContent = '';
      rt.events.emit('stream.state', { state: 'open' });
      startExternalPlugins(rt);
      if (fresh && rt.shell.getMode() === 'desktop') {
        state.activeEditor?.focus?.();
      }
    },
    onReconnecting: () => {
      rt.events.emit('stream.state', { state: 'reconnecting' });
      if (state.activeEditor) state.activeEditor.els.noteEl.textContent = tr('chat.reconnecting');
    },
    onRestarting: () => {
      rt.events.emit('stream.state', { state: 'reconnecting' });
      if (state.activeEditor) state.activeEditor.els.noteEl.textContent = tr('chat.restarting');
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
    getTopic: () => state.topic,
    getEpoch: () => state.epoch,
    isSynced: () => state.synced,
    isStale: () => state.stale,
    getLastEventId: () => rt.streamClient.getLastEventId(),
    collectScreenMessages: () => {
      const log = state.activeEditor?.els.log;
      if (!log) return [];
      return collectCacheableMessages(log, state.data as Record<string, CacheMessage | undefined>);
    },
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') rt.cacheService.leave();
  });
  window.addEventListener('pagehide', () => {
    rt.cacheService.leave();
  });

  rt.readsService = createReadsService({
    getActiveTopic: () => state.topic,
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
    data: {},
    els: {},
    topics: [],
    topic: new URLSearchParams(location.search).get('t') || '',
    epoch: 0,
    synced: false,
    entering: true,
    stale: false,
    launch: null,
    launchWdSeq: 0,
    settleOnResume: false,
    enterToken: 0,
    activeEditor: null,
    insertHandler: null,
    settingsBridge: null,
    streamConnected: false,
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
        state.activeEditor?.insertIntoComposer(text);
      },
    },
    api,
    storage,
  });
  (rt as { pluginManager: PluginManager }).pluginManager = pluginManager;

  registerBuiltinPlugins(pluginManager, createDefaultBuiltinPluginFactories(buildBuiltinDeps(rt)));
  void pluginManager.activateAll().then(() => {
    const restored = shell.restoreLayout();
    shell.views.reveal('topics', { openPart: !restored && shell.getMode() === 'desktop' });
    ensureTopicEditorOpen(rt, state.topic);
    if (state.topic) {
      state.activeEditor?.composer?.loadDraftIfEmpty(state.topic);
      adoptCachedTopicMessages(rt, state.topic);
    }
    rt.streamClient.connect();
  });

  onLocaleChange((locale) => {
    applyDomI18n(document);
    events.emit('locale.change', { locale });
    state.activeEditor?.transcript?.refreshI18n();
    state.activeEditor?.composer?.onLocaleChange();
    state.activeEditor?.status?.onLocaleChange();
    state.activeEditor?.refreshHeader();
    shell.statusBarApi.refresh();
  });

  commands.register('workbench.resetLayout', () => shell.resetLayout(), { title: 'Reset Layout' });
  commands.register('workbench.toggleTerminal', () => void commands.execute(TERMINAL_TOGGLE_COMMAND));

  overlays.registerFallback(() => {
    const editor = state.activeEditor;
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

bootstrap();
