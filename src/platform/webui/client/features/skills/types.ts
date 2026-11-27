import type {
  SkillPanelDetail,
  SkillPanelEntry,
  SkillPanelHistoryEntry,
  SkillPanelSearches,
} from '../../../../adapter.js';
import type { CodeViewApi } from '../../../codeview/app.js';
import type { ViewContribution } from '../../plugins/api.js';
import type { OverlayManager } from '../../services/overlays.js';

export type SkillPanelComponent = ReturnType<ViewContribution['component']>;
export type SkillPanelInitContext = Parameters<SkillPanelComponent['init']>[1];

export interface SkillEditorInput {
  readonly name: string;
  readonly file?: string;
}

export interface SkillListResponse {
  readonly enabled?: boolean;
  readonly skills?: SkillPanelEntry[];
  readonly searches?: SkillPanelSearches | null;
}

export interface SkillOpResponse {
  readonly ok?: boolean;
  readonly error?: string;
  readonly skills?: SkillPanelEntry[];
  readonly detail?: SkillPanelDetail;
}

export interface SkillsPluginDeps {
  readonly icons?: () => Readonly<Record<string, string>>;
  readonly formatAgo?: (at: number) => string;
  readonly formatBytes?: (bytes: number) => string;
  readonly copyText?: (value: string) => boolean | Promise<boolean>;
  readonly codeView?: () => Promise<CodeViewApi | null>;
  readonly confirm?: (message: string) => boolean | Promise<boolean>;
  readonly doc?: Document;
  readonly overlays?: OverlayManager;
  readonly enabled?: () => boolean;
  readonly activityOrder?: number;
  readonly loadHistoryContent?: (
    skillName: string,
    entry: SkillPanelHistoryEntry,
    filePath: string,
  ) => Promise<string | null> | string | null;
}

export interface ResolvedSkillsDeps {
  readonly icons: () => Readonly<Record<string, string>>;
  readonly formatAgo: (at: number) => string;
  readonly formatBytes: (bytes: number) => string;
  readonly copyText: (value: string) => Promise<boolean>;
  readonly codeView: () => Promise<CodeViewApi | null>;
  readonly confirm?: (message: string) => boolean | Promise<boolean>;
  readonly doc: Document;
  readonly overlays?: OverlayManager;
  readonly enabled?: () => boolean;
  readonly activityOrder: number;
  readonly loadHistoryContent?: (
    skillName: string,
    entry: SkillPanelHistoryEntry,
    filePath: string,
  ) => Promise<string | null> | string | null;
}

const FALLBACK_SVG_PATHS: Readonly<Record<string, string>> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01"/><path d="M20.5 3.5V9H15"/>',
  copy:
    '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M5 15h-.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/>',
  check: '<path d="m4.5 12.5 5 5L19.5 7"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  cross: '<path d="M6 6l12 12M18 6 6 18"/>',
  filter: '<path d="M3.5 5h17l-6.5 7.5V19l-4 1.5v-8z"/>',
  sort: '<path d="M8 20V4M4.5 7.5 8 4l3.5 3.5M16 4v16M12.5 16.5 16 20l3.5-3.5"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  book: '<path d="M12 6.5C10 5 7 4.6 3 5v13c4-.4 7 0 9 1.5 2-1.5 5-1.9 9-1.5V5c-4-.4-7 0-9 1.5zM12 6.5v13"/>',
  undo: '<path d="M9 6 4 11l5 5"/><path d="M4 11h10.5a5 5 0 0 1 0 10H11"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5v-2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6 6.5l.9 12.6a1.5 1.5 0 0 0 1.5 1.4h7.2a1.5 1.5 0 0 0 1.5-1.4L18 6.5M10 10.5v6M14 10.5v6"/>',
  pin: '<path d="M15 4.5 19.5 9l-3 1.5-3.5 3.5.5 4.5-3-3-5.5 5.5 5.5-5.5-3-3 4.5.5 3.5-3.5z"/>',
  file: '<path d="M6 3.5h8l4 4v13a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20.5v-15A1.5 1.5 0 0 1 6.5 3.5z"/><path d="M14 3.5V8h4"/>',
};

function fallbackSvg(name: string): string {
  const path = FALLBACK_SVG_PATHS[name];
  if (!path) return '';
  return (
    `<svg class="ic ic-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
  );
}

export function getSkillIcon(icons: Readonly<Record<string, string>>, name: string): string {
  return icons[name] || fallbackSvg(name);
}

export function defaultFormatAgo(at: number): string {
  if (!at || !Number.isFinite(at)) return '';
  const diffSec = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDays = Math.round(diffHr / 24);
  return `${diffDays}d`;
}

export function defaultFormatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function defaultCopyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to false when clipboard access is unavailable.
  }
  return false;
}

export function resolveSkillsDeps(deps: SkillsPluginDeps = {}): ResolvedSkillsDeps {
  return {
    icons: deps.icons ?? (() => ({})),
    formatAgo: deps.formatAgo ?? defaultFormatAgo,
    formatBytes: deps.formatBytes ?? defaultFormatBytes,
    copyText: deps.copyText
      ? async (v) => Boolean(await deps.copyText?.(v))
      : defaultCopyText,
    codeView: deps.codeView ?? (() => Promise.resolve(null)),
    confirm: deps.confirm,
    doc: deps.doc ?? document,
    overlays: deps.overlays,
    enabled: deps.enabled,
    activityOrder: deps.activityOrder ?? 40,
    loadHistoryContent: deps.loadHistoryContent,
  };
}

export function formatIsoAgo(iso: string | undefined, formatAgo: (at: number) => string): string {
  const at = iso ? Date.parse(iso) : 0;
  return at ? formatAgo(at) : '';
}

export function isSkillActive(entry: SkillPanelEntry): boolean {
  return entry.status !== 'archived';
}

export function parseSkillEditorInput(input: unknown): SkillEditorInput | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  if (typeof rec.name !== 'string' || !rec.name.trim()) return null;
  const file = typeof rec.file === 'string' && rec.file.trim() ? rec.file.trim() : undefined;
  return file ? { name: rec.name.trim(), file } : { name: rec.name.trim() };
}
