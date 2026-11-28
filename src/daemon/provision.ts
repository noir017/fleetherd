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

/** Fields a provision may contribute to `_meta.fleetherd` for connect agents (excludes host/token/topic). */
export interface ProvisionMeta {
  instructions?: string;
  skills?: Array<{ name: string; description: string }>;
}

/** Something delivered to an agent at spawn time (locally, over SSH, or via connect `_meta`). */
export interface AgentProvision<TLocal = unknown, TRemote = unknown> {
  readonly name: string;
  /** It delivers skills, which a private agent is never given (`provisionsFor`). */
  readonly skills?: true;
  local: (def: AgentDef, home: string) => TLocal;
  remote: (host: HostFiles, def: AgentDef, home: string, w: Welcome) => Promise<TRemote>;
  /** Fields contributed to `_meta.fleetherd` for connect agents that cannot receive files. */
  meta?: (def: AgentDef) => ProvisionMeta | undefined;
}

/** What `def` is given at spawn: every provision, less those carrying skills for a private agent. */
export function provisionsFor(def: AgentDef, all: readonly AgentProvision[]): readonly AgentProvision[] {
  return def.private ? all.filter((p) => !p.skills) : all;
}
