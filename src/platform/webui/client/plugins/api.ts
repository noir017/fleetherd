import type { Disposable, DisposableStore } from '../base/lifecycle.js';
import type { PanelComponent, PanelPosition, PartId } from '../workbench/contracts.js';

export type MenuLocation = 'topic.row' | 'topic.title' | 'task.row' | 'message';

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly title?: string;
  readonly group?: string;
  readonly order?: number;
  readonly danger?: boolean;
  readonly when?: (target: unknown) => boolean;
  readonly disabled?: (target: unknown) => boolean | string;
  run(target: unknown): void | Promise<void>;
}

export interface TopicInfo {
  readonly id: string;
  readonly title: string;
  readonly lastAt: number;
  readonly last?: string;
  readonly starred?: boolean;
  readonly running?: boolean;
  readonly runningSince?: number;
  readonly asking?: boolean;
  readonly live?: boolean;
  readonly msgCount?: number;
  readonly term?: boolean;
  readonly dir?: { readonly name: string; readonly path: string; readonly host?: string };
  readonly agent?: { readonly id: string; readonly harness: string; readonly canFork?: boolean };
  readonly parent?: string;
  readonly forkOf?: string;
  readonly forkTurn?: number;
  readonly stage?: string;
  readonly scheduled?: boolean;
  readonly task?: string;
}

export interface WebuiEvents {
  'topic.active': { readonly id: string | undefined; readonly topic: TopicInfo | undefined };
  'topic.list': { readonly topics: readonly TopicInfo[] };
  'topic.message': { readonly topicId: string; readonly message: unknown };
  'topic.turnEnd': { readonly topicId: string };
  'stream.state': { readonly state: 'connecting' | 'open' | 'reconnecting' | 'parked' | 'closed' };
  'locale.change': { readonly locale: string };
  'theme.change': { readonly theme: string };
  [key: `plugin:${string}:${string}`]: unknown;
}

export interface ViewContribution {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly part: PartId;
  component(): PanelComponent;
  when?(): boolean;
}

export interface EditorContribution {
  readonly kind: string;
  component(): PanelComponent;
  title(input: unknown): string;
}

export interface OpenEditorOptions {
  readonly id?: string;
  readonly position?: PanelPosition;
  readonly preview?: boolean;
}

export interface TopicToolContribution {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly defaultPart: PartId;
  available(topic: TopicInfo): boolean;
  component(): PanelComponent;
}

export interface ActivityContribution {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly view: string;
  badge?(): number | 'dot' | null;
  readonly order?: number;
}

export interface StatusBarContribution {
  readonly id: string;
  readonly align: 'left' | 'right';
  readonly order?: number;
  render(el: HTMLElement): void;
  onClick?(): void;
}

export interface CommandMeta {
  readonly title?: string;
  readonly keybinding?: string;
}

export interface SettingsSectionContribution {
  readonly id: string;
  readonly title: string;
  readonly scope: 'device';
  component(): PanelComponent;
}

export interface PluginContext {
  readonly id: string;
  readonly subscriptions: DisposableStore;
  readonly views: {
    register(v: ViewContribution): Disposable;
  };
  readonly editors: {
    register(e: EditorContribution): Disposable;
    open(kind: string, input: unknown, opts?: OpenEditorOptions): void;
  };
  readonly topicTools: {
    register(t: TopicToolContribution): Disposable;
  };
  readonly activity: {
    register(a: ActivityContribution): Disposable;
  };
  readonly statusBar: {
    register(s: StatusBarContribution): Disposable;
  };
  readonly commands: {
    register(id: string, run: (...a: unknown[]) => unknown, meta?: CommandMeta): Disposable;
    execute(id: string, ...a: unknown[]): Promise<unknown>;
  };
  readonly menus: {
    register(where: MenuLocation, item: MenuItem): Disposable;
  };
  readonly settings: {
    registerSection(s: SettingsSectionContribution): Disposable;
  };
  readonly events: {
    on<K extends keyof WebuiEvents>(k: K, cb: (e: WebuiEvents[K]) => void): Disposable;
  };
  readonly topics: {
    list(): readonly TopicInfo[];
    active(): TopicInfo | undefined;
    open(id: string): void;
    insertIntoComposer(id: string, text: string): void;
  };
  readonly api: {
    get<T>(path: string): Promise<T>;
    post<T>(path: string, body: unknown): Promise<T>;
  };
  readonly storage: {
    get<T>(k: string): T | undefined;
    set(k: string, v: unknown): void;
  };
  readonly i18n: {
    add(locale: string, dict: Record<string, string>): void;
    t(key: string, vars?: Record<string, unknown>): string;
  };
  readonly html: typeof import('lit-html').html;
  readonly render: typeof import('lit-html').render;
}

export interface WebuiPlugin {
  readonly id: string;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void;
}

export function definePlugin(plugin: WebuiPlugin): WebuiPlugin {
  return plugin;
}
