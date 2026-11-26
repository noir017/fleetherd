import type { Disposable } from '../../../base/lifecycle.js';
import type { OverlayManager } from '../../../services/overlays.js';
import type { LocalPendingItem } from '../status/types.js';

export interface ComposerAttachment {
  name: string;
  mime: string;
  data: string;
}

export interface ComposerDraft {
  text: string;
  s: number | null;
  e: number | null;
  files: ComposerAttachment[];
}

export type UnsentState = 'sending' | 'failed' | 'unsure';
export type LocalBubbleState = UnsentState | 'sent';

export interface UnsentRecord {
  t: string;
  x: string;
  n: string[];
  at: number;
  s: UnsentState;
  g: number;
}

export interface SendBody {
  topic: string;
  text: string;
  nonce: string;
  files?: ComposerAttachment[];
  quiet?: boolean;
}

export interface LocalBubbleMessage {
  id: string;
  _local: 1;
  _nonce: string;
  _state: LocalBubbleState;
  _text: string;
  own: true;
  html: string;
  at: number;
  buttons: unknown[];
  reactions: unknown[];
}

export interface LegacyLocalMessage {
  _local?: number | boolean;
  _nonce?: string;
  _text?: string;
  html?: string;
  at?: number;
}

export interface EchoMessage {
  id: string;
  nonce?: string;
  g?: number;
}

export interface SlashCommandOption {
  readonly name: string;
}

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly SlashCommandOption[];
}

export interface ComposerTopic {
  readonly id: string;
  readonly title?: string;
  readonly running?: boolean;
  readonly asking?: boolean;
  readonly live?: boolean;
}

export interface ComposerIcons {
  readonly mic: string;
  readonly stop: string;
  readonly copy: string;
  readonly check: string;
  readonly cross: string;
}

export interface ComposerElements {
  readonly input: HTMLTextAreaElement;
  readonly chips: HTMLElement;
  readonly hints: HTMLElement;
  readonly note: HTMLElement;
  readonly picker: HTMLInputElement;
  readonly attachBtn: HTMLElement | null;
  readonly micBtn: HTMLButtonElement | null;
  readonly composerForm: HTMLFormElement | null;
  readonly copyRefBtn: HTMLButtonElement | null;
  readonly killBtn: HTMLElement | null;
  readonly stopBtn: HTMLElement | null;
}

export interface ComposerTopicStatusBridge {
  addLocalPending(item: LocalPendingItem): void;
  hasLocalPending(nonce: string): boolean;
  removeLocalPending(nonce: string): boolean;
}

export interface ComposerTranscriptBridge {
  getMessage(key: string): LocalBubbleMessage | undefined;
  setMessage(key: string, msg: LocalBubbleMessage): void;
  deleteMessage(key: string): void;
  hasElement(key: string): boolean;
  removeElement(key: string): void;
  adoptElement(fromKey: string, toKey: string): void;
  paint(key: string): void;
  drop(key: string): void;
  sinkLocals(): void;
  syncEmptyNote(): void;
  atBottom(): boolean;
  toBottom(): void;
  onBtwAsked(key: string, msg: LocalBubbleMessage): void;
  onClaimKeyMoved(fromKey: string, toKey: string): void;
}

export interface ComposerDeps {
  readonly els: ComposerElements;
  readonly overlays: OverlayManager;
  readonly instanceId: string;
  readonly doc?: Document;
  readonly win?: Window;
  readonly storage?: Storage;
  readonly getTopic: () => string;
  readonly getTopics: () => readonly ComposerTopic[];
  readonly topicById: (id: string) => ComposerTopic | undefined;
  readonly getEpoch: () => number;
  readonly isNarrow: () => boolean;
  readonly isHistoryOpen: () => boolean;
  readonly getHistoryRef: () => string | null;
  readonly getIcons: () => ComposerIcons;
  readonly openShot: (img: HTMLImageElement) => void;
  readonly settleAdopted: (topicId: string, typed: string) => void;
  readonly cacheSave: () => void;
  readonly topicStatus: ComposerTopicStatusBridge;
  readonly transcript: ComposerTranscriptBridge;
  readonly postFn?: (path: string, body: unknown, tries?: number, limit?: number) => Promise<Response>;
  readonly now?: () => number;
}

export interface ComposerController extends Disposable {
  attach(): void;
  grow(): void;
  renderChips(): void;
  stashDraft(id: string): void;
  loadDraft(id: string): void;
  loadDraftIfEmpty(id: string): void;
  seedDraft(id: string, draftText: string): void;
  hasDraft(id: string): boolean;
  recallContent(content: string): void;
  setCommands(list: readonly SlashCommand[]): void;
  suggest(): void;
  isHintsOpen(): boolean;
  closeHints(): void;
  isRecording(): boolean;
  micLabel(): void;
  stopRec(keep: boolean): void;
  send(): void;
  command(cmdText: string): void;
  dispatch(typed: string, attached: readonly ComposerAttachment[]): void;
  deliver(nonce: string): void;
  setLocal(nonce: string, state: LocalBubbleState): void;
  hasOutbox(nonce: string): boolean;
  dropUnsent(nonce: string): void;
  retireLocalNonce(nonce: string): void;
  showUnsent(topicId: string): void;
  settleUnsure(): void;
  adoptLegacy(msg: LegacyLocalMessage): boolean;
  claim(msg: EchoMessage): void;
  copyLocal(nonce: string, btn: HTMLElement): void;
  discardLocal(nonce: string): void;
  copyText(text: string, done: (ok: boolean) => void): void;
  syncCopyRef(): void;
  copyTopicRef(id: string): void;
  forgetTopic(id: string): void;
  pruneTopics(known: Readonly<Record<string, unknown>>): void;
  keepOnly(keep: Readonly<Record<string, unknown>>): void;
  onLocaleChange(): void;
}
