import { t as tr } from '../../../i18n/index.js';
import type { OpenEditorOptions } from '../../../plugins/api.js';

export const DIFF_EDITOR_KIND = 'diff';
export const MAX_SIDE_DIFF_FILES = 8;

export interface TurnChangeFileSummary {
  readonly path: string;
  readonly status?: string;
}

export interface TurnChangesStatusResponse {
  readonly ok?: boolean;
  readonly files?: readonly TurnChangeFileSummary[];
}

export interface TurnDiffEditorInput {
  readonly topicId: string;
  readonly path: string;
  readonly ref: string;
  readonly source: {
    readonly title: string;
    readonly fileUrl: string;
  };
}

export interface OpenTurnDiffOptions {
  readonly topicId: string;
  readonly turn: number;
  readonly panelId?: string;
  readonly fetchStatus: (url: string) => Promise<TurnChangesStatusResponse>;
  readonly openDiffEditor: (input: TurnDiffEditorInput, opts?: OpenEditorOptions) => void;
  readonly fallbackCommand?: (input: TurnDiffEditorInput, opts?: OpenEditorOptions) => Promise<unknown> | void;
  readonly maxFiles?: number;
}

export function buildTurnChangesUrls(topicId: string, turn: number): {
  readonly statusUrl: string;
  readonly fileUrl: string;
} {
  const q = `?t=${encodeURIComponent(topicId)}&turn=${encodeURIComponent(String(turn))}`;
  return {
    statusUrl: `/api/turn-changes/status${q}`,
    fileUrl: `/api/turn-changes/file${q}`,
  };
}

export async function openTurnDiffSideBySide(opts: OpenTurnDiffOptions): Promise<number> {
  if (!opts.topicId || !Number.isFinite(opts.turn) || opts.turn <= 0) return 0;
  const { statusUrl, fileUrl } = buildTurnChangesUrls(opts.topicId, opts.turn);
  let res: TurnChangesStatusResponse | null = null;
  try {
    res = await opts.fetchStatus(statusUrl);
  } catch {
    return 0;
  }
  if (!res || res.ok === false || !Array.isArray(res.files)) return 0;

  const limit = opts.maxFiles ?? MAX_SIDE_DIFF_FILES;
  const paths = res.files
    .map((f) => (typeof f?.path === 'string' ? f.path.trim() : ''))
    .filter((p) => p.length > 0)
    .slice(0, limit);
  if (paths.length === 0) return 0;

  const title = tr('msg.turnChangesTitle', { turn: opts.turn });
  const ref = `turn ${opts.turn}`;
  const firstOpts: OpenEditorOptions = {
    position: opts.panelId
      ? { referencePanel: opts.panelId, direction: 'right' }
      : { group: 'main', direction: 'right' },
    preview: false,
  };

  let opened = 0;
  for (let i = 0; i < paths.length; i++) {
    const filePath = paths[i];
    if (!filePath) continue;
    const input: TurnDiffEditorInput = {
      topicId: opts.topicId,
      path: filePath,
      ref,
      source: { title, fileUrl },
    };
    const openOpts: OpenEditorOptions = i === 0 ? firstOpts : { preview: false };
    try {
      opts.openDiffEditor(input, openOpts);
      opened++;
    } catch {
      if (opts.fallbackCommand) {
        await opts.fallbackCommand(input, openOpts);
        opened++;
      }
    }
  }
  return opened;
}
