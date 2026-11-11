import { input, select, confirm } from '@inquirer/prompts';
import { z } from 'zod';
import { ConfigSchema, type UserConfig } from '../config/schema.js';
import { PLATFORM_SCHEMAS, type PlatformType } from '../platform/config-schemas.js';
import { isLegacyConfig, migrateLegacyConfig } from '../config/migrate.js';
import { saveConfig, saveConfigPatch, configPath, readRawConfigIfExists } from '../config/load.js';

/**
 * `fleetherd setup` — interactive wizard. Asks the minimal required items; everything
 * else uses schema defaults. Experience params (throttle/threshold/emoji…) aren't
 * asked one by one — the defaults match hermes, and advanced users edit the yaml.
 *
 * Platform prompts are DRIVEN BY THE SCHEMA (config-schemas.ts): every required field
 * of the chosen platform's entry is asked (its zod .describe() is the prompt text);
 * optional/defaulted fields are yaml-only. Adding a platform therefore needs no wizard
 * change — the old per-platform switch (and its lark/qq placeholder-token hack) is gone.
 */

/** Post-prompt hints, printed after a platform's credentials are collected. */
const PLATFORM_NOTES: Partial<Record<PlatformType, string>> = {
  slack: 'Note: defaults to ws (Socket Mode). To use protocol=http (Events API), edit the yaml and also set signing.',
  lark: 'Note: edit the yaml to change endpoint (feishu/lark) or protocol (ws/http) if needed.',
  qq: 'Note: edit the yaml to set sandbox/intents/protocol if needed.',
  line: 'Note: edit the yaml to set host/port if needed.',
  dingtalk: 'Note: defaults to ws (Stream mode, no public URL). Edit the yaml for protocol=http (webhook at <public host>/dingtalk) with host/port.',
  webui:
    'Note: the page is served at http://<host>:8787 — edit the yaml for host/port/title. It binds every interface and speaks plain HTTP, so the token you just set is the only thing protecting it; put TLS in front of it before exposing it beyond a network you trust, or set host: 127.0.0.1 and reach it over an SSH tunnel. Its identity for access.allowFrom is "<this instance id>:owner", and the "channels to listen on" question below is answered by "main" or left empty.',
};

/**
 * Ask for every required field of a platform entry schema. A field is required when
 * it is not wrapped in ZodOptional/ZodDefault (i.e. the operator MUST supply it);
 * `type` is the discriminator and skipped. Required enums (qq botType) become a
 * select; required strings become a non-empty input using .describe() as the label.
 */
async function promptPlatformFields(type: PlatformType): Promise<Record<string, unknown>> {
  const shape = PLATFORM_SCHEMAS[type].shape as Record<string, z.ZodTypeAny>;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    if (key === 'type') continue;
    if (field instanceof z.ZodOptional || field instanceof z.ZodDefault) continue; // yaml-only (has a default / optional)
    const label = `${field.description ?? key}:`;
    if (field instanceof z.ZodEnum) {
      out[key] = await select({
        message: label,
        choices: (field.options as string[]).map((v) => ({ name: v, value: v })),
      });
      continue;
    }
    // Remaining required fields are all credential strings (schema invariant).
    out[key] = (
      await input({
        message: label,
        validate: (v) => (v.trim().length > 0 ? true : 'This field cannot be empty.'),
      })
    ).trim();
  }
  return out;
}

export async function runSetup(): Promise<void> {
  let existing = readRawConfigIfExists();
  // A v0 file gets migrated up-front so the wizard merges/validates against one shape.
  // The final write is then a FULL rewrite (v0 files were machine-written; no comments to keep).
  const migratedFromV0 = existing !== undefined && isLegacyConfig(existing);
  if (existing && migratedFromV0) {
    const { config, notes } = migrateLegacyConfig(existing);
    existing = config;
    console.log('Found a v0 config; it will be upgraded to the v1 `platforms:` format on save.');
    for (const n of notes) console.log(`  - ${n}`);
  }
  if (existing) {
    const ok = await confirm({
      message: `Found an existing config at ${configPath()}. The wizard only updates the chosen platform/agents/routing/scope/allowFrom; any other hand-edited settings are preserved. Continue?`,
    });
    if (!ok) {
      console.log('Cancelled.');
      return;
    }
  }

  // Pick the platform type; the choice list comes from the schema registry.
  const platformNames: Record<PlatformType, string> = {
    discord: 'Discord',
    telegram: 'Telegram',
    qq: 'QQ (qqguild channels)',
    lark: 'Lark / Feishu',
    slack: 'Slack',
    line: 'LINE',
    wecom: 'WeCom (WeChat Work)',
    dingtalk: 'DingTalk (钉钉)',
    webui: 'Web UI (a browser page this daemon serves)',
  };
  const platformType = (await select({
    message: 'IM platform:',
    choices: (Object.keys(PLATFORM_SCHEMAS) as PlatformType[]).map((t) => ({
      name: platformNames[t],
      value: t,
    })),
    default: 'discord',
  })) as PlatformType;

  const fields = await promptPlatformFields(platformType);
  const note = PLATFORM_NOTES[platformType];
  if (note) console.log(note);

  const channelsRaw = await input({
    message: 'Channel IDs to listen on (comma-separated; empty = all):',
    default: '',
  });
  const channels = channelsRaw.split(',').map((s) => s.trim()).filter(Boolean);

  const scope = await select({
    message: 'Session scope (granularity of an agent session):',
    choices: [
      { name: 'One session per channel (recommended)', value: 'per_channel' },
      { name: 'One session per user', value: 'per_user' },
      { name: 'One session per thread', value: 'per_thread' },
      { name: 'Single shared session', value: 'shared' },
    ],
    default: 'per_channel',
  });

  const harness = await select({
    message: 'Agent harness (the coding agent to drive):',
    choices: [
      { name: 'Claude (via claude-agent-acp)', value: 'claude' },
      { name: 'Gemini CLI (native ACP)', value: 'gemini' },
      { name: 'Codex', value: 'codex' },
      { name: 'Antigravity CLI (agy)', value: 'agy' },
      { name: 'Custom (provide your own command)', value: 'custom' },
    ],
    default: 'claude',
  });

  const command =
    harness === 'custom'
      ? await input({
          message: 'Executable command to launch the ACP agent:',
          validate: (v) => (v.trim().length > 0 ? true : 'A command is required for the custom harness.'),
        })
      : undefined;

  const model = await input({
    message: 'Model (leave empty to use the harness default):',
    default: harness === 'claude' ? 'claude-opus-4-8' : '',
  });

  // Access control: who may trigger the bot. Agents always run with full tool access (the daemon
  // auto-approves tool calls), so an empty allowlist means anyone who can message the bot can drive
  // them. Strongly recommended in any shared/public deployment; empty is allowed (the daemon warns).
  const allowFromRaw = await input({
    message:
      'Allowlist of identities allowed to trigger the bot (comma-separated, format platform:userId, e.g. discord:123456789). Strongly recommended; empty = anyone who can message the bot can trigger it:',
    default: '',
  });
  const allowFrom = allowFromRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowFrom.length === 0) {
    console.log('⚠️  No allowlist set: anyone who can message the bot will be able to drive an agent with full tool access.');
  }

  // Instance id = the platform type (multi-instance setups are yaml-edit territory).
  // Merge onto any existing entry of the same id so hand-edited optional fields survive.
  const instanceId = platformType;
  const existingPlatforms =
    existing && typeof existing.platforms === 'object' && existing.platforms
      ? (existing.platforms as Record<string, unknown>)
      : {};
  const existingEntry =
    typeof existingPlatforms[instanceId] === 'object' && existingPlatforms[instanceId]
      ? (existingPlatforms[instanceId] as Record<string, unknown>)
      : {};
  const platformEntry: Record<string, unknown> = {
    ...existingEntry,
    type: platformType,
    ...fields,
    ...(channels.length || existingEntry.chat
      ? {
          chat: {
            ...(typeof existingEntry.chat === 'object' && existingEntry.chat ? existingEntry.chat : {}),
            channels,
          },
        }
      : {}),
  };

  const agents = [
    {
      id: 'default',
      harness,
      ...(command ? { command } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    },
  ];
  const routing = { default: 'default', pipeline: [] };

  // Validate the WHOLE merged config before writing anything (the wizard must not
  // produce a file that loadConfig rejects). ${VAR} references are opaque strings
  // here — expansion happens at load time only, so secrets never round-trip expanded.
  const merged = {
    ...(existing ?? {}),
    version: 1,
    platforms: { ...existingPlatforms, [instanceId]: platformEntry },
    agents,
    routing,
    session: {
      ...(typeof existing?.session === 'object' && existing?.session ? existing.session : {}),
      scope,
    },
    access: {
      ...(typeof existing?.access === 'object' && existing?.access ? existing.access : {}),
      allowFrom,
    },
  };
  const cfg: UserConfig = ConfigSchema.parse(merged);

  if (migratedFromV0 || !existing) {
    // Fresh file or v0 upgrade: full write of the validated config.
    saveConfig(cfg);
  } else {
    // Existing v1 file: patch ONLY the sections the wizard asked about — comments,
    // key order, and hand-edited sections elsewhere survive (yaml Document API).
    saveConfigPatch([
      { path: ['version'], value: 1 },
      { path: ['platforms', instanceId], value: platformEntry },
      { path: ['agents'], value: agents },
      { path: ['routing'], value: routing },
      { path: ['session', 'scope'], value: scope },
      { path: ['access', 'allowFrom'], value: allowFrom },
    ]);
  }

  console.log(`✅ Wrote ${configPath()}`);
  console.log('Multi-agent setups, routing pipelines, multi-instance platforms, and ${VAR} secrets are advanced features — edit the yaml directly (see the README).');
  console.log('Next: run `fleetherd doctor` to self-check, then `fleetherd start` to launch the daemon.');
}
