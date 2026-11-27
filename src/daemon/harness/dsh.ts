import { instructionsHome } from '../../config/instructions.js';
import type { HarnessProfile } from './profile.js';

/**
 * DSH's model selector value: JSON.stringify([provider, model]) (@deepseek-ai/dsh-acp).
 * Translates fleetherd's "provider/model" spelling to the JSON tuple DSH requires on the wire.
 */
export function dshModelSelectorValue(model: string): string {
  const slash = model.indexOf('/');
  // No provider half (a bare model id): encode with an empty provider so applyModelPreference's
  // offer-check rejects it explicitly with the real choices instead of DSH's opaque "unknown model option".
  const provider = slash === -1 ? '' : model.slice(0, slash);
  const name = slash === -1 ? model : model.slice(slash + 1);
  return JSON.stringify([provider, name]);
}

/** Inverse of dshModelSelectorValue: decode a 2-element JSON string array back to "provider/model". */
export function dshModelDisplayValue(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return `${parsed[0]}/${parsed[1]}`;
    }
  } catch {
    // Not JSON (a bare model id from a non-dsh harness) — pass through.
  }
  return value;
}

export const dshProfile: HarnessProfile = {
  id: 'dsh',
  launch: (def) => ({ command: 'dsh', args: ['--profile', 'acp', ...def.args] }),
  reviewIsolation: 'operator-args',
  doctor: {
    command: () => 'dsh',
  },
  encodeModelWire: dshModelSelectorValue,
  decodeModelDisplay: dshModelDisplayValue,
  skillHomes: () => [],
  skillScanDirs: () => [],
  instructionsHome,
};
