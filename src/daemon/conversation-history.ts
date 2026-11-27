import { findAgent } from '../config/schema.js';
import { buildChannelList } from '../core/channel-list.js';
import { kindForTrigger, type HistoryEvent } from '../history/record.js';
import type { HistoryMessage, HistorySessionMeta, HistoryTurnEnd, HistoryTurnRef, HistoryTurnStart } from '../history/store.js';
import type { ListChannelsResult } from '../ipc/protocol.js';
import type { ConversationId } from '../types.js';
import { expandRemoteHome } from './agent-common.js';
import {
  readCacheExpiry,
  readRemoteCacheExpiry,
  type CacheReading,
} from './claude-transcript.js';
import type { ConversationContext } from './conversation-context.js';
import { HARNESSES } from './harness/index.js';
import { remoteHosts } from './remote-hosts.js';

/**
 * The conversation library (`history.db`) as the registry feeds it, the claude transcript's cache
 * reading, and the stored channel list. Every library write is best-effort: it must never cost an answer.
 */
export class ConversationHistory {
  constructor(private readonly ctx: ConversationContext) {}

  record(id: ConversationId, event: HistoryEvent): void {
    const history = this.ctx.history;
    if (!history) return;
    try {
      const session = history.session(this.meta(id, event.kind, event.at));
      const row = historyRow(event);
      if (row) history.message(session, row);
    } catch (e) {
      console.error('[history] could not record:', e instanceof Error ? e.message : e);
    }
  }

  /** The generation is read at turn START: a `/new` mid-turn cannot relabel the turn already running. */
  beginTurn(id: ConversationId, start: HistoryTurnStart): HistoryTurnRef | undefined {
    const history = this.ctx.history;
    if (!history) return undefined;
    try {
      const session = history.session(this.meta(id, kindForTrigger(start.trigger), start.at));
      if (session === undefined) return undefined;
      const turnId = history.startTurn(session, {
        ...start,
        generation: this.ctx.store?.conversationGeneration?.(id) ?? 0,
      });
      if (turnId === undefined) return undefined;
      const seq = history.turnSeq(turnId);
      return { id: turnId, ...(seq !== undefined ? { seq } : {}) };
    } catch (e) {
      console.error('[history] could not open a turn:', e instanceof Error ? e.message : e);
      return undefined;
    }
  }

  endTurn(turnId: number | undefined, end: HistoryTurnEnd): void {
    if (turnId === undefined) return;
    try {
      this.ctx.history?.endTurn(turnId, end);
    } catch (e) {
      console.error('[history] could not close a turn:', e instanceof Error ? e.message : e);
    }
  }

  /** The number of the last turn the library has for a conversation; undefined when it cannot say. */
  lastTurnOf(key: ConversationId): number | undefined {
    try {
      return this.ctx.history?.turnRecord(key, 'last')?.turn;
    } catch {
      return undefined;
    }
  }

  /** The prompt-cache reading from a claude session's transcript, read where its Claude Code wrote it. */
  async cacheReading(id: ConversationId): Promise<CacheReading | undefined> {
    const agentId = this.ctx.agentIdOf(id);
    const def = findAgent(this.ctx.config, agentId);
    const transcript = def ? HARNESSES[def.harness].transcript : undefined;
    if (!def || !transcript?.projectsDir || !transcript?.remoteProjectsDir) return undefined;
    const sessionId = this.ctx.store?.agentSession(id, agentId);
    const cwd = this.ctx.workdirOf(id, agentId);
    if (!sessionId || !cwd) return undefined;
    const host = remoteHosts.hostFor(def);
    const w = host?.conn.welcome;
    if (host) return w ? readRemoteCacheExpiry(host, transcript.remoteProjectsDir(def, w), expandRemoteHome(cwd, w.home), sessionId) : undefined;
    return readCacheExpiry(transcript.projectsDir(def), cwd, sessionId);
  }

  /** `fleetherd channels`, read from the store so a restart does not forget every topic. */
  listChannels(opts: { platform?: string; query?: string; limit: number; currentKey?: ConversationId }): ListChannelsResult {
    const instances = new Map(Object.entries(this.ctx.config.platforms).map(([id, p]) => [id, p.type as string]));
    if (opts.platform !== undefined && !instances.has(opts.platform)) {
      throw new Error(
        `unknown platform instance "${opts.platform}"; configured: ${[...instances.keys()].join(', ')}`
      );
    }
    const sources = (this.ctx.store?.entries?.() ?? []).map(([key, rec]) => ({
      key,
      agent: rec.agent,
      ...(rec.title !== undefined ? { title: rec.title } : {}),
      ...(rec.lane !== undefined ? { lane: rec.lane } : {}),
      ...(rec.lastAt !== undefined ? { lastAt: rec.lastAt } : {}),
    }));
    const list = buildChannelList(sources, { instances, ...opts });
    return { channels: list.rows, totalTopics: list.totalTopics, limit: opts.limit };
  }

  private meta(id: ConversationId, kind: HistoryEvent['kind'], at: number): HistorySessionMeta {
    const lane = this.ctx.laneOf(id);
    const agentId = this.ctx.agentIdOf(id);
    const def = findAgent(this.ctx.config, agentId);
    return {
      key: id,
      platform: lane?.platformId ?? this.ctx.conversations.get(id)?.platform ?? '',
      title: this.ctx.store?.conversationTitle(id),
      agent: agentId,
      host: def?.host ?? '',
      cwd: this.ctx.workdirOf(id, agentId) ?? def?.cwd ?? '',
      // A conversation's kind is its first turn's; a later scheduled run is marked on its messages.
      kind,
      at,
    };
  }
}

/** One library row from a turn event: attachment names (never contents), one row per tool call. */
function historyRow(event: HistoryEvent): HistoryMessage | undefined {
  if (event.type === 'prompt') {
    const attachments = event.attachments?.filter(Boolean) ?? [];
    const text = attachments.length > 0 ? `${event.text}\n[attachments: ${attachments.join(', ')}]` : event.text;
    return text.trim() ? { ts: event.at, role: 'user', kind: event.kind, text, turn: event.turn } : undefined;
  }
  if (event.type === 'tool') {
    return {
      ts: event.at,
      role: 'tool',
      kind: event.kind,
      text: event.title,
      turn: event.turn,
      ...(event.call !== undefined ? { call: event.call } : {}),
    };
  }
  return event.text.trim()
    ? { ts: event.at, role: 'agent', kind: event.kind, text: event.text, turn: event.turn }
    : undefined;
}
