import fs from 'node:fs';
import path from 'node:path';
import type { ConversationId } from '../types.js';

/** One git worktree created by `task-new --worktree`, persisted for automatic cleanup and `tasks`. */
export interface ManagedWorktree {
  topicKey: ConversationId;
  /** Display topic id (`web:main/3a9f0c12`). */
  topic: string;
  agent: string;
  /** Remote host id, or undefined when the agent runs on the gateway machine. */
  host?: string;
  repoRoot: string;
  path: string;
  name: string;
  branch: string;
  /** Branch HEAD was on when the worktree was created; absent if detached HEAD. */
  baseBranch?: string;
  baseSha: string;
  createdAt: number;
  /** Epoch ms when the topic's last turn ended (persisted so the 1h cleanup window survives restarts). */
  lastEndedAt?: number;
}

interface WorktreesFile {
  version: 1;
  worktrees: ManagedWorktree[];
}

const VERSION = 1;

export class WorktreeStore {
  private readonly items = new Map<ConversationId, ManagedWorktree>();

  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void = (l) => console.warn(l)
  ) {
    for (const wt of this.read()) this.items.set(wt.topicKey, wt);
  }

  get(topicKey: ConversationId): ManagedWorktree | undefined {
    return this.items.get(topicKey);
  }

  all(): ManagedWorktree[] {
    return [...this.items.values()];
  }

  set(wt: ManagedWorktree): void {
    this.items.set(wt.topicKey, { ...wt });
    this.write();
  }

  touchEnded(topicKey: ConversationId, at: number): void {
    const wt = this.items.get(topicKey);
    if (!wt || wt.lastEndedAt === at) return;
    wt.lastEndedAt = at;
    this.write();
  }

  remove(topicKey: ConversationId): boolean {
    if (!this.items.delete(topicKey)) return false;
    this.write();
    return true;
  }

  private read(): ManagedWorktree[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { version?: unknown; worktrees?: unknown };
      if (!Array.isArray(parsed.worktrees)) {
        this.log(`[delegation] ${this.file} has no worktrees list; starting empty`);
        return [];
      }
      return parsed.worktrees.filter(isManagedWorktree);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`[delegation] could not read ${this.file}: ${e instanceof Error ? e.message : e}`);
      }
      return [];
    }
  }

  private write(): void {
    const data: WorktreesFile = { version: VERSION, worktrees: [...this.items.values()] };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log(`[delegation] could not write ${this.file}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

function isManagedWorktree(v: unknown): v is ManagedWorktree {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.topicKey === 'string' &&
    typeof r.topic === 'string' &&
    typeof r.agent === 'string' &&
    (r.host === undefined || typeof r.host === 'string') &&
    typeof r.repoRoot === 'string' &&
    typeof r.path === 'string' &&
    typeof r.name === 'string' &&
    typeof r.branch === 'string' &&
    (r.baseBranch === undefined || typeof r.baseBranch === 'string') &&
    typeof r.baseSha === 'string' &&
    typeof r.createdAt === 'number' &&
    (r.lastEndedAt === undefined || typeof r.lastEndedAt === 'number')
  );
}
