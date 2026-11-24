import type { Event } from '../../base/event.js';
import type { Disposable } from '../../base/lifecycle.js';
import type { FilesSource } from './instructions-source.js';
import type {
  SettingsSectionContribution,
  ViewContribution,
} from '../../plugins/api.js';
import type { SettingsPostFn, SettingsTopicRef, SettingsWebMessage } from './types.js';

export type WorkbenchPanelComponent = ReturnType<ViewContribution['component']>;
export type WorkbenchPanelInitContext = Parameters<WorkbenchPanelComponent['init']>[1];

export interface SettingsEditorInput {
  readonly scope?: 'gateway' | 'device';
  readonly sectionId?: string;
  readonly agentId?: string;
}

export interface InstructionEditorInput {
  readonly agent?: string;
  readonly fileId?: string;
  readonly orphans?: boolean;
  readonly title?: string;
  readonly source?: FilesSource;
}

export interface GatewayCatalogSection {
  readonly id: string;
  readonly label: string;
  readonly count?: number;
  readonly kind: 'group' | 'orphans';
}

export interface SettingsPluginBridge {
  handleMessage(msg: SettingsWebMessage | null | undefined): boolean;
  refresh(): void;
  getMessage(): SettingsWebMessage | null;
}

export interface SettingsPluginDeps {
  readonly instrOk?: boolean;
  readonly listDeviceSections: () => readonly SettingsSectionContribution[];
  readonly onDidChangeDeviceSections?: Event<void>;
  readonly getEpoch?: () => number;
  readonly getTopic?: () => string;
  readonly getTopics?: () => readonly SettingsTopicRef[];
  readonly post?: SettingsPostFn;
  readonly doc?: Document;
  readonly fadeMs?: number;
  readonly waitMs?: number;
  readonly onSettingsMessage?: Event<SettingsWebMessage>;
  readonly onReady?: (bridge: SettingsPluginBridge) => void;
}

export interface SettingsEditorHandler {
  handleMessage(msg: SettingsWebMessage | null | undefined): boolean;
  refresh(): void;
  focusSection(input: SettingsEditorInput): void;
}

export interface SettingsRuntime extends Disposable {
  readonly instrOk: boolean;
  readonly bridge: SettingsPluginBridge;
  readonly onDidChangeGateway: Event<void>;
  readonly onDidChangeDeviceSections?: Event<void>;
  readonly onDidChangeSelection: Event<SettingsEditorInput | undefined>;
  getGatewayMessage(): SettingsWebMessage | null;
  setGatewayMessage(msg: SettingsWebMessage | null): void;
  getGatewaySections(): readonly GatewayCatalogSection[];
  listDeviceSections(): readonly SettingsSectionContribution[];
  getSelection(): SettingsEditorInput | undefined;
  setSelection(input: SettingsEditorInput | undefined): void;
  registerEditor(handler: SettingsEditorHandler): Disposable;
  openSettings(input?: SettingsEditorInput): void;
  openInstruction(input: InstructionEditorInput): void;
  createInstructionSource(input: InstructionEditorInput, onRefresh?: () => void): FilesSource | null;
  registerTreePainter(source: FilesSource, paint: () => void): Disposable;
  notifyTreePaint(source: FilesSource): void;
  getTopic(): string;
  getTopics(): readonly SettingsTopicRef[];
}

export function isSettingsEditorInput(input: unknown): input is SettingsEditorInput {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  const scopeOk = obj.scope === undefined || obj.scope === 'gateway' || obj.scope === 'device';
  const secOk = obj.sectionId === undefined || typeof obj.sectionId === 'string';
  const agOk = obj.agentId === undefined || typeof obj.agentId === 'string';
  return scopeOk && secOk && agOk;
}

export function isInstructionEditorInput(input: unknown): input is InstructionEditorInput {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  const agentOk = obj.agent === undefined || typeof obj.agent === 'string';
  const fileOk = obj.fileId === undefined || typeof obj.fileId === 'string';
  const orphansOk = obj.orphans === undefined || typeof obj.orphans === 'boolean';
  const titleOk = obj.title === undefined || typeof obj.title === 'string';
  return agentOk && fileOk && orphansOk && titleOk;
}
