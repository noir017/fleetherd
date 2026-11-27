import { input, select, confirm } from '@inquirer/prompts';
import { z } from 'zod';
import { ConfigSchema, type UserConfig } from '../config/schema.js';
import { PLATFORM_SCHEMAS, type PlatformType } from '../platform/config-schemas.js';
import { isLegacyConfig, migrateLegacyConfig } from '../config/migrate.js';
import { saveConfig, saveConfigPatch, configPath, readRawConfigIfExists } from '../config/load.js';
import { detectEnvLocale, type Locale } from '../core/i18n/index.js';
import { tCli, type CliMessageKey } from '../core/i18n/cli.js';
import { HARNESSES } from '../daemon/harness/index.js';
import type { Harness } from '../types.js';

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

/**
 * Ask for every required field of a platform entry schema. A field is required when
 * it is not wrapped in ZodOptional/ZodDefault (i.e. the operator MUST supply it);
 * `type` is the discriminator and skipped. Required enums (qq botType) become a
 * select; required strings become a non-empty input using .describe() as the label.
 */
async function promptPlatformFields(type: PlatformType, locale: Locale): Promise<Record<string, unknown>> {
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
        validate: (v) => (v.trim().length > 0 ? true : tCli(locale, 'setup.prompt.fieldRequired')),
      })
    ).trim();
  }
  return out;
}

async function promptHarnessAndModel(locale: Locale): Promise<{ harness: string; command?: string; model: string }> {
  const harness = await select<Harness>({
    message: tCli(locale, 'setup.prompt.harness'),
    choices: [
      { name: tCli(locale, 'setup.harness.claude'), value: 'claude' },
      { name: tCli(locale, 'setup.harness.gemini'), value: 'gemini' },
      { name: tCli(locale, 'setup.harness.codex'), value: 'codex' },
      { name: tCli(locale, 'setup.harness.agy'), value: 'agy' },
      { name: tCli(locale, 'setup.harness.custom'), value: 'custom' },
    ],
    default: 'claude',
  });

  const command =
    HARNESSES[harness].setup?.promptCommand
      ? await input({
          message: tCli(locale, 'setup.prompt.customCommand'),
          validate: (v) => (v.trim().length > 0 ? true : tCli(locale, 'setup.prompt.customCommandRequired')),
        })
      : undefined;

  const model = await input({
    message: tCli(locale, 'setup.prompt.model'),
    default: HARNESSES[harness].setup?.defaultModel ?? '',
  });

  return { harness, command, model };
}

export function buildPlatformEntry(
  platformType: PlatformType,
  fields: Record<string, unknown>,
  channels: string[],
  existingEntry: Record<string, unknown>
): Record<string, unknown> {
  const chatConfig =
    channels.length || existingEntry.chat
      ? {
          chat: {
            ...(typeof existingEntry.chat === 'object' && existingEntry.chat ? existingEntry.chat : {}),
            channels,
          },
        }
      : {};
  return {
    ...existingEntry,
    type: platformType,
    ...fields,
    ...chatConfig,
  };
}

export function resolveExistingPlatforms(existing: Record<string, unknown> | undefined): Record<string, unknown> {
  if (existing && typeof existing.platforms === 'object' && existing.platforms) {
    return existing.platforms as Record<string, unknown>;
  }
  return {};
}

export function resolveExistingEntry(platforms: Record<string, unknown>, instanceId: string): Record<string, unknown> {
  const entry = platforms[instanceId];
  if (typeof entry === 'object' && entry) {
    return entry as Record<string, unknown>;
  }
  return {};
}

async function checkExistingConfig(
  rawExisting: Record<string, unknown> | undefined,
  locale: Locale
): Promise<{ existing: Record<string, unknown> | undefined; migrated: boolean; cancelled: boolean }> {
  let existing = rawExisting;
  const migrated = existing !== undefined && isLegacyConfig(existing);
  if (existing && migrated) {
    const { config, notes } = migrateLegacyConfig(existing);
    existing = config;
    console.log(tCli(locale, 'setup.foundV0'));
    for (const n of notes) console.log(`  - ${n}`);
  }
  if (existing) {
    const ok = await confirm({
      message: tCli(locale, 'setup.existingConfig', { path: configPath() }),
    });
    if (!ok) {
      console.log(tCli(locale, 'setup.cancelled'));
      return { existing, migrated, cancelled: true };
    }
  }
  return { existing, migrated, cancelled: false };
}

function saveSetupResult(
  existing: Record<string, unknown> | undefined,
  migratedFromV0: boolean,
  cfg: UserConfig,
  instanceId: string,
  platformEntry: Record<string, unknown>,
  locale: Locale,
  scope: UserConfig['session']['scope'],
  allowFrom: string[]
): void {
  if (migratedFromV0 || !existing) {
    saveConfig(cfg);
  } else {
    saveConfigPatch([
      { path: ['version'], value: 1 },
      { path: ['locale'], value: locale },
      { path: ['platforms', instanceId], value: platformEntry },
      { path: ['agents'], value: cfg.agents },
      { path: ['routing'], value: cfg.routing },
      { path: ['session', 'scope'], value: scope },
      { path: ['access', 'allowFrom'], value: allowFrom },
    ]);
  }
}

export async function runSetup(): Promise<void> {
  const rawExisting = readRawConfigIfExists();
  const envLocale = detectEnvLocale(process.env);
  const initialLocale = (rawExisting?.locale as Locale | undefined) ?? envLocale;
  const locale = (await select({
    message: tCli(initialLocale, 'setup.prompt.locale'),
    choices: [
      { name: 'English', value: 'en' },
      { name: '简体中文', value: 'zh-CN' },
    ],
    default: initialLocale,
  })) as Locale;

  const { existing, migrated, cancelled } = await checkExistingConfig(rawExisting, locale);
  if (cancelled) return;

  const platformType = (await select({
    message: tCli(locale, 'setup.prompt.imPlatform'),
    choices: (Object.keys(PLATFORM_SCHEMAS) as PlatformType[]).map((t) => ({
      name: tCli(locale, `setup.platformName.${t}` as CliMessageKey),
      value: t,
    })),
    default: 'discord',
  })) as PlatformType;

  const fields = await promptPlatformFields(platformType, locale);
  const noteKey = `setup.platformNote.${platformType}` as CliMessageKey;
  const note = tCli(locale, noteKey);
  if (note && note !== noteKey) console.log(note);

  const channelsRaw = await input({
    message: tCli(locale, 'setup.prompt.channels'),
    default: '',
  });
  const channels = channelsRaw.split(',').map((s) => s.trim()).filter(Boolean);

  const scope = (await select({
    message: tCli(locale, 'setup.prompt.scope'),
    choices: [
      { name: tCli(locale, 'setup.scope.perChannel'), value: 'per_channel' },
      { name: tCli(locale, 'setup.scope.perUser'), value: 'per_user' },
      { name: tCli(locale, 'setup.scope.perThread'), value: 'per_thread' },
      { name: tCli(locale, 'setup.scope.shared'), value: 'shared' },
    ],
    default: 'per_channel',
  })) as UserConfig['session']['scope'];

  const { harness, command, model } = await promptHarnessAndModel(locale);

  const allowFromRaw = await input({
    message: tCli(locale, 'setup.prompt.allowFrom'),
    default: '',
  });
  const allowFrom = allowFromRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowFrom.length === 0) {
    console.log(tCli(locale, 'setup.warn.noAllowlist'));
  }

  const instanceId = platformType;
  const existingPlatforms = resolveExistingPlatforms(existing);
  const existingEntry = resolveExistingEntry(existingPlatforms, instanceId);
  const platformEntry = buildPlatformEntry(platformType, fields, channels, existingEntry);

  const agents = [
    {
      id: 'default',
      harness,
      ...(command ? { command } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    },
  ];
  const routing = { default: 'default', pipeline: [] };

  const merged = {
    ...(existing ?? {}),
    version: 1,
    locale,
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

  saveSetupResult(existing, migrated, cfg, instanceId, platformEntry, locale, scope, allowFrom);

  console.log(tCli(locale, 'setup.success.wrote', { path: configPath() }));
  console.log(tCli(locale, 'setup.success.advanced'));
  console.log(tCli(locale, 'setup.success.next'));
}
