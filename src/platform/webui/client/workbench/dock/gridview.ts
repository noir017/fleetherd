import { Emitter, type Event } from '../../base/event.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import type { GridNodeState } from '../contracts.js';
import { EditorGroup, type EditorGroupOptions } from './group.js';
import { type SplitOrientation, type SplitPaneInput, SplitView } from './splitview.js';

export type SplitDirection = 'left' | 'right' | 'above' | 'below';
export type GridBranchNode = Extract<GridNodeState, { readonly type: 'branch' }>;
export type GridLeafNode = Extract<GridNodeState, { readonly type: 'leaf' }>;
export type GridPath = readonly number[];

export interface GridRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GroupLocation {
  readonly node: GridLeafNode;
  readonly path: readonly number[];
}

export interface GridViewOptions {
  readonly container: HTMLElement;
  readonly doc?: Document;
  readonly initialTree?: GridNodeState;
  readonly minGroupSize?: number;
  readonly createGroupOptions?: (groupId: string) => Omit<EditorGroupOptions, 'id' | 'doc'>;
}

const DEFAULT_MIN_GROUP_SIZE = 160;
const DEFAULT_MIN_BRANCH_RATIO = 0.05;

export function createLeafNode(
  group: string,
  panels: readonly string[] = [],
  activePanel?: string,
): GridLeafNode {
  return {
    type: 'leaf',
    group,
    panels: [...panels],
    ...(activePanel !== undefined ? { activePanel } : {}),
  };
}

function normalizeWeights(rawSizes: readonly number[], count: number): number[] {
  if (count <= 0) return [];
  const positive: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const raw = rawSizes[i];
    const v = raw !== undefined && Number.isFinite(raw) && raw > 0 ? raw : 0;
    positive.push(v);
    sum += v;
  }
  if (sum <= 0) {
    const equal = 1 / count;
    return Array.from({ length: count }, () => equal);
  }
  const fallback = sum / count;
  let adjustedSum = 0;
  const filled = positive.map((v) => {
    const val = v > 0 ? v : fallback;
    adjustedSum += val;
    return val;
  });
  return filled.map((v) => v / adjustedSum);
}

function normalizeNode(node: GridNodeState): GridNodeState | undefined {
  if (node.type === 'leaf') return node;
  if (node.children.length === 0) return undefined;

  const baseWeights = normalizeWeights(node.sizes, node.children.length);
  const flatChildren: GridNodeState[] = [];
  const flatWeights: number[] = [];

  for (let i = 0; i < node.children.length; i++) {
    const normalizedChild = normalizeNode(node.children[i]!);
    if (!normalizedChild) continue;
    const weight = baseWeights[i]!;

    if (normalizedChild.type === 'branch' && normalizedChild.orientation === node.orientation) {
      const childWeights = normalizeWeights(normalizedChild.sizes, normalizedChild.children.length);
      for (let j = 0; j < normalizedChild.children.length; j++) {
        flatChildren.push(normalizedChild.children[j]!);
        flatWeights.push(weight * childWeights[j]!);
      }
    } else {
      flatChildren.push(normalizedChild);
      flatWeights.push(weight);
    }
  }

  if (flatChildren.length === 0) return undefined;
  if (flatChildren.length === 1) return flatChildren[0]!;

  return {
    type: 'branch',
    orientation: node.orientation,
    sizes: normalizeWeights(flatWeights, flatChildren.length),
    children: flatChildren,
  };
}

export function normalizeGrid(tree: GridNodeState): GridNodeState {
  return normalizeNode(tree) ?? createLeafNode('main');
}

export function findGroup(tree: GridNodeState, groupId: string): GroupLocation | undefined {
  const walk = (node: GridNodeState, path: number[]): GroupLocation | undefined => {
    if (node.type === 'leaf') {
      return node.group === groupId ? { node, path } : undefined;
    }
    for (let i = 0; i < node.children.length; i++) {
      const found = walk(node.children[i]!, [...path, i]);
      if (found) return found;
    }
    return undefined;
  };
  return walk(tree, []);
}

export function listGroups(tree: GridNodeState): readonly GridLeafNode[] {
  const out: GridLeafNode[] = [];
  const walk = (node: GridNodeState): void => {
    if (node.type === 'leaf') {
      out.push(node);
      return;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(tree);
  return out;
}

export function updateLeaf(
  tree: GridNodeState,
  groupId: string,
  updater: (leaf: GridLeafNode) => GridLeafNode,
): GridNodeState {
  if (tree.type === 'leaf') {
    return tree.group === groupId ? updater(tree) : tree;
  }
  let changed = false;
  const children = tree.children.map((child) => {
    const next = updateLeaf(child, groupId, updater);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...tree, children } : tree;
}

export function splitGroup(
  tree: GridNodeState,
  targetGroupId: string,
  newGroupId: string,
  direction: SplitDirection,
  newLeafInit?: { readonly panels?: readonly string[]; readonly activePanel?: string },
): GridNodeState {
  if (!targetGroupId || !newGroupId || targetGroupId === newGroupId) return tree;
  if (!findGroup(tree, targetGroupId) || findGroup(tree, newGroupId)) return tree;

  const orientation: SplitOrientation =
    direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
  const insertBefore = direction === 'left' || direction === 'above';
  const newLeaf = createLeafNode(newGroupId, newLeafInit?.panels ?? [], newLeafInit?.activePanel);

  const replace = (node: GridNodeState): GridNodeState => {
    if (node.type === 'leaf') {
      if (node.group !== targetGroupId) return node;
      return {
        type: 'branch',
        orientation,
        sizes: [0.5, 0.5],
        children: insertBefore ? [newLeaf, node] : [node, newLeaf],
      };
    }
    let changed = false;
    const children = node.children.map((child) => {
      const next = replace(child);
      if (next !== child) changed = true;
      return next;
    });
    return changed ? { ...node, children } : node;
  };

  return normalizeGrid(replace(tree));
}

export function removeGroup(tree: GridNodeState, groupId: string): GridNodeState | undefined {
  const prune = (node: GridNodeState): GridNodeState | undefined => {
    if (node.type === 'leaf') {
      return node.group === groupId ? undefined : node;
    }
    const nextChildren: GridNodeState[] = [];
    const nextSizes: number[] = [];
    const weights = normalizeWeights(node.sizes, node.children.length);
    let changed = false;

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]!;
      const pruned = prune(child);
      if (pruned !== child) changed = true;
      if (pruned) {
        nextChildren.push(pruned);
        nextSizes.push(weights[i]!);
      }
    }

    if (!changed) return node;
    if (nextChildren.length === 0) return undefined;
    return {
      type: 'branch',
      orientation: node.orientation,
      sizes: normalizeWeights(nextSizes, nextChildren.length),
      children: nextChildren,
    };
  };

  const pruned = prune(tree);
  return pruned ? normalizeNode(pruned) : undefined;
}

export function resizeBranch(
  tree: GridNodeState,
  path: GridPath,
  index: number,
  delta: number,
  minFraction = DEFAULT_MIN_BRANCH_RATIO,
): GridNodeState {
  if (!Number.isFinite(delta) || delta === 0) return tree;

  const apply = (node: GridNodeState, depth: number): GridNodeState => {
    if (node.type === 'leaf') return node;

    if (depth === path.length) {
      if (index < 0 || index >= node.children.length - 1) return node;
      const sizes =
        node.sizes.length === node.children.length
          ? node.sizes.slice()
          : normalizeWeights(node.sizes, node.children.length);
      const total = sizes.reduce((acc, v) => acc + v, 0);
      if (total <= 0) return node;

      const left = sizes[index]!;
      const right = sizes[index + 1]!;
      const pairSum = left + right;
      const safeMinFraction = Math.max(0, Math.min(0.49, Number.isFinite(minFraction) ? minFraction : 0));
      const minSize = Math.min(total * safeMinFraction, pairSum / 2);
      const nextLeft = Math.max(minSize, Math.min(pairSum - minSize, left + delta));
      const nextRight = pairSum - nextLeft;

      if (Math.abs(nextLeft - left) < 1e-9) return node;
      sizes[index] = nextLeft;
      sizes[index + 1] = nextRight;
      return { ...node, sizes };
    }

    const childIdx = path[depth];
    if (childIdx === undefined || childIdx < 0 || childIdx >= node.children.length) return node;
    const child = node.children[childIdx]!;
    const updated = apply(child, depth + 1);
    if (updated === child) return node;
    const children = node.children.slice();
    children[childIdx] = updated;
    return { ...node, children };
  };

  return apply(tree, 0);
}

function allocatePixels(weights: readonly number[], total: number): number[] {
  const safeTotal = Math.max(0, Math.round(Number.isFinite(total) ? total : 0));
  if (weights.length === 0) return [];
  if (safeTotal === 0) return weights.map(() => 0);

  const norm = normalizeWeights(weights, weights.length);
  const exact = norm.map((w) => w * safeTotal);
  const floors = exact.map((v) => Math.floor(v));
  let remainder = safeTotal - floors.reduce((acc, v) => acc + v, 0);

  const byFraction = exact
    .map((v, i) => ({ i, frac: v - floors[i]! }))
    .sort((a, b) => b.frac - a.frac);

  for (let k = 0; k < byFraction.length && remainder > 0; k++) {
    floors[byFraction[k]!.i]! += 1;
    remainder -= 1;
  }
  return floors;
}

export function computeGroupRects(
  tree: GridNodeState,
  width: number,
  height: number,
  maximizedGroupId?: string,
): ReadonlyMap<string, GridRect> {
  const safeW = Math.max(0, Math.round(Number.isFinite(width) ? width : 0));
  const safeH = Math.max(0, Math.round(Number.isFinite(height) ? height : 0));
  const rects = new Map<string, GridRect>();

  if (maximizedGroupId && findGroup(tree, maximizedGroupId)) {
    for (const leaf of listGroups(tree)) {
      rects.set(
        leaf.group,
        leaf.group === maximizedGroupId
          ? { x: 0, y: 0, width: safeW, height: safeH }
          : { x: 0, y: 0, width: 0, height: 0 },
      );
    }
    return rects;
  }

  const visit = (node: GridNodeState, x: number, y: number, w: number, h: number): void => {
    if (node.type === 'leaf') {
      rects.set(node.group, { x, y, width: w, height: h });
      return;
    }
    const span = node.orientation === 'horizontal' ? w : h;
    const pixels = allocatePixels(node.sizes, span);
    let offset = 0;
    for (let i = 0; i < node.children.length; i++) {
      const sz = pixels[i] ?? 0;
      if (node.orientation === 'horizontal') {
        visit(node.children[i]!, x + offset, y, sz, h);
      } else {
        visit(node.children[i]!, x, y + offset, w, sz);
      }
      offset += sz;
    }
  };

  visit(tree, 0, 0, safeW, safeH);
  return rects;
}

interface MountedBranch {
  readonly path: readonly number[];
  readonly orientation: SplitOrientation;
  readonly splitView: SplitView;
  readonly childNodes: readonly MountedNode[];
}

type MountedNode =
  | { readonly type: 'leaf'; readonly groupId: string }
  | { readonly type: 'branch'; readonly branch: MountedBranch };

export class GridView implements Disposable {
  readonly container: HTMLElement;

  private readonly _doc: Document;
  private readonly _minGroupSize: number;
  private readonly _createGroupOptions?: GridViewOptions['createGroupOptions'];

  private _tree: GridNodeState;
  private readonly _groups = new Map<string, EditorGroup>();
  private readonly _groupListeners = new Map<string, DisposableStore>();
  private _activeGroupId: string | undefined;
  private _maximizedGroupId: string | undefined;
  private _mountedRoot: MountedNode | undefined;
  private _width = 0;
  private _height = 0;
  private _nextGroupSeq = 1;
  private _layingOut = false;
  private _disposed = false;

  private readonly _disposables = new DisposableStore();
  private readonly _mountDisposables = new DisposableStore();
  private readonly _onDidLayoutChange = new Emitter<void>();
  private readonly _onDidActiveGroupChange = new Emitter<EditorGroup | undefined>();

  readonly onDidLayoutChange: Event<void> = this._onDidLayoutChange.event;
  readonly onDidActiveGroupChange: Event<EditorGroup | undefined> = this._onDidActiveGroupChange.event;

  constructor(options: GridViewOptions) {
    this.container = options.container;
    this._doc = options.doc ?? options.container.ownerDocument;
    this._minGroupSize = Math.max(40, options.minGroupSize ?? DEFAULT_MIN_GROUP_SIZE);
    this._createGroupOptions = options.createGroupOptions;
    this._tree = normalizeGrid(options.initialTree ?? createLeafNode('main'));

    this.container.classList.add('wb-gridview');
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.container.style.flex = '1 1 auto';
    this.container.style.minWidth = '0';
    this.container.style.minHeight = '0';

    this._disposables.add(this._mountDisposables);
    this._disposables.add(this._onDidLayoutChange);
    this._disposables.add(this._onDidActiveGroupChange);

    for (const leaf of listGroups(this._tree)) {
      this._ensureGroup(leaf.group);
    }
    const first = listGroups(this._tree)[0];
    if (first) {
      this._setActiveGroupInternal(first.group, false);
    }
    this._remount();
  }

  getGroup(groupId: string): EditorGroup | undefined {
    return this._groups.get(groupId);
  }

  getGroups(): readonly EditorGroup[] {
    return listGroups(this._tree)
      .map((leaf) => this._groups.get(leaf.group))
      .filter((g): g is EditorGroup => Boolean(g));
  }

  getActiveGroupId(): string | undefined {
    return this._activeGroupId;
  }

  getActiveGroup(): EditorGroup | undefined {
    return this._activeGroupId ? this._groups.get(this._activeGroupId) : undefined;
  }

  getMaximizedGroup(): string | undefined {
    return this._maximizedGroupId;
  }

  isMaximized(): boolean {
    return this._maximizedGroupId !== undefined;
  }

  getTree(): GridNodeState {
    const sync = (node: GridNodeState): GridNodeState => {
      if (node.type === 'leaf') {
        const group = this._groups.get(node.group);
        return group ? group.toLeafState() : node;
      }
      return {
        ...node,
        children: node.children.map(sync),
      };
    };
    return sync(this._tree);
  }

  setActiveGroup(groupId: string): void {
    if (!this._groups.has(groupId)) return;
    if (this._setActiveGroupInternal(groupId, true)) {
      this._onDidLayoutChange.fire();
    }
  }

  splitGroup(targetGroupId: string, direction: SplitDirection, newGroupId?: string): EditorGroup | undefined {
    if (this._disposed || !this._groups.has(targetGroupId)) return undefined;
    const id = newGroupId ?? this._allocateGroupId();
    if (this._groups.has(id)) return undefined;

    const nextTree = splitGroup(this._tree, targetGroupId, id, direction);
    if (nextTree === this._tree) return undefined;

    this._tree = nextTree;
    const created = this._ensureGroup(id);
    if (this._maximizedGroupId) {
      this._maximizedGroupId = undefined;
    }
    this._setActiveGroupInternal(id, true);
    this._remount();
    this._applyLayout();
    this._onDidLayoutChange.fire();
    return created;
  }

  removeGroup(groupId: string): boolean {
    if (this._disposed || !this._groups.has(groupId)) return false;
    const nextTree = removeGroup(this._tree, groupId);
    if (!nextTree) return false;

    this._destroyGroup(groupId);
    this._tree = nextTree;

    if (this._maximizedGroupId === groupId) {
      this._maximizedGroupId = undefined;
    }
    if (this._activeGroupId === groupId) {
      const fallback = listGroups(this._tree)[0];
      this._setActiveGroupInternal(fallback?.group, true);
    }

    this._remount();
    this._applyLayout();
    this._onDidLayoutChange.fire();
    return true;
  }

  maximizeGroup(groupId: string): void {
    if (this._disposed || !this._groups.has(groupId)) return;
    if (this._maximizedGroupId === groupId) return;
    this._maximizedGroupId = groupId;
    this._setActiveGroupInternal(groupId, true);
    this._remount();
    this._applyLayout();
    this._onDidLayoutChange.fire();
  }

  exitMaximized(): void {
    if (this._disposed || !this._maximizedGroupId) return;
    this._maximizedGroupId = undefined;
    this._remount();
    this._applyLayout();
    this._onDidLayoutChange.fire();
  }

  setTree(tree: GridNodeState, activeGroupId?: string, maximizedGroupId?: string): void {
    if (this._disposed) return;
    const normalized = normalizeGrid(tree);
    const wantedIds = new Set(listGroups(normalized).map((leaf) => leaf.group));

    for (const id of [...this._groups.keys()]) {
      if (!wantedIds.has(id)) {
        this._destroyGroup(id);
      }
    }
    for (const leaf of listGroups(normalized)) {
      this._ensureGroup(leaf.group);
    }

    this._tree = normalized;
    this._maximizedGroupId =
      maximizedGroupId && wantedIds.has(maximizedGroupId) ? maximizedGroupId : undefined;

    const nextActive =
      activeGroupId && wantedIds.has(activeGroupId)
        ? activeGroupId
        : listGroups(normalized)[0]?.group;
    this._setActiveGroupInternal(nextActive, true);

    this._remount();
    this._applyLayout();
    this._onDidLayoutChange.fire();
  }

  layout(width: number, height: number): void {
    if (this._disposed) return;
    this._width = Math.max(0, Math.round(Number.isFinite(width) ? width : 0));
    this._height = Math.max(0, Math.round(Number.isFinite(height) ? height : 0));
    this._applyLayout();
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._mountDisposables.clear();
    this._mountedRoot = undefined;
    for (const id of [...this._groups.keys()]) {
      this._destroyGroup(id);
    }
    this.container.replaceChildren();
    this._disposables.dispose();
  }

  private _allocateGroupId(): string {
    while (this._groups.has(`g${this._nextGroupSeq}`)) {
      this._nextGroupSeq += 1;
    }
    const id = `g${this._nextGroupSeq}`;
    this._nextGroupSeq += 1;
    return id;
  }

  private _ensureGroup(groupId: string): EditorGroup {
    const existing = this._groups.get(groupId);
    if (existing) return existing;

    const extra = this._createGroupOptions?.(groupId) ?? {};
    const group = new EditorGroup({ ...extra, id: groupId, doc: this._doc });
    const listeners = new DisposableStore();
    listeners.add(
      group.onDidFocus(() => {
        this.setActiveGroup(groupId);
      }),
    );
    this._groups.set(groupId, group);
    this._groupListeners.set(groupId, listeners);
    return group;
  }

  private _destroyGroup(groupId: string): void {
    const listeners = this._groupListeners.get(groupId);
    listeners?.dispose();
    this._groupListeners.delete(groupId);

    const group = this._groups.get(groupId);
    group?.dispose();
    this._groups.delete(groupId);
  }

  private _setActiveGroupInternal(groupId: string | undefined, emit: boolean): boolean {
    if (this._activeGroupId === groupId) return false;
    this._activeGroupId = groupId;
    for (const [id, group] of this._groups) {
      group.setActive(id === groupId);
    }
    if (emit) {
      this._onDidActiveGroupChange.fire(groupId ? this._groups.get(groupId) : undefined);
    }
    return true;
  }

  private _remount(): void {
    this._mountDisposables.clear();
    this._mountedRoot = undefined;
    this.container.replaceChildren();
    this.container.dataset.maximized = String(Boolean(this._maximizedGroupId));

    for (const group of this._groups.values()) {
      group.element.style.width = '';
      group.element.style.height = '';
      group.element.style.flex = '';
    }

    if (this._maximizedGroupId && this._groups.has(this._maximizedGroupId)) {
      for (const [id, group] of this._groups) {
        const isMax = id === this._maximizedGroupId;
        group.setVisible(isMax);
        if (isMax) {
          group.element.style.flex = '1 1 auto';
          this.container.appendChild(group.element);
        }
      }
      this._mountedRoot = { type: 'leaf', groupId: this._maximizedGroupId };
      return;
    }

    for (const group of this._groups.values()) {
      group.setVisible(true);
    }

    const { element, mounted } = this._mountNode(this._tree, []);
    element.style.flex = '1 1 auto';
    this.container.appendChild(element);
    this._mountedRoot = mounted;
  }

  private _mountNode(
    node: GridNodeState,
    path: readonly number[],
  ): { element: HTMLElement; mounted: MountedNode } {
    if (node.type === 'leaf') {
      const group = this._ensureGroup(node.group);
      return {
        element: group.element,
        mounted: { type: 'leaf', groupId: node.group },
      };
    }

    const branchEl = this._doc.createElement('div');
    branchEl.className = 'wb-grid-branch';
    branchEl.style.display = 'flex';
    branchEl.style.flexDirection = node.orientation === 'horizontal' ? 'row' : 'column';
    branchEl.style.minWidth = '0';
    branchEl.style.minHeight = '0';

    const weights = normalizeWeights(node.sizes, node.children.length);
    const childNodes: MountedNode[] = [];
    const panes: SplitPaneInput[] = [];

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]!;
      const res = this._mountNode(child, [...path, i]);
      childNodes.push(res.mounted);
      panes.push({
        id: child.type === 'leaf' ? child.group : `branch-${path.join('-')}-${i}`,
        element: res.element,
        minSize: this._minGroupSize,
        defaultSize: Math.max(this._minGroupSize, Math.round(weights[i]! * 1000)),
        size: Math.max(this._minGroupSize, Math.round(weights[i]! * 1000)),
      });
    }

    const splitView = new SplitView({
      container: branchEl,
      orientation: node.orientation,
      panes,
    });
    this._mountDisposables.add(splitView);

    const mountedBranch: MountedBranch = {
      path,
      orientation: node.orientation,
      splitView,
      childNodes,
    };

    this._mountDisposables.add(
      splitView.onDidChange((sizes) => {
        if (this._layingOut) return;
        this._syncBranchSizesFromSplit(path, sizes);
        this._applyLayout();
        this._onDidLayoutChange.fire();
      }),
    );

    return {
      element: branchEl,
      mounted: { type: 'branch', branch: mountedBranch },
    };
  }

  private _syncBranchSizesFromSplit(path: readonly number[], sizes: readonly number[]): void {
    const normalized = normalizeWeights(sizes, sizes.length);
    const update = (node: GridNodeState, depth: number): GridNodeState => {
      if (node.type === 'leaf') return node;
      if (depth === path.length) {
        if (normalized.length !== node.children.length) return node;
        return { ...node, sizes: normalized };
      }
      const idx = path[depth];
      if (idx === undefined || idx < 0 || idx >= node.children.length) return node;
      const child = node.children[idx]!;
      const next = update(child, depth + 1);
      if (next === child) return node;
      const children = node.children.slice();
      children[idx] = next;
      return { ...node, children };
    };
    this._tree = update(this._tree, 0);
  }

  private _applyLayout(): void {
    if (!this._mountedRoot) return;
    if (this._width === 0 && this._height === 0) return;

    this._layingOut = true;
    try {
      const rects = computeGroupRects(this._tree, this._width, this._height, this._maximizedGroupId);
      if (this._mountedRoot.type === 'branch') {
        this._layoutMountedBranch(this._mountedRoot.branch, this._width, this._height);
      }
      for (const [groupId, rect] of rects) {
        this._groups.get(groupId)?.layout(rect.width, rect.height);
      }
    } finally {
      this._layingOut = false;
    }
  }

  private _layoutMountedBranch(branch: MountedBranch, width: number, height: number): void {
    const span = branch.orientation === 'horizontal' ? width : height;
    const node = this._findBranchAtPath(this._tree, branch.path);
    if (node && span > 0) {
      const pixels = allocatePixels(node.sizes, span);
      for (let i = 0; i < branch.childNodes.length; i++) {
        const child = branch.childNodes[i]!;
        const paneId = child.type === 'leaf' ? child.groupId : `branch-${branch.path.join('-')}-${i}`;
        branch.splitView.setPaneSize(paneId, pixels[i] ?? this._minGroupSize);
      }
    }
    const sizes = branch.splitView.layout(span);
    for (let i = 0; i < branch.childNodes.length; i++) {
      const child = branch.childNodes[i]!;
      if (child.type !== 'branch') continue;
      const sz = sizes[i] ?? 0;
      const childW = branch.orientation === 'horizontal' ? sz : width;
      const childH = branch.orientation === 'horizontal' ? height : sz;
      this._layoutMountedBranch(child.branch, childW, childH);
    }
  }

  private _findBranchAtPath(node: GridNodeState, path: readonly number[]): GridBranchNode | undefined {
    let cur: GridNodeState = node;
    for (const idx of path) {
      if (cur.type !== 'branch') return undefined;
      const next = cur.children[idx];
      if (!next) return undefined;
      cur = next;
    }
    return cur.type === 'branch' ? cur : undefined;
  }
}
