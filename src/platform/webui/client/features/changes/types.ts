import type { GitCommitSummary, GitMode, GitStatusFile } from '../../../../adapter.js';
import type { CodeViewApi, DiffSelection } from '../../../codeview/app.js';
import type { TopicToolContribution } from '../../plugins/api.js';
import type { ApiClient } from '../../services/api.js';

export type FeaturePanelComponent = ReturnType<TopicToolContribution['component']>;
export type FeaturePanelInitContext = Parameters<FeaturePanelComponent['init']>[1];
export type FeaturePanelRef = FeaturePanelInitContext['api'];

export type ChangesMode = GitMode | 'commits';

export interface ChangesCustomSource {
  readonly title?: string;
  readonly statusUrl: string;
  readonly fileUrl: string;
}

export interface DiffEditorInput {
  readonly topicId: string;
  readonly path: string;
  readonly ref?: string;
  readonly mode?: GitMode;
  readonly base?: string;
  readonly sha?: string;
  readonly commitShort?: string;
  readonly source?: {
    readonly title?: string;
    readonly fileUrl: string;
  };
}

export interface ChangesPluginDeps {
  readonly api?: Pick<ApiClient, 'get' | 'post'>;
  readonly fetchFn?: typeof fetch;
  readonly codeView?: () => Promise<CodeViewApi | null>;
  readonly filesEnabled?: boolean | (() => boolean);
  readonly formatAgo?: (at: number) => string;
  readonly narrow?: () => boolean;
  readonly doc?: Document;
}

export interface GitRepoInfo {
  readonly root: string;
  readonly branch?: string;
  readonly base?: string;
}

export interface GitCommitDetail extends GitCommitSummary {
  readonly body?: string;
}

export interface GitErrorPayload {
  readonly ok?: boolean;
  readonly reason?: string;
  readonly text?: string;
  readonly error?: string;
}

export interface GitStatusPayload extends GitErrorPayload {
  readonly repo?: GitRepoInfo;
  readonly files?: GitStatusFile[];
  readonly truncated?: boolean;
}

export interface GitBranchesPayload extends GitErrorPayload {
  readonly branches?: string[];
  readonly base?: string;
}

export interface GitLogPayload extends GitErrorPayload {
  readonly repo?: GitRepoInfo;
  readonly commits?: GitCommitSummary[];
  readonly more?: boolean;
}

export interface GitCommitPayload extends GitErrorPayload {
  readonly repo?: GitRepoInfo;
  readonly commit?: GitCommitDetail;
  readonly files?: GitStatusFile[];
  readonly truncated?: boolean;
}

export interface GitFilePayload extends GitErrorPayload {
  readonly path?: string;
  readonly original?: string;
  readonly modified?: string;
  readonly patch?: string;
  readonly binary?: boolean;
  readonly tooLarge?: boolean;
  readonly patchTooLarge?: boolean;
}

export interface DiffCommentContext {
  readonly path: string;
  readonly selection: DiffSelection;
  readonly sides: { readonly old: string; readonly new: string } | null;
  readonly refTag?: string;
}
