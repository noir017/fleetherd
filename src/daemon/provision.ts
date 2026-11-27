import type { AgentDef } from '../config/schema.js';
import type { Welcome } from '../remote/connection.js';

export interface HostLinkResult {
  outcome: string;
  detail?: string;
  link: string;
}

/** Narrow port on RemoteHost covering the file and link operations agent provisions use. */
export interface HostFiles {
  readonly id: string;
  writeFile: (path: string, data: Uint8Array, mode?: number, opts?: { atomic?: boolean }) => Promise<void>;
  ensureLink: (target: string, link: string, requires: string, owned?: string) => Promise<HostLinkResult>;
  removeLink: (link: string, owned: string) => Promise<HostLinkResult>;
  sweepSkillLinks: (dir: string) => Promise<string[]>;
  listFiles: (path: string, timeoutMs?: number) => Promise<string[]>;
  removePath: (path: string, owned: string) => Promise<{ removed: boolean; path: string }>;
}

/** Something delivered to an agent's machine at spawn time (locally or over SSH). */
export interface AgentProvision<TLocal = unknown, TRemote = unknown> {
  readonly name: string;
  local: (def: AgentDef, home: string) => TLocal;
  remote: (host: HostFiles, def: AgentDef, home: string, w: Welcome) => Promise<TRemote>;
}
