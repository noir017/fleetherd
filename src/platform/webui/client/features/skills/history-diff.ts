import type { SkillPanelEntry, SkillPanelHistoryEntry } from '../../../../adapter.js';

export type DiffLineKind = 'context' | 'add' | 'del' | 'hunk';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface DiffResult {
  readonly lines: readonly DiffLine[];
  readonly added: number;
  readonly removed: number;
  readonly hasChanges: boolean;
  readonly source: 'content' | 'metadata';
}

const MAX_LCS_CELLS = 400_000;

function splitLines(raw: string): string[] {
  if (raw === '') return [];
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

interface RawOp {
  readonly kind: 'context' | 'add' | 'del';
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

function buildLcsTable(a: readonly string[], b: readonly string[]): Uint32Array[] {
  const m = a.length;
  const n = b.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i]!;
    const nextRow = dp[i + 1]!;
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        row[j] = (nextRow[j + 1] ?? 0) + 1;
      } else {
        const down = nextRow[j] ?? 0;
        const right = row[j + 1] ?? 0;
        row[j] = down >= right ? down : right;
      }
    }
  }
  return dp;
}

function backtrackLcs(
  a: readonly string[],
  b: readonly string[],
  dp: readonly Uint32Array[],
  oldStart: number,
  newStart: number,
): RawOp[] {
  const out: RawOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i] ?? '', oldLine: oldStart + i, newLine: newStart + j });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ kind: 'del', text: a[i] ?? '', oldLine: oldStart + i });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] ?? '', newLine: newStart + j });
      j++;
    }
  }
  while (i < a.length) {
    out.push({ kind: 'del', text: a[i] ?? '', oldLine: oldStart + i });
    i++;
  }
  while (j < b.length) {
    out.push({ kind: 'add', text: b[j] ?? '', newLine: newStart + j });
    j++;
  }
  return out;
}

function lcsOps(a: readonly string[], b: readonly string[], oldStart: number, newStart: number): RawOp[] {
  if (a.length === 0 && b.length === 0) return [];
  if (a.length * b.length > MAX_LCS_CELLS) {
    const out: RawOp[] = [];
    for (let i = 0; i < a.length; i++) out.push({ kind: 'del', text: a[i] ?? '', oldLine: oldStart + i });
    for (let j = 0; j < b.length; j++) out.push({ kind: 'add', text: b[j] ?? '', newLine: newStart + j });
    return out;
  }
  return backtrackLcs(a, b, buildLcsTable(a, b), oldStart, newStart);
}

function rawDiffOps(beforeLines: readonly string[], afterLines: readonly string[]): RawOp[] {
  let prefix = 0;
  const minLen = Math.min(beforeLines.length, afterLines.length);
  while (prefix < minLen && beforeLines[prefix] === afterLines[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const out: RawOp[] = [];
  for (let i = 0; i < prefix; i++) {
    out.push({ kind: 'context', text: beforeLines[i] ?? '', oldLine: i + 1, newLine: i + 1 });
  }
  const midA = beforeLines.slice(prefix, beforeLines.length - suffix);
  const midB = afterLines.slice(prefix, afterLines.length - suffix);
  for (const op of lcsOps(midA, midB, prefix + 1, prefix + 1)) {
    out.push(op);
  }
  const oldTailStart = beforeLines.length - suffix;
  const newTailStart = afterLines.length - suffix;
  for (let i = 0; i < suffix; i++) {
    out.push({
      kind: 'context',
      text: beforeLines[oldTailStart + i] ?? '',
      oldLine: oldTailStart + i + 1,
      newLine: newTailStart + i + 1,
    });
  }
  return out;
}

function mergeHunkRanges(ops: readonly RawOp[], contextLines: number): Array<[number, number]> {
  const changedIndices: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]?.kind !== 'context') changedIndices.push(i);
  }
  if (changedIndices.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  for (const idx of changedIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(ops.length - 1, idx + contextLines);
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], end);
    } else {
      ranges.push([start, end]);
    }
  }
  return ranges;
}

function buildHunkHeader(ops: readonly RawOp[], start: number, end: number): string {
  let oldStart = 0;
  let newStart = 0;
  let oldCount = 0;
  let newCount = 0;
  for (let i = start; i <= end; i++) {
    const op = ops[i];
    if (!op) continue;
    if (op.kind !== 'add') {
      if (!oldStart && op.oldLine !== undefined) oldStart = op.oldLine;
      oldCount++;
    }
    if (op.kind !== 'del') {
      if (!newStart && op.newLine !== undefined) newStart = op.newLine;
      newCount++;
    }
  }
  return `@@ -${oldStart || 1},${oldCount} +${newStart || 1},${newCount} @@`;
}

function foldIntoHunks(ops: readonly RawOp[], contextLines: number): DiffLine[] {
  const ranges = mergeHunkRanges(ops, contextLines);
  const lines: DiffLine[] = [];
  for (const [start, end] of ranges) {
    lines.push({ kind: 'hunk', text: buildHunkHeader(ops, start, end) });
    for (let i = start; i <= end; i++) {
      const op = ops[i];
      if (op) lines.push(op);
    }
  }
  return lines;
}

/**
 * Computes a unified line-level diff between beforeText and afterText with folded context hunks.
 */
export function computeLineDiff(beforeText: string, afterText: string, contextLines = 3): DiffResult {
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);
  const ops = rawDiffOps(beforeLines, afterLines);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === 'add') added++;
    else if (op.kind === 'del') removed++;
  }
  const lines = foldIntoHunks(ops, contextLines);
  return {
    lines,
    added,
    removed,
    hasChanges: added > 0 || removed > 0,
    source: 'content',
  };
}

/**
 * Extracts optional embedded historical text if a backend/test payload provides it on a history entry.
 */
export function extractEmbeddedHistoryContent(entry: SkillPanelHistoryEntry): string | null {
  const rec = entry as unknown as Record<string, unknown>;
  if (typeof rec.beforeContent === 'string') return rec.beforeContent;
  if (typeof rec.content === 'string') return rec.content;
  return null;
}

/**
 * Fallback diff when full historical file text is not available locally: compares version metadata
 * and includes any unsaved draft changes against the currently loaded file.
 */
export function buildMetadataDiff(
  entry: SkillPanelHistoryEntry,
  currentSkill: SkillPanelEntry,
  savedContent: string,
  draftContent: string,
): DiffResult {
  const beforeMeta = [
    `commit: ${entry.id}`,
    `action: ${entry.action}`,
    `version: ${entry.beforeVersion || entry.afterVersion || 'unknown'}`,
    ...(entry.author ? [`author: ${entry.author}`] : []),
    ...(entry.note ? [`note: ${entry.note}`] : []),
  ].join('\n');

  const afterMeta = [
    `commit: current`,
    `action: ${entry.action}`,
    `version: ${currentSkill.version}`,
    ...(entry.author ? [`author: ${entry.author}`] : []),
    ...(entry.note ? [`note: ${entry.note}`] : []),
  ].join('\n');

  const metaDiff = computeLineDiff(beforeMeta, afterMeta, 3);
  if (savedContent === draftContent) {
    return { ...metaDiff, source: 'metadata' };
  }
  const draftDiff = computeLineDiff(savedContent, draftContent, 3);
  return {
    lines: [...metaDiff.lines, ...draftDiff.lines],
    added: metaDiff.added + draftDiff.added,
    removed: metaDiff.removed + draftDiff.removed,
    hasChanges: metaDiff.hasChanges || draftDiff.hasChanges,
    source: 'metadata',
  };
}
