import type { RelayHeaderObserver, RelayTransform } from '../remote/host.js';

export interface RelaySpec {
  /** Names the relay; agents with the same spec share one. A safe name (remote/paths.go safeName). */
  id: string;
  /** Where it forwards to: https, or http on loopback (a local proxy to chain to, or a test). */
  upstream: string;
  /** Responses on these paths are handed to `transform` before the agent sees them. */
  paths: readonly string[];
  transform: RelayTransform;
  /** Lower-cased upstream response header names to observe and report per session tag. */
  observeHeaders?: readonly string[];
  /** Called whenever a tagged request receives any of `observeHeaders`. */
  onHeaders?: RelayHeaderObserver;
}

/** A harness's use of a relay: the spec, and the variable that points the harness at it. */
export interface HarnessRelay {
  envVar: string;
  spec: RelaySpec;
}
