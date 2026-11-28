import type { Stream } from '@agentclientprotocol/sdk';

type Message = Stream['readable'] extends ReadableStream<infer M> ? M : never;

/** The AIR capability that makes claude-agent-acp report each subagent's life on its own. */
export const NATIVE_SUBAGENT_SESSIONS = 'nativeSubagentSessions';

/** Where the relay leaves what it knows on the updates it passes on; read by `readSubagentStamp`. */
const STAMP_KEY = 'fleetherd/subagent';

/** How a subagent ended, as the adapter says it (`nativeSubagentState`, claude-agent-acp 0.81). */
export type SubagentEndState = 'completed' | 'failed' | 'cancelled' | 'disconnected';

export interface SubagentStamp {
  /** The subagent's name, on every update the relay moved out of its session. */
  name?: string;
  /** On the end record: the call that started the subagent (its card's key) and how it ended. */
  ended?: { parent: string; state: SubagentEndState };
}

/** Sessions remembered at once; one per subagent, so the oldest are long finished. */
const MAX_CHILDREN = 256;

interface Child {
  /** The session that spawned it: the conversation's own, or another subagent's. */
  spawner: string;
  name?: string;
  /** The Agent/Task call that started it, learned from its first update. */
  call?: string;
}

/**
 * claude-agent-acp's native subagent sessions (AIR `nativeSubagentSessions`), folded back into what
 * the gateway already reads: a subagent's updates return to the conversation's session stamped with
 * its name, and its end becomes a stamped `session_info_update` (daemon README, Native subagent
 * sessions).
 *
 * ⚠️ HYRUM'S LAW: a draft extension the SDK's schema does not know (ACP PR #1992). Shapes recorded
 * 2026-11-28 by project-scripts/fleetherd-subagent-end/probe.mjs and replayed in the test.
 */
export class NativeSubagentRelay {
  private readonly children = new Map<string, Child>();

  /** One inbound message as it should reach the SDK, or undefined to drop it. */
  inbound(msg: Message): Message | undefined {
    if (!('method' in msg) || !isRecord(msg.params)) return msg;
    const params = msg.params;
    const sid = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    if (sid === undefined) return msg;
    const update = isRecord(params.update) ? params.update : undefined;
    if (msg.method !== 'session/update' || !update) {
      // A subagent's permission request or question names its own session: it is the conversation's.
      return this.children.has(sid) ? { ...msg, params: { ...params, sessionId: this.owner(sid) } } : msg;
    }
    if (update.sessionUpdate === 'subagent_spawned') {
      this.spawned(sid, update);
      return undefined;
    }
    if (update.sessionUpdate === 'subagent_state_update') return this.ended(msg, sid, update);
    const child = this.children.get(sid);
    if (!child) return msg;
    child.call ??= parentToolUseId(update._meta);
    const stamp: SubagentStamp = child.name ? { name: child.name } : {};
    const meta = { ...(isRecord(update._meta) ? update._meta : {}), [STAMP_KEY]: stamp };
    return { ...msg, params: { ...params, sessionId: this.owner(sid), update: { ...update, _meta: meta } } };
  }

  private spawned(spawner: string, update: Record<string, unknown>): void {
    const id = update.subagentSessionId;
    if (typeof id !== 'string' || id === '') return;
    if (!this.children.has(id) && this.children.size >= MAX_CHILDREN) {
      const oldest = this.children.keys().next().value;
      if (oldest !== undefined) this.children.delete(oldest);
    }
    const name = typeof update.name === 'string' && update.name.trim() ? update.name.trim() : undefined;
    this.children.set(id, { spawner, ...(name ? { name } : {}) });
  }

  private ended(msg: Message, sid: string, update: Record<string, unknown>): Message | undefined {
    const id = update.subagentSessionId;
    const child = typeof id === 'string' ? this.children.get(id) : undefined;
    const state = endState(update.state);
    // A subagent that never ran a tool has no card to end.
    if (!child?.call || !state || !('method' in msg)) return undefined;
    const stamp: SubagentStamp = { ...(child.name ? { name: child.name } : {}), ended: { parent: child.call, state } };
    return {
      jsonrpc: '2.0',
      method: msg.method,
      params: { sessionId: this.owner(sid), update: { sessionUpdate: 'session_info_update', _meta: { [STAMP_KEY]: stamp } } },
    };
  }

  /** The session a subagent's work belongs to: up the spawners to one that is not a subagent's. */
  private owner(sid: string): string {
    let at = sid;
    for (let hops = 0; hops < 16; hops++) {
      const up = this.children.get(at);
      if (!up) return at;
      at = up.spawner;
    }
    return at;
  }
}

/** The stream an ACP connection reads, with native subagent sessions folded back in (see the relay). */
export function relayNativeSubagents(stream: Stream): Stream {
  const relay = new NativeSubagentRelay();
  const readable = stream.readable.pipeThrough(
    new TransformStream<Message, Message>({
      transform(msg, out) {
        const passed = relay.inbound(msg);
        if (passed !== undefined) out.enqueue(passed);
      },
    })
  );
  return { writable: stream.writable, readable };
}

/** What the relay stamped on an update, if anything. Wire-shaped data, so every field is checked. */
export function readSubagentStamp(meta: unknown): SubagentStamp | undefined {
  const s = isRecord(meta) ? meta[STAMP_KEY] : undefined;
  if (!isRecord(s)) return undefined;
  const name = typeof s.name === 'string' && s.name ? s.name : undefined;
  const e = isRecord(s.ended) ? s.ended : undefined;
  const state = e ? endState(e.state) : undefined;
  const ended = e && typeof e.parent === 'string' && e.parent && state ? { parent: e.parent, state } : undefined;
  return { ...(name ? { name } : {}), ...(ended ? { ended } : {}) };
}

function endState(v: unknown): SubagentEndState | undefined {
  return v === 'completed' || v === 'failed' || v === 'cancelled' || v === 'disconnected' ? v : undefined;
}

function parentToolUseId(meta: unknown): string | undefined {
  const cc = isRecord(meta) && isRecord(meta.claudeCode) ? meta.claudeCode : undefined;
  return typeof cc?.parentToolUseId === 'string' && cc.parentToolUseId ? cc.parentToolUseId : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
