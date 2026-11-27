import os from 'node:os';
import path from 'node:path';
import { configDir } from '../config/load.js';
import type { HostDef } from '../config/schema.js';

export function defaultIdentityFile(): string {
  return path.join(configDir(), 'ssh', 'id_ed25519');
}

export function defaultKnownHostsFile(): string {
  return path.join(configDir(), 'ssh', 'known_hosts');
}

/** The known_hosts file a host is checked against, `~` expanded. */
export function knownHostsFileOf(def: HostDef): string {
  return expandLocalHome(def.knownHostsFile ?? defaultKnownHostsFile());
}

export function expandLocalHome(p: string): string {
  if (p === '~') return os.homedir();
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}
