import type { CommandSurface } from '../core/command-translate.js';
import type { PlatformAdapter } from '../platform/adapter.js';

/** Hard character caps for one update-card entry and across a burst of sub-agent updates. */
export const CARD_ITEM_CHARS = 4_000;
export const CARD_TOTAL_CHARS = 8_000;

/** Shared nesting check for sub-agent task commands, slash menu registration, and `/super` refusal. */
export function commandSurface(adapter: Pick<PlatformAdapter, 'parentOf' | 'childrenOf'>): CommandSurface {
  return { nested: Boolean(adapter.parentOf && adapter.childrenOf) };
}
