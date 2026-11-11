/**
 * v0 → v1 config migration.
 *
 * v0: single `platform:` object — discord fields on the top level, other platforms'
 * credentials in the untyped `options` pocket, lark/qq forced to carry a placeholder
 * `token` (schema required it), gating frozen in code.
 * v1: `platforms:` map of typed instances (see platform/config-schemas.ts) + `version: 1`.
 *
 * loadConfig migrates IN MEMORY (with a one-line warning) so old files keep working;
 * `fleetherd doctor --migrate-config` rewrites the file. This module is deliberately
 * self-contained and disposable — it will be deleted one major version after v1 lands
 * (the hermes-agent lesson: alias/migration layers that never die grow into a swamp).
 */

type Raw = Record<string, unknown>;

const asObj = (v: unknown): Raw => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});
const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** A v0 file has the singular `platform:` object and no `platforms:` map. */
export function isLegacyConfig(raw: unknown): boolean {
  const o = asObj(raw);
  return 'platform' in o && !('platforms' in o);
}

export interface MigrationResult {
  /** The migrated raw config (v1 shape, unvalidated — caller runs it through ConfigSchema). */
  config: Raw;
  /** Human-readable notes: renames applied, placeholder tokens dropped, unknown option keys discarded. */
  notes: string[];
}

/** Set `key` on `out` if the value is defined (keeps the migrated file as slim as the source). */
function setIf(out: Raw, key: string, value: unknown): void {
  if (value !== undefined) out[key] = value;
}

/** Migrate a v0 raw config object to v1. Caller must have checked isLegacyConfig. */
export function migrateLegacyConfig(raw: Raw): MigrationResult {
  const notes: string[] = [];
  const p = asObj(raw.platform);
  const opts = asObj(p.options);
  const type = asStr(p.type) ?? 'discord';
  const consumed = new Set<string>(); // option keys the per-type mapping consumed

  const take = (key: string): unknown => {
    consumed.add(key);
    return opts[key];
  };
  const takeStr = (key: string): string | undefined => asStr(take(key));

  const entry: Raw = { type };

  // Common fields shared by every platform (only carried when the source set them).
  const channels = Array.isArray(p.channels) && p.channels.length ? p.channels : undefined;
  if (channels) entry.chat = { channels };
  setIf(entry, 'slash', p.slash);
  setIf(entry, 'autoThread', p.autoThread);
  setIf(entry, 'threadAutoArchiveMinutes', p.threadAutoArchiveMinutes);

  switch (type) {
    case 'discord':
      setIf(entry, 'token', asStr(p.token));
      setIf(entry, 'intents', p.intents);
      setIf(entry, 'commandGuildId', asStr(p.commandGuildId));
      break;
    case 'telegram':
      setIf(entry, 'token', asStr(p.token) ?? takeStr('token'));
      break;
    case 'slack':
      // v0 kept the app-level token in either options.token or platform.token.
      setIf(entry, 'appToken', takeStr('token') ?? asStr(p.token));
      setIf(entry, 'botToken', takeStr('botToken'));
      setIf(entry, 'protocol', takeStr('protocol'));
      setIf(entry, 'signing', takeStr('signing'));
      notes.push('slack: token → appToken');
      break;
    case 'lark': {
      setIf(entry, 'appId', takeStr('appId'));
      setIf(entry, 'appSecret', takeStr('appSecret'));
      setIf(entry, 'endpoint', takeStr('platform')); // options.platform ('feishu'|'lark') → endpoint
      setIf(entry, 'protocol', takeStr('protocol'));
      for (const k of ['selfUrl', 'path', 'encryptKey', 'verificationToken', 'host'] as const) {
        setIf(entry, k, takeStr(k));
      }
      for (const k of ['verifyToken', 'verifySignature', 'port'] as const) setIf(entry, k, take(k));
      if (asStr(p.token) && p.token !== entry.appId) {
        notes.push('lark: dropped platform.token (credentials are appId/appSecret)');
      } else if (asStr(p.token)) {
        notes.push('lark: dropped placeholder token (was backfilled from appId by setup)');
      }
      if (opts.platform !== undefined) notes.push('lark: options.platform → endpoint');
      break;
    }
    case 'qq': {
      setIf(entry, 'appId', takeStr('id'));
      setIf(entry, 'secret', takeStr('secret'));
      setIf(entry, 'botType', takeStr('type')); // options.type ('public'|'private') → botType
      setIf(entry, 'sandbox', take('sandbox'));
      setIf(entry, 'intents', take('intents'));
      setIf(entry, 'protocol', takeStr('protocol'));
      if (asStr(p.token)) notes.push('qq: dropped placeholder token (was backfilled from AppID by setup)');
      notes.push('qq: options.id → appId, options.type → botType');
      break;
    }
    case 'line':
      setIf(entry, 'token', takeStr('token') ?? asStr(p.token));
      for (const k of ['secret', 'selfUrl', 'host'] as const) setIf(entry, k, takeStr(k));
      setIf(entry, 'port', take('port'));
      break;
    case 'wecom':
      for (const k of ['corpId', 'agentId', 'secret', 'aesKey', 'selfUrl', 'host'] as const) {
        setIf(entry, k, takeStr(k));
      }
      setIf(entry, 'port', take('port'));
      // v0 top-level token was the callback verification token; options.token as fallback.
      setIf(entry, 'token', asStr(p.token) ?? takeStr('token'));
      break;
    default:
      // Unknown type: carry token + all options verbatim; v1 validation will report precisely.
      setIf(entry, 'token', asStr(p.token));
      for (const [k, v] of Object.entries(opts)) {
        consumed.add(k);
        setIf(entry, k, v);
      }
      break;
  }

  const dropped = Object.keys(opts).filter((k) => !consumed.has(k));
  if (dropped.length) {
    notes.push(`${type}: dropped unrecognized options keys: ${dropped.join(', ')}`);
  }

  // Instance id = the platform type, so existing routing when.platform values and
  // access.allowFrom `platform:userId` identities keep matching unchanged.
  const { platform: _platform, ...rest } = raw;
  return { config: { version: 1, ...rest, platforms: { [type]: entry } }, notes };
}
