import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '../../../i18n/index.js';
import {
  collectVisibleLocals,
  pendingReasonText,
  renderPendingQueueHtml,
} from './pending-queue.js';
import type { LocalPendingItem, WebPendingItem } from './types.js';

const ICONS = { clock: '<svg id="c"/>', bolt: '<svg id="b"/>', undo: '<svg id="u"/>' };

describe('features/topic/status/pending-queue', () => {
  beforeEach(() => {
    setLocale('en');
  });

  it('maps pending reasons to localized labels', () => {
    expect(pendingReasonText('sending')).toBe('Sending…');
    expect(pendingReasonText('tool')).toBe('Waiting for tool');
    expect(pendingReasonText('turn')).toBe('After current turn');
    expect(pendingReasonText('delay')).toBe('Inserting shortly');
  });

  it('filters local pending items by topic, deduplicates server nonces, and sorts by timestamp', () => {
    const localPending: Record<string, LocalPendingItem> = {
      n1: { topic: 't1', nonce: 'n1', content: 'already on server', attachments: 0, at: 100 },
      n2: { topic: 't1', nonce: 'n2', content: 'later', attachments: 0, at: 300 },
      n3: { topic: 't1', nonce: 'n3', content: 'earlier', attachments: 1, at: 200 },
      n4: { topic: 't2', nonce: 'n4', content: 'other topic', attachments: 0, at: 50 },
    };
    const serverItems: WebPendingItem[] = [
      { id: 'm1', content: 'already on server', at: 100, canSendNow: true, reason: 'delay', nonce: 'n1' },
    ];
    const visible = collectVisibleLocals(localPending, 't1', serverItems);
    expect(visible.map((v) => v.nonce)).toEqual(['n3', 'n2']);
  });

  it('renders server and local queued items with interrupt confirmation and attachment counts', () => {
    expect(renderPendingQueueHtml([], [], null, ICONS)).toBe('');

    const items: WebPendingItem[] = [
      { id: 'p1', content: 'follow up <1>', at: 1, canSendNow: true, reason: 'delay', attachments: 1 },
      { id: 'p2', content: 'stop & steer', at: 2, canSendNow: false, reason: 'tool', attachments: 3 },
    ];
    const locals: LocalPendingItem[] = [
      { topic: 't1', nonce: 'n9', content: 'in flight', attachments: 2, at: 3 },
    ];

    const normal = renderPendingQueueHtml(items, locals, null, ICONS);
    expect(normal).toContain('Queued (3)');
    expect(normal).toContain('follow up &lt;1&gt;');
    expect(normal).toContain('+1 attachment');
    expect(normal).toContain('+3 attachments');
    expect(normal).toContain('+2 attachments');
    expect(normal).toContain('data-pq-send="p1" data-pq-interrupt="0"');
    expect(normal).toContain('data-pq-send="p2" data-pq-interrupt="1"');
    expect(normal).toContain('data-pq-nonce="n9"');

    const confirming = renderPendingQueueHtml(items, [], 'p2', ICONS);
    expect(confirming).toContain('data-pq-confirm="p2"');
    expect(confirming).toContain('data-pq-cancel="p2"');
    expect(confirming).toContain('data-pq-send="p1"');
  });
});
