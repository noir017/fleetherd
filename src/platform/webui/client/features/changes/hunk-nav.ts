export interface DiffHunk {
  readonly index: number;
  readonly header: string;
  readonly oldStart: number;
  readonly newStart: number;
}

export interface HunkNavState {
  readonly activeIndex: number;
  readonly total: number;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function extractPatchHunks(patch: string): DiffHunk[] {
  if (!patch) return [];
  const hunks: DiffHunk[] = [];
  for (const line of patch.split('\n')) {
    const match = HUNK_HEADER_RE.exec(line);
    if (!match) continue;
    hunks.push({
      index: hunks.length,
      header: line,
      oldStart: Number(match[1]),
      newStart: Number(match[2]),
    });
  }
  return hunks;
}

export function computeTextHunks(original: string, modified: string): DiffHunk[] {
  if (original === modified) return [];
  const oldLines = original ? original.split('\n') : [];
  const newLines = modified ? modified.split('\n') : [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  const hunks: DiffHunk[] = [];
  let inChange = false;
  for (let i = 0; i < maxLen; i++) {
    const differs = oldLines[i] !== newLines[i];
    if (differs && !inChange) {
      const lineNo = i + 1;
      hunks.push({
        index: hunks.length,
        header: `@@ -${lineNo} +${lineNo} @@`,
        oldStart: lineNo,
        newStart: lineNo,
      });
      inChange = true;
    } else if (!differs) {
      inChange = false;
    }
  }
  return hunks;
}

export function resolveNextHunkIndex(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) {
    return direction === 1 ? 0 : total - 1;
  }
  return (((current + direction) % total) + total) % total;
}

function collectCodeMirrorHunkAnchors(container: HTMLElement): HTMLElement[] {
  const scope = container.querySelector<HTMLElement>('.cm-merge-b') ?? container;
  const selector = '.cm-changedLine, .cm-deletedChunk';
  let nodes = Array.from(scope.querySelectorAll<HTMLElement>(selector));
  if (nodes.length === 0 && scope !== container) {
    nodes = Array.from(container.querySelectorAll<HTMLElement>(selector));
  }
  const anchors: HTMLElement[] = [];
  for (const el of nodes) {
    const prev = el.previousElementSibling;
    const contiguous = prev instanceof HTMLElement && prev.matches(selector);
    if (!contiguous) anchors.push(el);
  }
  return anchors;
}

export function collectHunkElements(mountHost: HTMLElement, emptyHost: HTMLElement): HTMLElement[] {
  if (!mountHost.hidden) {
    const cmAnchors = collectCodeMirrorHunkAnchors(mountHost);
    if (cmAnchors.length > 0) return cmAnchors;
  }
  if (!emptyHost.hidden) {
    return Array.from(emptyHost.querySelectorAll<HTMLElement>('[data-hunk-index]'));
  }
  return [];
}

export function clearActiveHunkHighlight(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('.is-hunk-active')) {
    el.classList.remove('is-hunk-active');
  }
}

export function focusHunkElement(root: HTMLElement, target: HTMLElement | undefined): void {
  clearActiveHunkHighlight(root);
  if (!target) return;
  target.classList.add('is-hunk-active');
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
