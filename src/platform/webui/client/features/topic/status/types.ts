import type { AgentStatus, QuotaPool, SessionOption, StatusOption, StatusPermissions } from '../../../../../../types.js';
import type { WebPendingItem } from '../../../../protocol.js';

export type { AgentStatus, QuotaPool, SessionOption, StatusOption, StatusPermissions, WebPendingItem };

export type PendingReason = 'sending' | 'tool' | 'delay' | 'turn';

export interface LocalPendingItem {
  readonly topic: string;
  readonly nonce: string;
  readonly content: string;
  readonly attachments: number;
  readonly at: number;
}

export interface StatusIcons {
  readonly clock: string;
  readonly bolt: string;
  readonly undo: string;
  readonly check: string;
}

export interface ModelOptionItem {
  readonly value: string;
  readonly name?: string;
}

export interface ModelListResponse {
  readonly ok: boolean;
  readonly agent?: string;
  readonly current?: string;
  readonly configured?: string;
  readonly options?: readonly ModelOptionItem[];
  readonly text?: string;
}

export interface EffortLevels {
  readonly current?: string;
  readonly options: readonly { readonly value: string; readonly name: string }[];
}

export interface OptionListResponse {
  readonly ok: boolean;
  readonly agent?: string;
  readonly reason?: string;
  readonly options?: readonly SessionOption[];
  readonly permissions?: StatusPermissions;
  /** The current model's effort levels; absent when it offers none (or the agent did not start). */
  readonly effort?: EffortLevels;
  readonly text?: string;
}

export interface OptionPeekResponse {
  readonly agent?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly options?: readonly StatusOption[];
  readonly permissions?: StatusPermissions;
}

export interface ModelChoiceResponse {
  readonly ok: boolean;
  readonly model?: string;
  readonly text?: string;
}

export interface OptionChoiceResponse {
  readonly ok: boolean;
  /** For the effort switch: the level the harness reports after the change. */
  readonly effort?: string;
  readonly text?: string;
}

export interface PendingRecallResponse {
  readonly ok: boolean;
  readonly content?: string;
}
