import type { Disposable } from '../../base/lifecycle.js';
import type { WebMessage } from '../../../protocol.js';

export type SettingsWebMessage = WebMessage & {
  _g?: number;
};

export interface SettingsTopicRef {
  readonly id: string;
  readonly title?: string;
}

export interface SettingsInstructionsBridge {
  ensure(): void;
  renderOrphans(): string;
  renderAgent(row: { target?: string; label: string }, index: number): string;
}

export type SettingsPostFn = (
  path: string,
  body: unknown,
  tries?: number,
  limit?: number,
) => Promise<Response>;

export interface SettingsFeatureDeps {
  readonly settingsPage: HTMLElement;
  readonly settingsBody: HTMLElement;
  readonly settingsTopicEl: HTMLElement;
  readonly settingsClose: HTMLElement;
  readonly settingsOpenBtn: HTMLElement;
  readonly instrOk: boolean;
  readonly getTopic: () => string;
  readonly getTopics: () => readonly SettingsTopicRef[];
  readonly getEpoch: () => number;
  readonly closeMenus: () => void;
  readonly instructions: SettingsInstructionsBridge;
  readonly post?: SettingsPostFn;
  readonly doc?: Document;
  readonly fadeMs?: number;
  readonly waitMs?: number;
}

export interface SettingsFeature extends Disposable {
  open(): void;
  close(): void;
  isOpen(): boolean;
  take(msg: SettingsWebMessage): void;
  handleMessage(msg: SettingsWebMessage | null | undefined): boolean;
  render(): void;
  getMessage(): SettingsWebMessage | null;
  getTopic(): string | null;
  onLocaleChange(): void;
}
