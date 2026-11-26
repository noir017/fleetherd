import type { Event } from '../base/event.js';
import type { Disposable } from '../base/lifecycle.js';

export type PartId = 'sidebar' | 'secondary' | 'panel';

export type Direction = 'left' | 'right' | 'above' | 'below' | 'within';

export type PanelPosition =
  | { readonly part: PartId; readonly index?: number }
  | { readonly group: string; readonly direction?: Direction; readonly index?: number }
  | { readonly referencePanel: string; readonly direction: Direction };

export interface PanelInitContext {
  readonly id: string;
  readonly api: PanelRef;
}

export interface PanelComponent {
  readonly element: HTMLElement;
  init(params: unknown, ctx: PanelInitContext): void;
  update?(params: unknown): void;
  focus?(): void;
  dispose(): void;
}

export interface PanelRef {
  readonly id: string;
  readonly group: string | PartId;
  readonly params: unknown;
  readonly isVisible?: boolean;
  readonly onDidVisibilityChange: Event<boolean>;
  readonly onDidDimensionsChange: Event<{ readonly width: number; readonly height: number }>;
  setTitle(title: string): void;
  setBadge(n: number | null): void;
  focus(): void;
  close(): void;
}

export interface AddPanelOptions {
  readonly id: string;
  readonly component: string;
  readonly title: string;
  readonly params?: unknown;
  readonly position?: PanelPosition;
}

export interface PartLayoutState {
  readonly visible: boolean;
  readonly size: number;
  readonly activePanel?: string;
  readonly panels: readonly string[];
}

export type GridNodeState =
  | {
      readonly type: 'branch';
      readonly orientation: 'horizontal' | 'vertical';
      readonly sizes: readonly number[];
      readonly children: readonly GridNodeState[];
    }
  | {
      readonly type: 'leaf';
      readonly group: string;
      readonly panels: readonly string[];
      readonly activePanel?: string;
    };

export interface PanelLayoutState {
  readonly id: string;
  readonly component: string;
  readonly title: string;
  readonly params?: unknown;
}

export interface LayoutState {
  readonly v: 1;
  readonly parts: Record<PartId, PartLayoutState>;
  readonly grid: GridNodeState;
  readonly panels: Record<string, PanelLayoutState>;
  readonly activeGroup?: string;
  readonly maximizedGroup?: string;
}

export interface DockEngine extends Disposable {
  readonly onDidLayoutChange: Event<void>;
  readonly onDidActivePanelChange: Event<PanelRef | undefined>;
  registerComponent(name: string, factory: () => PanelComponent): Disposable;
  addPanel(o: AddPanelOptions): PanelRef;
  getPanel(id: string): PanelRef | undefined;
  removePanel(id: string): void;
  movePanel(id: string, to: PanelPosition): void;
  setPartVisible(part: PartId, visible: boolean): void;
  maximizeGroup(group: string): void;
  exitMaximized(): void;
  toJSON(): LayoutState;
  fromJSON(state: LayoutState): void;
  layout(width: number, height: number): void;
}
