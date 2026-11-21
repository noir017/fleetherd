import type { Config } from '../config/schema.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { HistoryStore } from '../history/store.js';
import type { MessageKind, PlatformAdapter } from '../platform/adapter.js';
import type { ConversationId } from '../types.js';
import type { ConversationRegistry } from './conversation.js';
import type { ConversationStore } from './conversation-store.js';
import type { Delegation } from './delegation.js';
import type { ExternalTopics } from './external-topics.js';
import type { ScheduleService } from './schedule-service.js';
import type { SkillLibrary } from './skill-library.js';
import type { SkillsRepo } from './skills-repo.js';
import type { SkillRecord } from './skills-store.js';
import type { VoiceIntake } from './voice.js';

export type AskOutcome =
  | { kind: 'option'; labels: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'timeout' };

export interface AskButtonsOptions {
  acceptsText?: boolean;
  multi?: boolean;
  timeoutNote?: string;
  signal?: AbortSignal;
  kind?: MessageKind;
}

export const RELOAD_POD_TIMEOUT_MS = 20_000;

/** Shared view handed to Daemon collaborators so neither imports daemon.ts. */
export interface DaemonContext {
  readonly config: Config;
  readonly platforms: Map<string, PlatformAdapter>;
  readonly registry: ConversationRegistry;
  readonly store: ConversationStore | undefined;
  readonly history: HistoryStore | undefined;
  readonly voice: VoiceIntake;
  readonly schedules: ScheduleService | undefined;
  readonly delegation: Delegation;
  readonly externalTopics: ExternalTopics;
  readonly skillsRepo: SkillsRepo;
  readonly skillLibrary: SkillLibrary;
  offlineNames(): ReadonlySet<string>;
  askButtons(
    platform: PlatformAdapter,
    address: ConversationAddress,
    prompt: string,
    labels: string[],
    timeoutMs: number,
    conversationId?: ConversationId,
    opts?: AskButtonsOptions
  ): Promise<AskOutcome | null>;
  notifySkillArchived(skill: SkillRecord, reason: 'unused' | 'manual'): void;
  reloadAll(): Promise<{ ok: boolean; summary: string }>;
  podList(): { gatewayKey: string; pods: Array<Record<string, string>> };
}
