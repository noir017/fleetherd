import path from 'node:path';
import { findAgent } from '../config/schema.js';
import {
  conversationKey,
  formatAddress,
  formatTarget,
  parseTarget,
  type ConversationAddress,
} from '../core/conversation.js';
import { DEFAULT_LIST_LIMIT, DEFAULT_SEARCH_LIMIT, type HistoryStore } from '../history/store.js';
import type { IpcAction, VoiceLogResult } from '../ipc/protocol.js';
import {
  DEFAULT_ASK_TIMEOUT_MS as PROTOCOL_DEFAULT_ASK_TIMEOUT_MS,
  DEFAULT_CHANNEL_LIMIT,
} from '../ipc/protocol.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { ConversationId } from '../types.js';
import { sendBytesAsFile } from './agent-files.js';
import { RELOAD_POD_TIMEOUT_MS, type DaemonContext } from './daemon-context.js';
import { skillHarnessOf } from './managed-skills.js';
import { addPod, gatewayKeyLine, removePod } from './pod-admin.js';
import { leaveMesh } from './pod-peers.js';
import { remoteHosts } from './remote-hosts.js';
import type { ScheduleService } from './schedule-service.js';
import type { LibraryAsker } from './skill-library.js';
import {
  archiveSkill,
  createSkill,
  listSkills,
  patchSkill,
  pinSkill,
  removeSkillFile,
  restoreSkill,
  revertSkill,
  skillHistory,
  writeSkillFile,
  type SkillChangeBy,
} from './skills-store.js';

const DEFAULT_VOICE_LOG_LIMIT = 10;
const DEFAULT_ASK_TIMEOUT_MS = PROTOCOL_DEFAULT_ASK_TIMEOUT_MS;

const GATEWAY_QUERY_KINDS = {
  'voice-log': true,
  'list-channels': true,
  'schedule-add': true,
  'schedule-edit': true,
  'schedule-list': true,
  'schedule-op': true,
  'reload-config': true,
  'pod-list': true,
  'pod-add': true,
  'pod-remove': true,
  skills: true,
} as const satisfies Partial<Record<IpcAction['kind'], true>>;
export type GatewayQuery = Extract<IpcAction, { kind: keyof typeof GATEWAY_QUERY_KINDS }>;
const isGatewayQuery = (a: IpcAction): a is GatewayQuery => a.kind in GATEWAY_QUERY_KINDS;

/**
 * Chat actions that write into the conversation they name. A coordination topic an external
 * caller opened refuses all of them (AGENTS.md security invariant 11).
 */
export const COORDINATION_WRITE_ACTIONS: ReadonlySet<IpcAction['kind']> = new Set([
  'send-message',
  'reply',
  'edit-message',
  'send-file',
  'react',
  'delete',
  'create-thread',
  'ask',
]);

const SESSIONS_QUERY_KINDS = {
  'sessions-search': true,
  'sessions-read': true,
  'sessions-list': true,
} as const satisfies Partial<Record<IpcAction['kind'], true>>;
export type SessionsQuery = Extract<IpcAction, { kind: keyof typeof SESSIONS_QUERY_KINDS }>;
const isSessionsQuery = (a: IpcAction): a is SessionsQuery => a.kind in SESSIONS_QUERY_KINDS;

type TaskAction = Extract<IpcAction, { kind: `task-${string}` }>;
const isTaskAction = (a: IpcAction): a is TaskAction => a.kind.startsWith('task-');

const SKILL_READS = ['list', 'search', 'categories', 'show', 'history'] as const;
type SkillRead = (typeof SKILL_READS)[number];

function isSkillRead(action: Extract<IpcAction, { kind: 'skills' }>['action']): action is SkillRead {
  return (SKILL_READS as readonly string[]).includes(action);
}

/** Reverse-command dispatch and grouped IPC handlers (chat actions, gateway queries, schedules, sessions, skills). */
export class DaemonReverse {
  /**
   * Scratch slots written synchronously by IpcServer.resolveAddress and read before the first
   * await in handleReverse. Safe only because no await sits between resolveAddress and handle.
   */
  private lastResolvedConversationId: ConversationId | undefined;
  private lastResolvedPlatform: string | undefined;

  constructor(private readonly ctx: DaemonContext) {}

  setResolved(conversationId: ConversationId | undefined, platform: string | undefined): void {
    this.lastResolvedConversationId = conversationId;
    this.lastResolvedPlatform = platform;
  }

  private reverseAdapter(): { id: string; adapter: PlatformAdapter } {
    const id = this.lastResolvedConversationId;
    const pid = this.lastResolvedPlatform ?? (id ? this.ctx.registry.platformFor(id) : undefined);
    if (!pid) throw new Error('cannot resolve the platform instance for this reverse command (conversation expired?)');
    const adapter = this.ctx.platforms.get(pid);
    if (!adapter) throw new Error(`platform instance "${pid}" is not running`);
    return { id: pid, adapter };
  }

  /** Refuse agent writes into an external caller's coordination topic (security invariant 11). */
  private assertAgentMayWrite(platformId: string | undefined, address: ConversationAddress, action: IpcAction): void {
    if (!platformId || !COORDINATION_WRITE_ACTIONS.has(action.kind)) return;
    if (this.ctx.externalTopics.get(platformId, address)) {
      throw new Error(
        `"${formatTarget(platformId, address)}" is a coordination topic an external caller opened; an agent cannot write there — only the gateway posts its updates and answers there`
      );
    }
  }

  private async sendAgentFile(
    conversation: ConversationId | undefined,
    platform: PlatformAdapter,
    address: ConversationAddress,
    action: Extract<IpcAction, { kind: 'send-file' }>
  ): Promise<unknown> {
    const agentId = conversation
      ? (this.ctx.registry.boundAgentOf(conversation) ?? this.ctx.config.routing.default)
      : undefined;
    const host = remoteHosts.hostFor(agentId ? findAgent(this.ctx.config, agentId) : undefined);
    if (!host) return platform.sendFile(address, { path: action.path, name: action.name, caption: action.caption });
    const base = path.posix.basename(action.path) || 'file';
    const data = await host.readFile(action.path, this.ctx.config.attachments.maxDownloadBytes);
    console.log(`[remote] ${host.id}: fetched ${action.path} (${data.length} bytes) to send`);
    return sendBytesAsFile(platform, address, data, { fileName: base, name: action.name, caption: action.caption });
  }

  async handleReverse(action: IpcAction, address: ConversationAddress): Promise<unknown> {
    // Resolve BEFORE any await: the scratch slots are only synchronously valid.
    const { id: platformId, adapter: platform } = this.reverseAdapter();
    const conversation = this.lastResolvedConversationId;
    if (this.lastResolvedConversationId) this.ctx.registry.touch(this.lastResolvedConversationId);
    if (isTaskAction(action)) return this.ctx.delegation.handle(conversation, action);
    if (isSessionsQuery(action)) return this.handleSessionsQuery(action);
    if (isGatewayQuery(action)) return this.handleGatewayQuery(action, address);
    this.assertAgentMayWrite(platformId, address, action);
    switch (action.kind) {
      case 'send-message':
        return platform.sendMessage(address, action.text);
      case 'reply':
        if (!platform.capabilities.reply) {
          return platform.sendMessage(address, action.text);
        }
        return platform.replyMessage({ address, messageId: action.messageId }, action.text);
      case 'edit-message':
        if (!platform.capabilities.editMessage) {
          throw new Error('unsupported operation: this platform does not support editing messages');
        }
        return platform.editMessage({ address, messageId: action.messageId }, action.text);
      case 'send-file':
        return this.sendAgentFile(conversation, platform, address, action);
      case 'react':
        return platform.addReaction({ address, messageId: action.messageId }, action.emoji);
      case 'delete':
        return platform.deleteMessage({ address, messageId: action.messageId });
      case 'fetch-messages':
        return {
          messages: await platform.fetchHistory(address, {
            limit: action.limit,
            before: action.before,
          }),
        };
      case 'create-thread':
        if (!platform.capabilities.thread) {
          throw new Error('unsupported operation: this platform does not support creating threads');
        }
        return {
          threadId: formatAddress(
            (await platform.createThread({ address, messageId: action.messageId }, action.name)).address
          ),
        };
      case 'ask':
        if (!platform.capabilities.buttons) {
          throw new Error('unsupported operation: this platform does not support interactive buttons (ask)');
        }
        return this.handleAsk(platform, action, address);
      default: {
        const _exhaustive: never = action;
        throw new Error(`unknown reverse command: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  async handleGatewayQuery(action: GatewayQuery, address: ConversationAddress): Promise<unknown> {
    const id = this.lastResolvedConversationId;
    switch (action.kind) {
      case 'voice-log': {
        const result: VoiceLogResult = {
          enabled: this.ctx.config.voice !== undefined,
          entries: id ? this.ctx.voice.history(id, action.limit ?? DEFAULT_VOICE_LOG_LIMIT) : [],
        };
        return result;
      }
      case 'list-channels':
        return this.ctx.registry.listChannels({
          platform: action.platform,
          query: action.query,
          limit: action.limit ?? DEFAULT_CHANNEL_LIMIT,
          currentKey: id,
        });
      case 'schedule-add':
      case 'schedule-edit':
      case 'schedule-list':
      case 'schedule-op':
        return this.handleScheduleQuery(action, address, id);
      case 'reload-config':
        return this.ctx.reloadAll().then((reload) => {
          if (!reload.ok) throw new Error(reload.summary);
          return reload;
        });
      case 'pod-list':
        return this.ctx.podList();
      case 'pod-add':
        addPod(action.name, action.ssh, action.hostKey);
        return this.ctx.reloadAll().then((r) => ({
          summary: [
            `Added ${action.name} (${action.ssh}); its host key is pinned in the gateway's known_hosts.`,
            `If it was not reached below, put this line in ~/.ssh/authorized_keys on ${action.name}, then \`fleetherd reload\`:`,
            gatewayKeyLine(),
            r.summary,
          ].join('\n'),
        }));
      case 'pod-remove': {
        removePod(action.name);
        const leaving = remoteHosts.get(action.name);
        return (leaving ? leaveMesh(leaving, RELOAD_POD_TIMEOUT_MS) : Promise.resolve(undefined))
          .then(async (note) => ({ note, reload: await this.ctx.reloadAll() }))
          .then(({ note, reload }) => ({
            summary: [`Removed ${action.name}.`, ...(note ? [`⚠️ ${note}`] : []), reload.summary].join('\n'),
          }));
      }
      case 'skills':
        return this.handleSkills(action, id, address);
      default: {
        const _exhaustive: never = action;
        throw new Error(`unknown gateway query: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  private async handleScheduleQuery(
    action: Extract<GatewayQuery, { kind: 'schedule-add' | 'schedule-edit' | 'schedule-list' | 'schedule-op' }>,
    address: ConversationAddress,
    caller: ConversationId | undefined
  ): Promise<unknown> {
    const schedules = this.requireSchedules();
    switch (action.kind) {
      case 'schedule-add': {
        if (!caller) throw new Error('cannot tell which conversation this came from (conversation expired?)');
        const platform = this.lastResolvedPlatform ?? this.ctx.registry.platformFor(caller);
        if (!platform) throw new Error('cannot resolve the platform for this conversation');
        const { kind: _kind, channelId: _channel, ...input } = action;
        return { task: await schedules.add(input, caller, { platform, address }) };
      }
      case 'schedule-edit': {
        if (!caller) throw new Error('cannot tell which conversation this came from (conversation expired?)');
        const { kind: _kind, id: taskId, channelId, ...input } = action;
        if (channelId === undefined) return { task: await schedules.edit(taskId, input, caller) };
        const platform = this.lastResolvedPlatform ?? this.ctx.registry.platformFor(caller);
        if (!platform) throw new Error('cannot resolve the platform for this conversation');
        return { task: await schedules.edit(taskId, input, caller, { platform, address }) };
      }
      case 'schedule-list':
        return schedules.list(caller, action.id);
      case 'schedule-op':
        if (action.op === 'run' && action.waitMs !== undefined) return schedules.runTask(action.id, caller, action.waitMs);
        return { task: schedules.op(action.id, action.op, caller) };
      default: {
        const _exhaustive: never = action;
        throw new Error(`unknown schedule query: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  handleSessionsQuery(action: SessionsQuery): unknown {
    switch (action.kind) {
      case 'sessions-search': {
        const history = this.requireHistory();
        const hits = history.search(action.query, {
          agent: action.agent,
          days: action.days,
          limit: action.limit,
          tools: action.tools,
        });
        return {
          hits,
          limit: action.limit ?? DEFAULT_SEARCH_LIMIT,
          ...(action.agent !== undefined && hits.length === 0 ? { agents: history.agents() } : {}),
        };
      }
      case 'sessions-read':
        return this.requireHistory().read(this.sessionRef(action.session), {
          around: action.around,
          window: action.window,
          role: action.role,
          turn: action.turn,
          turns: action.turns,
          since: action.since,
          grep: action.grep,
          tail: action.tail,
          limit: action.limit,
          current: (key) => {
            const agent = this.ctx.store?.boundAgent(key);
            if (!agent) return undefined;
            return { agent, generation: this.ctx.store?.conversationGeneration(key) ?? 0 };
          },
        });
      case 'sessions-list':
        return {
          sessions: this.requireHistory().list({
            days: action.days,
            limit: action.limit,
            beforeId: action.before,
          }),
          days: action.days ?? 7,
          limit: action.limit ?? DEFAULT_LIST_LIMIT,
        };
      default: {
        const _exhaustive: never = action;
        throw new Error(`unknown sessions query: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  private sessionRef(ref: string): string {
    if (/^#?\d+$/.test(ref)) return ref;
    const target = parseTarget(ref, new Set(Object.keys(this.ctx.config.platforms)));
    if (!target.platform) return ref;
    const base = {
      platform: target.platform,
      channel: target.address.channel,
      thread: target.address.thread,
      kind: 'thread' as const,
      user: '',
    };
    const keys = target.address.thread
      ? [conversationKey('per_thread', base)]
      : [conversationKey('per_thread', base), conversationKey('per_channel', base)];
    return keys.find((key) => this.ctx.history?.sessionOf(key)) ?? ref;
  }

  private skillAsker(conversationId: ConversationId | undefined): LibraryAsker {
    const agent = conversationId
      ? (this.ctx.registry.boundAgentOf(conversationId) ?? this.ctx.config.routing.default)
      : this.ctx.config.routing.default;
    const def = findAgent(this.ctx.config, agent);
    return {
      agent,
      host: def?.host ?? 'local',
      harness: def ? skillHarnessOf(def) : 'claude',
      ...(conversationId
        ? { conversation: conversationId, generation: this.ctx.store?.conversationGeneration(conversationId) ?? 0 }
        : {}),
    };
  }

  private skillChangeBy(conversationId: ConversationId | undefined): SkillChangeBy {
    if (!conversationId) return { kind: 'agent' };
    const agent = this.ctx.registry.boundAgentOf(conversationId) ?? this.ctx.config.routing.default;
    return { kind: 'agent', agent, conversation: conversationId };
  }

  private async handleSkills(
    action: Extract<IpcAction, { kind: 'skills' }>,
    conversationId: ConversationId | undefined,
    address: ConversationAddress
  ): Promise<unknown> {
    const need = (value: string | undefined, what: string): string => {
      if (value === undefined || value === '') throw new Error(`skills ${action.action} needs ${what}`);
      return value;
    };
    const name = (): string => need(action.name, 'a <name>');
    const by = this.skillChangeBy(conversationId);
    const write = <T>(fn: () => T): Promise<T> => this.ctx.skillsRepo.write(fn);
    if (isSkillRead(action.action)) return this.readSkills(action.action, action, conversationId);
    switch (action.action) {
      case 'create': {
        const source = conversationId
          ? {
              conversation: conversationId,
              platform: this.lastResolvedPlatform ?? this.ctx.registry.platformFor(conversationId),
              address,
              agent: by.agent ?? this.ctx.config.routing.default,
            }
          : undefined;
        return write(() => createSkill({ name: name(), description: action.description ?? '', body: action.body, source, by }));
      }
      case 'patch':
        return write(() =>
          patchSkill({ name: name(), version: need(action.version, '--version'), content: need(action.content, '--content'), by })
        );
      case 'write-file': {
        const content = action.content;
        if (content === undefined) throw new Error('skills write-file needs --content');
        return write(() => writeSkillFile({ name: name(), file: need(action.file, 'a <file>'), content, by }));
      }
      case 'remove-file':
        return write(() => removeSkillFile({ name: name(), file: need(action.file, 'a <file>'), by }));
      case 'archive': {
        const record = await write(() => archiveSkill(name(), undefined, Date.now(), by));
        this.ctx.notifySkillArchived(record, 'manual');
        return record;
      }
      case 'restore':
        return write(() => restoreSkill(name(), undefined, Date.now(), by));
      case 'pin':
        return pinSkill(name(), true);
      case 'unpin':
        return pinSkill(name(), false);
      case 'revert':
        return write(() => revertSkill(name(), need(action.id, 'a history <id>'), undefined, Date.now(), by));
      default: {
        const _exhaustive: never = action.action;
        throw new Error(`unknown skills action: ${_exhaustive}`);
      }
    }
  }

  private readSkills(
    read: SkillRead,
    action: Extract<IpcAction, { kind: 'skills' }>,
    conversationId: ConversationId | undefined
  ): unknown {
    const name = (): string => {
      if (!action.name) throw new Error(`skills ${read} needs a <name>`);
      return action.name;
    };
    switch (read) {
      case 'list':
        return { skills: listSkills() };
      case 'search':
        if (!action.query) throw new Error('skills search needs what you are looking for');
        return this.ctx.skillLibrary.search(action.query, this.skillAsker(conversationId));
      case 'categories':
        return this.ctx.skillLibrary.categories(this.skillAsker(conversationId));
      case 'show':
        return this.ctx.skillLibrary.show(name(), action.file, this.skillAsker(conversationId), action.again === true);
      case 'history':
        return { history: skillHistory(name()) };
      default: {
        const _exhaustive: never = read;
        throw new Error(`unknown skills read: ${_exhaustive}`);
      }
    }
  }

  private async handleAsk(
    platform: PlatformAdapter,
    action: Extract<IpcAction, { kind: 'ask' }>,
    address: ConversationAddress
  ): Promise<{ chosen: string | null }> {
    const labels = action.options;
    const conversationId = this.lastResolvedConversationId;
    if (labels.length === 0) {
      return { chosen: null };
    }
    const chosen = await this.ctx.askButtons(
      platform,
      address,
      action.prompt,
      labels,
      action.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
      conversationId
    );
    return {
      chosen:
        chosen === null || chosen.kind === 'timeout'
          ? null
          : chosen.kind === 'option'
            ? chosen.labels.join(', ')
            : chosen.text,
    };
  }

  private requireSchedules(): ScheduleService {
    if (!this.ctx.schedules) throw new Error('scheduled tasks are not enabled in this daemon');
    return this.ctx.schedules;
  }

  private requireHistory(): HistoryStore {
    if (!this.ctx.history) throw new Error('the conversation history is not enabled in this daemon');
    return this.ctx.history;
  }
}
