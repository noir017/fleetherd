import type { FilesPanelEntry, FilesPanelFile, FilesPanelKind } from '../../../../adapter.js';
import type { CodeViewApi } from '../../../codeview/app.js';
import type { TopicToolContribution } from '../../plugins/api.js';
import type { ApiClient } from '../../services/api.js';
import type { OverlayManager } from '../../services/overlays.js';

export type FeaturePanelComponent = ReturnType<TopicToolContribution['component']>;
export type FeaturePanelInitContext = Parameters<FeaturePanelComponent['init']>[1];
export type FeaturePanelRef = FeaturePanelInitContext['api'];

export interface FilesHttpResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface FileEditorInput {
  readonly topicId: string;
  readonly path: string;
  readonly root?: string;
  readonly name?: string;
  readonly rel?: string;
}

export interface RevealInTreeRequest {
  readonly topicId: string;
  readonly path: string;
}

export interface FileTreeItemData {
  readonly path: string;
  readonly name: string;
  readonly dir: boolean;
}

export interface FilesTreeCacheEntry {
  readonly path: string;
  readonly entries: readonly FilesPanelEntry[];
}

export interface FilesPluginDeps {
  /** Security invariant 9: off by default; must mirror platforms.<id>.files.enabled. */
  readonly filesEnabled?: boolean | (() => boolean);
  readonly api?: Pick<ApiClient, 'get' | 'post'>;
  readonly fetchFn?: typeof fetch;
  readonly codeView?: () => Promise<CodeViewApi | null>;
  readonly codeBlocks?: (root: Element) => void;
  readonly overlays?: OverlayManager;
  readonly doc?: Document;
}

export interface FileVersionBase {
  readonly mtimeMs: number;
  readonly size: number;
}

export interface LoadedFileState {
  readonly topicId: string;
  readonly path: string;
  readonly rel: string;
  readonly name: string;
  readonly dir: string;
  readonly kind: FilesPanelKind | '';
  readonly base: FileVersionBase | null;
  readonly sha256: string;
  readonly eol: 'crlf' | 'lf';
  readonly eolWarning: string;
  readonly savedDoc: string;
  readonly dataUrl: string;
  readonly note: string;
}

export type PartialFilesPanelFile = Partial<FilesPanelFile>;
