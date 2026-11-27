// Platform adapter factory: pick the profile by the instance's `type`, then assemble
// with the generic satori-core.
//
// Multi-platform base: generic Satori core (satori-core.ts) + pluggable PlatformProfile seam
// (profile.ts) + per-platform profiles (profiles/*.ts). Adding an IM platform needs one
// profile file + its config schema in config/platform-schemas.ts, reusing all of core.
import type { PlatformAdapter } from './adapter.js';
import type { PlatformProfile } from './profile.js';
import type { PlatformInstance, PlatformType } from '../config/platform-schemas.js';
import { createSatoriAdapter } from './satori-core.js';
import { createDiscordProfile } from './profiles/discord.js';
import { createTelegramProfile } from './profiles/telegram.js';
import { createSlackProfile } from './profiles/slack.js';
import { createLarkProfile } from './profiles/lark.js';
import { createQQProfile } from './profiles/qq.js';
import { createLineProfile } from './profiles/line.js';
import { createWecomProfile } from './profiles/wecom.js';
import { createDingtalkProfile } from './profiles/dingtalk.js';
import { createWebuiAdapter, type WebuiAdapterOptions } from './webui/index.js';

export type PlatformAdapterOptions = WebuiAdapterOptions;

/**
 * Platform type → profile factory. Adding a Satori platform = one line here + a schema in
 * config/platform-schemas.ts.
 *
 * `webui` is excluded because it has no profile: it is not a Satori adapter at all (see
 * webui/index.ts for why) and is dispatched separately below. The `Exclude` rather than a
 * loosened type is what keeps this map exhaustive — the next Satori platform still fails to
 * compile until it is listed here. Each factory returns a profile typed to its own config; the map
 * widens to PlatformProfile (method-bivariance) — safe because dispatch below always
 * hands a profile the instance whose `type` selected it.
 */
const PROFILES: Record<Exclude<PlatformType, 'webui'>, () => PlatformProfile> = {
  discord: createDiscordProfile,
  telegram: createTelegramProfile,
  slack: createSlackProfile,
  lark: createLarkProfile,
  qq: createQQProfile,
  line: createLineProfile,
  wecom: createWecomProfile,
  dingtalk: createDingtalkProfile,
};

/**
 * Build a platform adapter from one platform instance (a `platforms.<id>` entry + its id):
 * pick profile by type → hand to the generic Satori core to assemble. The schema's
 * discriminated union guarantees `type` is implemented, so no unknown-type branch remains.
 */
export async function createPlatformAdapter(
  instance: PlatformInstance,
  opts?: PlatformAdapterOptions
): Promise<PlatformAdapter> {
  // The one platform that is not a chat app. It implements PlatformAdapter directly rather
  // than going through the profile seam, for the reasons in webui/index.ts — the daemon only
  // ever sees PlatformAdapter, so nothing downstream can tell the difference.
  if (instance.type === 'webui') return createWebuiAdapter(instance, opts);
  return createSatoriAdapter(PROFILES[instance.type](), instance);
}

/**
 * Build one adapter per configured platform instance, keyed by instance id — the map the
 * daemon runs. Each instance gets its own Satori Context (own gateway connection, own
 * webhook server ports where applicable), so instances are fully isolated.
 */
export async function createPlatformAdapters(
  platforms: Record<string, Omit<PlatformInstance, 'id'>>,
  opts?: PlatformAdapterOptions
): Promise<Map<string, PlatformAdapter>> {
  const out = new Map<string, PlatformAdapter>();
  for (const [id, p] of Object.entries(platforms)) {
    out.set(id, await createPlatformAdapter({ id, ...p } as PlatformInstance, opts));
  }
  return out;
}
