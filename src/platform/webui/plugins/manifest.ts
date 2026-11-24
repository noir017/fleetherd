import { z } from 'zod';

/** Built-in workbench plugin IDs reserved against collisions from external plugins. */
export const RESERVED_PLUGIN_IDS: ReadonlySet<string> = new Set([
  'topics',
  'topic',
  'history',
  'schedules',
  'reviews',
  'skills',
  'settings',
  'changes',
  'files',
  'terminal',
  'reader',
  'status',
  'palette',
]);

export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{1,40}$/;

/**
 * Validates a plugin-relative POSIX file path: rejects empty strings, NUL bytes,
 * backslashes, absolute paths, drive prefixes, `.` / `..` segments, and glob metacharacters.
 */
export function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  if (/[*?]/.test(value)) return false;
  const segments = value.split('/');
  return segments.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

/**
 * Validates a plugin-relative POSIX glob pattern for `assets`: same traversal guards as
 * `isSafeRelativePath`, while permitting `*` / `**` / `?` wildcards.
 */
export function isSafeAssetPattern(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split('/');
  return segments.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

const SafeRelativePathSchema = z
  .string()
  .min(1)
  .refine(isSafeRelativePath, 'must be a safe relative POSIX path (no leading /, .., \\, or wildcards)');

const SafeAssetPatternSchema = z
  .string()
  .min(1)
  .refine(isSafeAssetPattern, 'must be a safe relative POSIX glob pattern (no leading /, .., or \\)');

export const PluginManifestSchema = z
  .object({
    id: z
      .string()
      .regex(PLUGIN_ID_RE, 'plugin id must match /^[a-z][a-z0-9-]{1,40}$/')
      .refine((id) => !RESERVED_PLUGIN_IDS.has(id), 'plugin id collides with a built-in plugin'),
    name: z.string().min(1),
    version: z.string().min(1),
    engines: z
      .object({
        fleetherdWebui: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    client: SafeRelativePathSchema.optional(),
    style: SafeRelativePathSchema.optional(),
    server: SafeRelativePathSchema.optional(),
    assets: z.array(SafeAssetPatternSchema).optional(),
  })
  .strict();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface BootPluginEntry {
  readonly id: string;
  readonly version: string;
  readonly client?: string;
  readonly style?: string;
}

export function parsePluginManifest(
  raw: unknown
): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
  const parsed = PluginManifestSchema.safeParse(raw);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  const issue = parsed.error.issues[0];
  const at = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return { ok: false, error: `${at}${issue?.message ?? 'invalid plugin manifest'}` };
}
