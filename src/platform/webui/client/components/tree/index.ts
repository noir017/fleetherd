import { focusSafely } from '../../base/dom.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { type Disposable } from '../../base/lifecycle.js';
import { escapeAttrValue, type IconInput, renderIcon } from '../shared.js';

export interface TreeNode<T = unknown> {
  readonly id: string;
  readonly label: string;
  readonly icon?: IconInput;
  readonly children?: readonly TreeNode<T>[];
  readonly hasChildren?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly data?: T;
}

export interface TreeNodeRenderState {
  readonly depth: number;
  readonly expanded: boolean;
  readonly selected: boolean;
  readonly isBranch: boolean;
}

export interface TreeOptions<T = unknown> {
  readonly nodes: readonly TreeNode<T>[];
  readonly expandedIds?: Iterable<string>;
  readonly selectedId?: string | null;
  readonly indentPx?: number;
  readonly ariaLabel?: string;
  readonly chevronRightIcon?: IconInput;
  readonly chevronDownIcon?: IconInput;
  readonly className?: string;
  readonly renderNode?: (node: TreeNode<T>, state: TreeNodeRenderState) => TemplateResult;
  readonly onSelect?: (node: TreeNode<T>) => void;
  readonly onActivate?: (node: TreeNode<T>) => void;
  readonly onToggle?: (node: TreeNode<T>, expanded: boolean) => void;
}

export interface TreeController<T = unknown> extends Disposable {
  readonly el: HTMLElement;
  setNodes(nodes: readonly TreeNode<T>[]): void;
  setExpanded(id: string, expanded: boolean): void;
  toggle(id: string): void;
  expandAll(): void;
  collapseAll(): void;
  setSelected(id: string | null): void;
  getSelected(): string | null;
  getExpandedIds(): ReadonlySet<string>;
}

interface FlatTreeEntry<T> {
  readonly node: TreeNode<T>;
  readonly depth: number;
  readonly parentId: string | null;
  readonly isBranch: boolean;
  readonly expanded: boolean;
}

function isBranchNode<T>(node: TreeNode<T>): boolean {
  return Boolean(node.hasChildren || (node.children && node.children.length > 0));
}

function flattenVisible<T>(
  nodes: readonly TreeNode<T>[],
  expanded: ReadonlySet<string>,
  depth = 0,
  parentId: string | null = null,
  out: FlatTreeEntry<T>[] = [],
): FlatTreeEntry<T>[] {
  for (const node of nodes) {
    const branch = isBranchNode(node);
    const isExp = branch && expanded.has(node.id);
    out.push({ node, depth, parentId, isBranch: branch, expanded: isExp });
    if (isExp && node.children && node.children.length > 0) {
      flattenVisible(node.children, expanded, depth + 1, node.id, out);
    }
  }
  return out;
}

function collectBranchIds<T>(nodes: readonly TreeNode<T>[], out: Set<string>): void {
  for (const node of nodes) {
    if (isBranchNode(node)) {
      out.add(node.id);
      if (node.children) collectBranchIds(node.children, out);
    }
  }
}

function findNodeById<T>(nodes: readonly TreeNode<T>[], id: string): TreeNode<T> | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findNodeById(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

function findVerticalTarget<T>(
  visible: readonly FlatTreeEntry<T>[],
  currentId: string,
  key: string,
): FlatTreeEntry<T> | undefined {
  const enabled = visible.filter((v) => !v.node.disabled);
  if (enabled.length === 0) return undefined;
  const pos = enabled.findIndex((v) => v.node.id === currentId);
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled[enabled.length - 1];
  if (key === 'ArrowDown') return enabled[Math.min(enabled.length - 1, pos + 1)];
  if (key === 'ArrowUp') return enabled[Math.max(0, pos - 1)];
  return undefined;
}

interface TreeRowContext<T> {
  readonly opts: TreeOptions<T>;
  readonly indentPx: number;
  readonly selectedId: string | null;
  readonly firstEnabledId: string | null;
  readonly visible: readonly FlatTreeEntry<T>[];
  readonly onRowClick: (entry: FlatTreeEntry<T>) => void;
  readonly onTwistClick: (entry: FlatTreeEntry<T>) => void;
  readonly onKeydown: (entry: FlatTreeEntry<T>, idx: number, ev: KeyboardEvent) => void;
}

function renderTreeTwist<T>(entry: FlatTreeEntry<T>, ctx: TreeRowContext<T>): TemplateResult {
  if (!entry.isBranch) {
    return html`<span class="fh-tree-twist fh-tree-twist--leaf" aria-hidden="true"></span>`;
  }
  const icon = entry.expanded
    ? (ctx.opts.chevronDownIcon ? renderIcon(ctx.opts.chevronDownIcon, 'fh-icon') : html`▾`)
    : (ctx.opts.chevronRightIcon ? renderIcon(ctx.opts.chevronRightIcon, 'fh-icon') : html`▸`);
  return html`<span
    class=${`fh-tree-twist${entry.expanded ? ' is-open' : ''}`}
    aria-hidden="true"
    @click=${(ev: MouseEvent) => {
      ev.stopPropagation();
      ctx.onTwistClick(entry);
    }}
  >${icon}</span>`;
}

function renderTreeRow<T>(entry: FlatTreeEntry<T>, idx: number, ctx: TreeRowContext<T>): TemplateResult {
  const isSel = entry.node.id === ctx.selectedId;
  const isTabStop = entry.node.id === ctx.selectedId || (ctx.selectedId === null && entry.node.id === ctx.firstEnabledId);
  const rowCls = [
    'fh-tree-row',
    isSel ? 'is-selected' : '',
    entry.node.disabled ? 'is-disabled' : '',
    entry.node.className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const padLeft = 8 + entry.depth * ctx.indentPx;
  return html`<div
    class=${rowCls}
    role="treeitem"
    data-tree-id=${entry.node.id}
    aria-level=${String(entry.depth + 1)}
    aria-selected=${isSel ? 'true' : 'false'}
    aria-expanded=${entry.isBranch ? (entry.expanded ? 'true' : 'false') : nothing}
    aria-disabled=${entry.node.disabled ? 'true' : nothing}
    tabindex=${entry.node.disabled ? '-1' : isTabStop ? '0' : '-1'}
    style=${`padding-left:${padLeft}px`}
    @click=${() => ctx.onRowClick(entry)}
    @keydown=${(ev: KeyboardEvent) => ctx.onKeydown(entry, idx, ev)}
  >
    ${renderTreeTwist(entry, ctx)}
    ${ctx.opts.renderNode
      ? ctx.opts.renderNode(entry.node, {
          depth: entry.depth,
          expanded: entry.expanded,
          selected: isSel,
          isBranch: entry.isBranch,
        })
      : html`${renderIcon(entry.node.icon, 'fh-tree-icon')}<span class="fh-tree-label">${entry.node.label}</span>`}
  </div>`;
}

function handleHorizontalTreeKey<T>(
  key: 'ArrowRight' | 'ArrowLeft',
  entry: FlatTreeEntry<T>,
  visible: readonly FlatTreeEntry<T>[],
  idx: number,
  actions: {
    setExpanded: (node: TreeNode<T>, next: boolean) => void;
    focusNode: (id: string) => void;
    selectEntry: (target: FlatTreeEntry<T>, focus: boolean) => void;
  },
): void {
  if (key === 'ArrowRight') {
    if (!entry.isBranch) return;
    if (!entry.expanded) {
      actions.setExpanded(entry.node, true);
      actions.focusNode(entry.node.id);
      return;
    }
    const nextChild = visible[idx + 1];
    if (nextChild && nextChild.parentId === entry.node.id && !nextChild.node.disabled) {
      actions.selectEntry(nextChild, true);
    }
    return;
  }
  if (entry.isBranch && entry.expanded) {
    actions.setExpanded(entry.node, false);
    actions.focusNode(entry.node.id);
    return;
  }
  if (entry.parentId) {
    const parent = visible.find((v) => v.node.id === entry.parentId);
    if (parent) actions.selectEntry(parent, true);
  }
}

export function createTree<T = unknown>(
  opts: TreeOptions<T>,
  doc: Document = document,
): TreeController<T> {
  const host = doc.createElement('div');
  host.className = 'fh-tree-host';

  let nodes: readonly TreeNode<T>[] = opts.nodes;
  const expanded = new Set<string>(opts.expandedIds ?? []);
  let selectedId: string | null = opts.selectedId ?? null;
  const indentPx = opts.indentPx ?? 14;

  const focusNode = (id: string): void => {
    const el = host.querySelector<HTMLElement>(`[data-tree-id="${escapeAttrValue(id)}"]`);
    focusSafely(el);
  };

  const setExpandedState = (node: TreeNode<T>, next: boolean): void => {
    const was = expanded.has(node.id);
    if (was === next) return;
    if (next) expanded.add(node.id);
    else expanded.delete(node.id);
    paint();
    opts.onToggle?.(node, next);
  };

  const selectEntry = (entry: FlatTreeEntry<T>, focus = false): void => {
    selectedId = entry.node.id;
    paint();
    if (focus) focusNode(entry.node.id);
    opts.onSelect?.(entry.node);
  };

  const handleKeydown = (
    entry: FlatTreeEntry<T>,
    visible: readonly FlatTreeEntry<T>[],
    idx: number,
    ev: KeyboardEvent,
  ): void => {
    const vertical = findVerticalTarget(visible, entry.node.id, ev.key);
    if (vertical) {
      ev.preventDefault();
      selectEntry(vertical, true);
      return;
    }
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      ev.preventDefault();
      handleHorizontalTreeKey(ev.key, entry, visible, idx, {
        setExpanded: setExpandedState,
        focusNode,
        selectEntry,
      });
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      selectEntry(entry, false);
      if (entry.isBranch && ev.key === ' ') setExpandedState(entry.node, !entry.expanded);
      else opts.onActivate?.(entry.node);
    }
  };

  const paint = (): void => {
    const visible = flattenVisible(nodes, expanded);
    const firstEnabledId = visible.find((v) => !v.node.disabled)?.node.id ?? null;
    const cls = `fh-tree${opts.className ? ` ${opts.className}` : ''}`;
    const rowCtx: TreeRowContext<T> = {
      opts,
      indentPx,
      selectedId,
      firstEnabledId,
      visible,
      onRowClick: (entry) => {
        if (entry.node.disabled) return;
        selectEntry(entry, false);
        if (entry.isBranch) setExpandedState(entry.node, !entry.expanded);
        opts.onActivate?.(entry.node);
      },
      onTwistClick: (entry) => {
        if (!entry.node.disabled) setExpandedState(entry.node, !entry.expanded);
      },
      onKeydown: (entry, idx, ev) => handleKeydown(entry, visible, idx, ev),
    };
    render(
      html`<div class=${cls} role="tree" aria-label=${opts.ariaLabel ?? nothing}>
        ${visible.map((entry, idx) => renderTreeRow(entry, idx, rowCtx))}
      </div>`,
      host,
    );
  };

  paint();

  return {
    el: host,
    setNodes(next): void {
      nodes = next;
      paint();
    },
    setExpanded(id, next): void {
      const node = findNodeById(nodes, id);
      if (node) setExpandedState(node, next);
    },
    toggle(id): void {
      const node = findNodeById(nodes, id);
      if (node) setExpandedState(node, !expanded.has(id));
    },
    expandAll(): void {
      collectBranchIds(nodes, expanded);
      paint();
    },
    collapseAll(): void {
      expanded.clear();
      paint();
    },
    setSelected(id): void {
      selectedId = id;
      paint();
    },
    getSelected(): string | null {
      return selectedId;
    },
    getExpandedIds(): ReadonlySet<string> {
      return new Set(expanded);
    },
    dispose(): void {
      render(nothing, host);
      host.remove();
    },
  };
}
