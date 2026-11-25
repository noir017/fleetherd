export interface ButtonSpec {
  readonly id: string;
  readonly label?: string | null;
}

export interface WorkdirCrumb {
  readonly name: string;
  readonly path: string;
  readonly buttonId: string;
}

export interface WorkdirEntry {
  readonly name: string;
  readonly path: string;
  readonly enterId: string;
  readonly pickId: string;
  readonly current?: boolean;
  readonly root?: boolean;
}

export interface WorkdirCurrent {
  readonly path: string;
  readonly buttonId: string;
  readonly current?: boolean;
  readonly root?: boolean;
}

export interface WorkdirScreen {
  readonly agentId: string;
  readonly host?: string;
  readonly browsing: string;
  readonly breadcrumbs?: readonly WorkdirCrumb[];
  readonly parent?: { readonly path: string; readonly buttonId: string } | null;
  readonly home?: { readonly path: string; readonly buttonId: string } | null;
  readonly selectCurrent: WorkdirCurrent;
  readonly entries?: readonly WorkdirEntry[];
  readonly error?: string;
  readonly truncated: number;
}

export interface TurnChangeEntry {
  readonly turn: number;
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
  readonly truncated?: boolean;
}

export interface MessageQuote {
  readonly html: string;
  readonly id?: string;
}

export interface MessageFile {
  readonly name: string;
  readonly url: string;
  readonly image?: boolean;
  readonly view?: string;
}

export interface TranscriptMessage {
  readonly id: string;
  readonly own?: boolean;
  readonly html: string;
  readonly at: number;
  readonly buttons?: readonly ButtonSpec[];
  readonly settings?: unknown;
  readonly wasSettings?: boolean;
  readonly workdir?: WorkdirScreen;
  reactions?: string[];
  readonly quote?: MessageQuote;
  readonly file?: MessageFile;
  readonly nonce?: string;
  readonly kind?: string;
  readonly turnChanges?: TurnChangeEntry;
  readonly g?: number;
  _g?: number;
  readonly _local?: boolean;
  _state?: string;
  readonly _nonce?: string;
  readonly _text?: string;
}

export interface LaunchAgent {
  readonly id: string;
  readonly harness: string;
  readonly kind: string;
  readonly model?: string;
  readonly root?: string;
  readonly dirs?: readonly string[];
}

export interface LaunchGroup {
  readonly name: string;
  readonly agents: readonly LaunchAgent[];
}

export interface LaunchChoice {
  readonly current: string;
  readonly groups: readonly LaunchGroup[];
}

export interface OfflineMachine {
  readonly name: string;
  readonly since: number;
}

export interface TranscriptTopicLike {
  readonly id: string;
  readonly title?: string;
  readonly running?: boolean;
  readonly forkOf?: string;
  readonly forkTurn?: number;
  readonly dir?: { readonly host?: string; readonly path?: string } | null;
}

export interface TranscriptIcons {
  readonly icon: Readonly<Record<string, string>>;
  readonly mark: Readonly<Record<string, string>>;
  readonly reaction: Readonly<Record<string, string>>;
}

export type HighlightSpan = readonly [number, number, string];
export type HighlightFn = (src: string) => readonly HighlightSpan[];

export interface CodeViewModule {
  readonly highlighter?: (lang: string) => Promise<HighlightFn | null | undefined>;
}

export interface ToolOpenState {
  all: boolean;
  lines: Record<string, boolean>;
}

export interface ViewPosition {
  readonly key: string;
  readonly off: number;
}

export interface MsgMarkupResult {
  readonly cls: string;
  readonly h: string;
}

export interface GitWindowOptions {
  readonly title: string;
  readonly statusUrl: string;
  readonly fileUrl: string;
}
