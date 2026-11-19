import fs from 'node:fs';
import path from 'node:path';
import type { ConversationAddress } from '../core/conversation.js';
import type { ConversationId } from '../types.js';

/**
 * Which coordination topics an external caller opened (`<configDir>/external-topics.json`): the
 * external MCP entrance's `tasks open` (daemon/external-mcp.ts, docs/external-mcp.md).
 *
 * It is the one record of ownership, and ownership is the whole of what a caller may act on — it
 * sees and stops only sub-tasks under topics listed here under its own name. The title is not that
 * record: a person can rename a topic, and a name can be written by anyone who can open a topic.
 *
 * Nothing else is kept. A coordination topic has no agent, no session and no turns of its own, so
 * the conversation store has no entry for it, and this file is how the gateway still knows where
 * it is after a restart. A topic deleted in the web UI is left here until a caller asks for it; the
 * daemon checks that the topic is still there before acting on it.
 *
 * 0600 and replaced in one rename, like everything beside it. A file that cannot be read starts
 * empty and says so: callers then find their old topics refused and open new ones, which is the
 * cost of losing the record — never a caller reaching a topic it did not open.
 */

export interface ExternalTopic {
  key: ConversationId;
  caller: string;
  platform: string;
  address: ConversationAddress;
  /** The topic's name as opened, for the cards and the log; the web UI's may since have changed. */
  title: string;
  openedAt: string;
}

interface ExternalTopicsFile {
  version: 1;
  topics: ExternalTopic[];
}

export class ExternalTopics {
  private readonly topics = new Map<ConversationId, ExternalTopic>();

  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void = (l) => console.warn(l)
  ) {
    for (const t of this.read()) this.topics.set(t.key, t);
  }

  get(key: ConversationId): ExternalTopic | undefined {
    return this.topics.get(key);
  }

  /** A caller's topics, newest first. */
  of(caller: string): ExternalTopic[] {
    return [...this.topics.values()].filter((t) => t.caller === caller).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }

  add(topic: ExternalTopic): void {
    this.topics.set(topic.key, topic);
    this.write();
  }

  /** Forget a topic that is gone from its platform. */
  remove(key: ConversationId): void {
    if (this.topics.delete(key)) this.write();
  }

  private read(): ExternalTopic[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<ExternalTopicsFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.topics)) {
        this.log(`[external-mcp] ${this.file} is not a version-1 topics file; starting it over`);
        return [];
      }
      return parsed.topics.filter(isTopic);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`[external-mcp] could not read ${this.file}: ${e instanceof Error ? e.message : e}`);
      }
      return [];
    }
  }

  private write(): void {
    const data: ExternalTopicsFile = { version: 1, topics: [...this.topics.values()] };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // Kept in memory for this process: the caller can go on using the topic until a restart.
      this.log(`[external-mcp] could not write ${this.file}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

function isTopic(t: unknown): t is ExternalTopic {
  if (typeof t !== 'object' || t === null) return false;
  const v = t as Record<string, unknown>;
  const a = v.address as Record<string, unknown> | undefined;
  return (
    typeof v.key === 'string' &&
    typeof v.caller === 'string' &&
    typeof v.platform === 'string' &&
    typeof v.title === 'string' &&
    typeof v.openedAt === 'string' &&
    typeof a === 'object' &&
    a !== null &&
    typeof a.channel === 'string' &&
    (a.thread === undefined || typeof a.thread === 'string')
  );
}
