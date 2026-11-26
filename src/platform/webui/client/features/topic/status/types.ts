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

export interface OptionListResponse {
  readonly ok: boolean;
  readonly agent?: string;
  readonly options?: readonly SessionOption[];
  readonly permissions?: StatusPermissions;
  readonly text?: string;
}

export interface OptionPeekResponse {
  readonly agent?: string;
  readonly model?: string;
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
  readonly text?: string;
}

export interface PendingRecallResponse {
  readonly ok: boolean;
  readonly content?: string;
}
