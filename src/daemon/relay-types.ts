import type { RelayTransform } from '../remote/host.js';

export interface RelaySpec {
  /** Names the relay; agents with the same spec share one. A safe name (remote/paths.go safeName). */
  id: string;
  /** Where it forwards to: https, or http on loopback (a local proxy to chain to, or a test). */
  upstream: string;
  /** Responses on these paths are handed to `transform` before the agent sees them. */
  paths: readonly string[];
  transform: RelayTransform;
}

/** A harness's use of a relay: the spec, and the variable that points the harness at it. */
export interface HarnessRelay {
  envVar: string;
  spec: RelaySpec;
}
