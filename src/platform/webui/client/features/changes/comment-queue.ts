import { Emitter, type Event } from '../../base/event.js';
import type { Disposable } from '../../base/lifecycle.js';
import { buildDiffCommentBlock } from './diff-helpers.js';
import type { DiffCommentContext } from './types.js';

export interface StagedDiffComment {
  readonly id: string;
  readonly topicId: string;
  readonly context: DiffCommentContext;
  readonly comment: string;
  readonly createdAt: number;
}

export function formatMergedDiffComments(items: readonly StagedDiffComment[]): string {
  if (items.length === 0) return '';
  return items
    .map((item, idx) => `${idx + 1}. ${buildDiffCommentBlock(item.context, item.comment)}`)
    .join('\n\n');
}

export class CommentDraftStore implements Disposable {
  private readonly _byTopic = new Map<string, StagedDiffComment[]>();
  private readonly _onDidChange = new Emitter<string>();
  private _seq = 0;
  private _disposed = false;

  readonly onDidChange: Event<string> = this._onDidChange.event;

  add(topicId: string, context: DiffCommentContext, comment: string): StagedDiffComment {
    const trimmed = comment.trim();
    const item: StagedDiffComment = {
      id: `cmt-${++this._seq}`,
      topicId,
      context,
      comment: trimmed,
      createdAt: Date.now(),
    };
    const bucket = this._byTopic.get(topicId) ?? [];
    bucket.push(item);
    this._byTopic.set(topicId, bucket);
    this._emit(topicId);
    return item;
  }

  update(topicId: string, id: string, comment: string): boolean {
    const trimmed = comment.trim();
    if (!trimmed) return false;
    const bucket = this._byTopic.get(topicId);
    if (!bucket) return false;
    const idx = bucket.findIndex((item) => item.id === id);
    if (idx < 0) return false;
    const prev = bucket[idx]!;
    bucket[idx] = { ...prev, comment: trimmed };
    this._emit(topicId);
    return true;
  }

  remove(topicId: string, id: string): boolean {
    const bucket = this._byTopic.get(topicId);
    if (!bucket) return false;
    const next = bucket.filter((item) => item.id !== id);
    if (next.length === bucket.length) return false;
    if (next.length === 0) this._byTopic.delete(topicId);
    else this._byTopic.set(topicId, next);
    this._emit(topicId);
    return true;
  }

  clear(topicId: string): void {
    if (!this._byTopic.has(topicId)) return;
    this._byTopic.delete(topicId);
    this._emit(topicId);
  }

  list(topicId: string): readonly StagedDiffComment[] {
    return this._byTopic.get(topicId) ?? [];
  }

  count(topicId: string): number {
    return this._byTopic.get(topicId)?.length ?? 0;
  }

  flush(topicId: string): string {
    const items = this.list(topicId);
    if (items.length === 0) return '';
    const merged = formatMergedDiffComments(items);
    this._byTopic.delete(topicId);
    this._emit(topicId);
    return merged;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._byTopic.clear();
    this._onDidChange.dispose();
  }

  private _emit(topicId: string): void {
    if (!this._disposed) this._onDidChange.fire(topicId);
  }
}
