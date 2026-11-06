import path from 'node:path';
import { z } from 'zod';
import { loadConfig, resolveSocketPath, configDir, defaultSocketPath, readRawConfigIfExists } from '../config/load.js';
import { HostDefSchema, type Config } from '../config/schema.js';
import { Daemon } from '../daemon/daemon.js';
import { createPlatformAdapters } from '../platform/platform-factory.js';
import { createAcpAgentFactory } from '../daemon/agent-acp.js';
import { ConversationStore, migrateLegacySessions } from '../daemon/conversation-store.js';
import { WorkdirUsageStore } from '../daemon/workdir-usage.js';
import { ScheduleStore } from '../daemon/schedule-store.js';
import { ensureReverseCliShim } from '../daemon/reverse-cli-shim.js';
import { remoteHosts } from '../daemon/remote-hosts.js';
import { conversationKey } from '../core/conversation.js';
import { hostsWithConfiguredAgents, refreshPods } from '../daemon/pods.js';
import { backUpForRenames, readAgentRenames, renameAgentsInConfig, setRenamesAside } from '../daemon/agent-renames.js';
import { HistoryStore } from '../history/store.js';
import { importWebuiTranscripts } from '../history/import-webui.js';

/**
 * `talkcode start` — default command. Read config -> build platform adapter + agent factory -> start the daemon.
 */
export async function runStart(): Promise<void> {
  // Long-running daemon backstop: an occasional network blip (e.g. a transient
  // discord.com TLS drop while sending a reaction) shouldn't crash the whole process.
  // Log and keep running; never exit.
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason instanceof Error ? reason.stack ?? reason.message : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.stack ?? err.message);
  });

  // Agent renames first (daemon/agent-renames.ts): config.yaml has to carry the new ids before it is
  // validated, and the stores before anything reads them.
  const renames = readAgentRenames(configDir());
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (renames) {
    backUpForRenames(configDir(), stamp);
    renameAgentsInConfig(renames);
  }
  const cfg = await loadConfigReadingPods();
  const socket = resolveSocketPath(cfg);

  // Provision the reverse-CLI shim up front (agent-acp refreshes it per spawn): fail loudly at
  // startup rather than on the agent's first `talkcode` call.
  ensureReverseCliShim();

  // One adapter per configured platform instance; the daemon drives them all.
  const platforms = await createPlatformAdapters(cfg.platforms);
  // Conversation state outlives the daemon: the store remembers which agent answers each
  // conversation and, per agent, that agent's own session id (ACP session id / agy conversation id)
  // so a restart resumes it. Only /new forgets any of it.
  const store = new ConversationStore(path.join(configDir(), 'conversations.json'));
  migrateLegacy(cfg, store);
  // How often each directory has been chosen with `/cd`, so the menu leads with the projects this
  // machine actually works in. Separate from the conversation store because it is a fact about the
  // MACHINE, not about one topic — a brand-new conversation gets the benefit of it immediately.
  const workdirUsage = new WorkdirUsageStore(path.join(configDir(), 'workdir-usage.json'));
  // The host table every agent's spawn resolves against, before the factory exists. The Daemon
  // configures them again; that keeps every live connection (RemoteHosts.configure).
  remoteHosts.configure(cfg, socket);
  const agents = createAcpAgentFactory(cfg, socket, store);
  // Scheduled tasks: their own file (a task is not a property of a conversation), and a directory
  // of bash-run logs beside it. See daemon/schedule-store.ts for why that file is 0600 and atomic.
  const schedules = {
    store: new ScheduleStore(path.join(configDir(), 'schedules.json')),
    runsDir: path.join(configDir(), 'schedule-runs'),
  };
  if (renames) {
    const conversations = store.renameAgents(renames);
    const tasks = schedules.store.renameAgents(renames);
    setRenamesAside(configDir(), stamp);
    console.log(
      `[renames] ${[...renames].map(([a, b]) => `${a} → ${b}`).join(', ')}: ${conversations} conversation(s), ${tasks} scheduled task(s); backups *.bak-renames-${stamp}`
    );
  }
  const daemon = new Daemon(cfg, platforms, agents, socket, store, workdirUsage, schedules, openHistory());

  await daemon.run();
  console.log(`🚀 talkcode daemon is running (socket: ${socket})`);

  // Don't register SIGINT/SIGTERM here: installSignalHandlers inside daemon.run()
  // already handles graceful shutdown (exit codes 130/143, cleanup, re-entrancy guard).
  // A second set here would conflict (double stop / inconsistent exit codes).
}

/**
 * loadConfig, and when that fails on a gateway with hosts, read their pods and try once more.
 *
 * Routing may name an agent a pod declared (`cc@devbox`), which exists only through pods.json
 * (config/pods.ts). Without that file — a new config directory, or one somebody cleaned — the config
 * would not load, and a gateway that does not start cannot be told what is wrong from the chat. The
 * pods are read the way the daemon reads them, with the hosts as config.yaml has them.
 */
async function loadConfigReadingPods(): Promise<Config> {
  try {
    return loadConfig();
  } catch (e) {
    const raw = readRawConfigIfExists();
    const hosts = z.record(HostDefSchema).safeParse(raw?.hosts);
    if (!hosts.success || Object.keys(hosts.data).length === 0) throw e;
    console.warn(`[pods] the config did not load; reading the hosts' pods in case it names their agents`);
    remoteHosts.configure({ hosts: hosts.data }, defaultSocketPath());
    const read = await refreshPods({
      dir: configDir(),
      hostIds: remoteHosts.ids(),
      host: (id) => remoteHosts.get(id),
      configured: hostsWithConfiguredAgents(raw),
      timeoutMs: 60_000,
    });
    for (const n of read.notes) console.warn(`[pods] ${n}`);
    if (!read.changed) throw e;
    return loadConfig();
  }
}

/**
 * Carry pre-refactor `sessions.json` bindings into `conversations.json`, once.
 *
 * Dropping them would silently restart every in-flight task on upgrade, which is exactly what the
 * "an IM client must not disturb the agent's context" rule forbids. Old keys were
 * `<agentId>:<platform>:<c|t|u>:<rest>`, where a Telegram `rest` may still hold the retired
 * `<chat>:<topic>` composite — split back into channel and thread here.
 *
 * Best-effort and idempotent-ish: entries whose key no longer maps under the CURRENT scope are
 * skipped, and the legacy file is left untouched so a downgrade still finds it.
 */
function migrateLegacy(cfg: ReturnType<typeof loadConfig>, store: ConversationStore): void {
  const legacy = path.join(configDir(), 'sessions.json');
  const recovered = migrateLegacySessions(legacy, store, ({ platform, marker, rest }) => {
    // Old scope markers: c = per_channel, t = per_thread, u = per_user, plus the shared key.
    if (marker === 'shared') return conversationKey('shared', BLANK);
    if (marker === 'u') {
      return conversationKey('per_user', { ...BLANK, platform, user: rest });
    }
    // c / t both stored the channel id, with a Telegram topic possibly glued on as `<chat>:<topic>`.
    const sep = rest.indexOf(':');
    const channel = sep < 0 ? rest : rest.slice(0, sep);
    const thread = sep < 0 ? undefined : rest.slice(sep + 1) || undefined;
    const ref = {
      ...BLANK,
      platform,
      channel,
      ...(thread != null ? { thread } : {}),
      kind: thread != null ? ('thread' as const) : ('group' as const),
    };
    // Key under the scope now configured, so migrated entries are found by today's lookups.
    return conversationKey(cfg.session.scope, ref);
  });
  if (recovered > 0) {
    console.log(
      `[migrate] carried ${recovered} conversation(s) over from sessions.json — their agents resume where they left off`
    );
  }
}

/** Placeholder ref fields the key function ignores for the scope in question. */
const BLANK = { platform: '', channel: '', kind: 'group' as const, user: '' };

/**
 * The conversation library, and the one-time fold-in of what the web UI already kept.
 *
 * The import is idempotent per transcript file (`HistoryStore.importSession`), so this runs on
 * every start and only the first one does work. A library that cannot be opened is not fatal:
 * `HistoryStore` logs it once and the daemon runs without history, which is what the recording
 * path's best-effort rule already assumes.
 */
function openHistory(): HistoryStore {
  const store = new HistoryStore(path.join(configDir(), 'history.db'));
  const imported = importWebuiTranscripts(configDir(), store);
  if (imported.imported > 0) {
    console.log(
      `[history] imported ${imported.imported} web UI conversation(s), ${imported.messages} message(s)`
    );
  }
  if (imported.failed > 0) {
    console.warn(`[history] ${imported.failed} web UI transcript(s) could not be imported`);
  }
  return store;
}
