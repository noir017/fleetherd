import type { EditorContribution, MenuItem, TopicInfo, WebuiEvents } from '../../../plugins/api.js';
import type { OverlayManager } from '../../../services/overlays.js';
import type { ComposerController, ComposerDeps } from '../composer/types.js';
import type { TopicStatusController, TopicStatusDeps } from '../status/index.js';
import type { TranscriptController, TranscriptDeps } from '../transcript/index.js';

export type TopicPanelComponent = ReturnType<EditorContribution['component']>;
export type TopicPanelInitContext = Parameters<TopicPanelComponent['init']>[1];
export type TopicPanelRef = TopicPanelInitContext['api'];

export type TopicStreamState = WebuiEvents['stream.state']['state'];

export type TopicEditorInput = string | { readonly topicId: string };

export interface TopicEditorToolDescriptor {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly active?: boolean;
  readonly badge?: number | string | null;
}

export interface TopicEditorMenuEntry {
  readonly item: MenuItem;
  readonly disabled: boolean;
  readonly disabledReason?: string;
}

export interface MessageMenuTarget {
  readonly topicId: string;
  readonly messageKey: string;
  readonly text: string;
  readonly element: HTMLElement;
}

export interface TopicEditorIcons {
  readonly menu?: string;
  readonly back: string;
  readonly more: string;
  readonly plus: string;
  readonly mic: string;
  readonly stop: string;
  readonly send?: string;
  readonly copy: string;
  readonly check: string;
  readonly cross: string;
  readonly clock: string;
  readonly bolt: string;
  readonly undo: string;
  readonly fork: string;
  readonly power: string;
  readonly pause: string;
  readonly trash: string;
  readonly git: string;
  readonly folder: string;
  readonly terminal: string;
  readonly offline: string;
  readonly diff: string;
  readonly wrap: string;
}

export interface TopicEditorElements {
  readonly root: HTMLElement;
  readonly header: HTMLElement;
  readonly menuBtn: HTMLButtonElement;
  readonly backBtn: HTMLButtonElement;
  readonly statusDotHost: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly statePillEl: HTMLElement;
  readonly connPillEl: HTMLElement;
  readonly toolsHost: HTMLElement;
  readonly moreBtn: HTMLButtonElement;
  readonly forkNote: HTMLButtonElement;
  readonly log: HTMLElement;
  readonly typingEl: HTMLElement;
  readonly noteEl: HTMLElement;
  readonly barEl: HTMLElement;
  readonly pendingQueueEl: HTMLElement;
  readonly machineNoteEl: HTMLElement;
  readonly statusRowEl: HTMLElement;
  readonly statusEl: HTMLElement;
  readonly dirEl: HTMLElement;
  readonly powerBtn: HTMLButtonElement;
  readonly btwBox: HTMLElement;
  readonly btwQ: HTMLElement;
  readonly btwBody: HTMLElement;
  readonly btwClose: HTMLButtonElement;
  readonly modelPop: HTMLElement;
  readonly mpHeading: HTMLElement;
  readonly mpAgent: HTMLElement;
  readonly mpClose: HTMLButtonElement;
  readonly mpFilter: HTMLInputElement;
  readonly mpList: HTMLElement;
  readonly mpFoot: HTMLElement;
  readonly hints: HTMLElement;
  readonly chips: HTMLElement;
  readonly composerForm: HTMLFormElement;
  readonly input: HTMLTextAreaElement;
  readonly picker: HTMLInputElement;
  readonly attachBtn: HTMLButtonElement;
  readonly micBtn: HTMLButtonElement;
  readonly stopBtn: HTMLButtonElement;
  readonly sendBtn: HTMLButtonElement;
}

export interface TopicEditorControllerFactories {
  readonly createTranscript?: (els: TopicEditorElements, getTopicId: () => string) => TranscriptController;
  readonly createStatus?: (els: TopicEditorElements, getTopicId: () => string) => TopicStatusController;
  readonly createComposer?: (els: TopicEditorElements, getTopicId: () => string) => ComposerController;
}

export interface TopicEditorQuickPickModelItem {
  readonly value: string;
  readonly name?: string;
  readonly current?: boolean;
  readonly configured?: boolean;
  readonly description?: string;
}

export interface TopicEditorQuickPickAdapter {
  readonly listModels?: (topicId: string) => Promise<readonly TopicEditorQuickPickModelItem[]>;
  readonly selectModel?: (topicId: string, value: string) => Promise<void>;
  readonly listOptionChoices?: (
    topicId: string,
    optId: string,
  ) => Promise<{ readonly title: string; readonly items: readonly TopicEditorQuickPickModelItem[] }>;
  readonly selectOption?: (topicId: string, optId: string, value: string) => Promise<void>;
}

export interface TopicEditorDeps {
  readonly getTopicInfo: (id: string) => TopicInfo | undefined;
  readonly getStreamState?: () => TopicStreamState;
  readonly getTopicTools?: (topic: TopicInfo) => readonly TopicEditorToolDescriptor[];
  readonly onToggleTopicTool?: (toolId: string, topicId: string) => void;
  readonly getTitleMenuGroups?: (topic: TopicInfo) => readonly (readonly TopicEditorMenuEntry[])[];
  readonly getMessageMenuGroups?: (target: MessageMenuTarget) => readonly (readonly TopicEditorMenuEntry[])[];
  readonly onOpenTurnDiffSideBySide?: (topicId: string, turn: number, panelId?: string) => Promise<void> | void;
  readonly canOpenSideDiff?: () => boolean;
  readonly onBack?: () => void;
  readonly onToggleSidebar?: () => void;
  readonly onTopicChange?: (nextTopicId: string, prevTopicId: string) => void;
  readonly onMount?: (handle: TopicEditorHandle) => void;
  readonly onFocus?: (handle: TopicEditorHandle) => void;
  readonly onDispose?: (handle: TopicEditorHandle) => void;
  readonly resolveIcon?: (name: string) => string;
  readonly icons?: Partial<TopicEditorIcons>;
  readonly overlays?: OverlayManager;
  readonly controllers?: TopicEditorControllerFactories;
  readonly transcriptDeps?: (els: TopicEditorElements, getTopicId: () => string) => TranscriptDeps;
  readonly statusDeps?: (els: TopicEditorElements, getTopicId: () => string) => TopicStatusDeps;
  readonly composerDeps?: (els: TopicEditorElements, getTopicId: () => string) => ComposerDeps;
  readonly quickPick?: TopicEditorQuickPickAdapter;
  readonly doc?: Document;
  readonly win?: Window;
  readonly storage?: Storage;
}

export interface TopicEditorHandle extends TopicPanelComponent {
  readonly els: TopicEditorElements;
  readonly transcript: TranscriptController | null;
  readonly status: TopicStatusController | null;
  readonly composer: ComposerController | null;
  getTopicId(): string;
  getPanelId(): string | undefined;
  refreshHeader(): void;
  setStreamState(state: TopicStreamState): void;
  openTitleMenu(): void;
  insertIntoComposer(text: string): void;
  openModelQuickPick(optId?: string | null): Promise<boolean>;
}

export function parseTopicEditorInput(params: unknown): string {
  if (typeof params === 'string') return params.trim();
  if (params && typeof params === 'object' && 'topicId' in params) {
    const raw = (params as { readonly topicId?: unknown }).topicId;
    if (typeof raw === 'string') return raw.trim();
  }
  return '';
}
