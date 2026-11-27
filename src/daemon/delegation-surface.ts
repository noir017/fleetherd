import type { CommandSurface } from '../core/command-translate.js';
import type { PlatformAdapter } from '../platform/adapter.js';

/**
 * Hard character caps for one update-card entry and across a burst of sub-agent updates.
 * 4,000 keeps an actionable review intact — cutting before the verdict is worse than no card.
 */
export const CARD_ITEM_CHARS = 4_000;
export const CARD_TOTAL_CHARS = 8_000;

/** Shared nesting check for sub-agent task commands, slash menu registration, and `/super` refusal. */
export function commandSurface(adapter: Pick<PlatformAdapter, 'topics'>): CommandSurface {
  return { nested: Boolean(adapter.topics) };
}
