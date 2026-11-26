import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type EventSourceLike,
  applyTopicRows,
  buildEventsUrl,
  createStreamClient,
} from './stream.js';

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onopen: ((ev: globalThis.Event) => void) | null = null;
  onerror: ((ev: globalThis.Event) => void) | null = null;
  closed = false;
  readonly url: string;
  private readonly _listeners = new Map<string, EventListener[]>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: EventListener): void {
    const list = this._listeners.get(type) ?? [];
    list.push(listener);
    this._listeners.set(type, list);
  }

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  emitMessage(data: unknown, lastEventId = ''): void {
    this.onmessage?.({ data: JSON.stringify(data), lastEventId } as MessageEvent);
  }

  emitError(readyState = 2): void {
    this.readyState = readyState;
    this.onerror?.(new Event('error'));
  }

  close(): void {
    this.readyState = 2;
    this.closed = true;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('services/stream', () => {
  it('buildEventsUrl constructs relative api/events URLs', () => {
    expect(buildEventsUrl({})).toBe('api/events');
    expect(buildEventsUrl({ topic: 'a1' })).toBe('api/events?t=a1');
    expect(buildEventsUrl({ topic: 'a1', last: 'a1.1.5', tv: 42 })).toBe(
      'api/events?t=a1&last=a1.1.5&tv=42',
    );
    expect(buildEventsUrl({ topic: 'a1', tv: 42 })).toBe('api/events?t=a1');
  });

  it('applyTopicRows merges updated rows, drops gone rows, and sorts or honours order', () => {
    const initial = [
      { id: 'a', lastAt: 100 },
      { id: 'b', lastAt: 200 },
      { id: 'c', lastAt: 150 },
    ];
    const updated = applyTopicRows(initial, {
      gone: ['c'],
      rows: [
        { id: 'a', lastAt: 300 },
        { id: 'd', lastAt: 250 },
      ],
    });
    expect(updated.map((t) => t.id)).toEqual(['a', 'd', 'b']);

    const ordered = applyTopicRows(updated, { order: ['b', 'a'] });
    expect(ordered.map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('connects, tracks lastEventId, handles bye backoff reconnect, and checks auth on 401', async () => {
    vi.useFakeTimers();
    const sources: FakeEventSource[] = [];
    const events: string[] = [];
    const onOpen = vi.fn();
    const onRestarting = vi.fn();
    const onReconnecting = vi.fn();
    const onAuthExpired = vi.fn();
    let authStatus = 200;

    const client = createStreamClient({
      getTopic: () => 't1',
      isLoggedOut: () => false,
      getBuild: () => 'build-1',
      onOpen,
      onRestarting,
      onReconnecting,
      onAuthExpired,
      createEventSource: (url) => {
        const es = new FakeEventSource(url);
        sources.push(es);
        return es;
      },
      fetchFn: vi.fn(async () => new Response('', { status: authStatus })),
    });
    client.onEvent((ev) => events.push(ev.t));

    client.connect();
    expect(sources[0]?.url).toBe('api/events?t=t1');
    sources[0]?.emitOpen();
    expect(onOpen).toHaveBeenCalledWith({ quiet: false });
    expect(client.isOpen()).toBe(true);

    sources[0]?.emitMessage({ t: 'msg', msg: { id: 'w1' } }, 't1.r1.1');
    expect(client.getLastEventId()).toBe('t1.r1.1');
    expect(events).toEqual(['msg']);

    sources[0]?.emitMessage({ t: 'bye' });
    expect(sources[0]?.closed).toBe(true);
    expect(onRestarting).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
    expect(sources[1]?.url).toBe('api/events?t=t1&last=t1.r1.1');

    authStatus = 401;
    sources[1]?.emitError(2);
    await vi.runAllTicks();
    await Promise.resolve();
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(onReconnecting).not.toHaveBeenCalled();

    client.dispose();
  });

  it('checkBuild notifies when ETag differs from current build', async () => {
    const onBuildOutdated = vi.fn();
    const client = createStreamClient({
      getTopic: () => 't1',
      isLoggedOut: () => false,
      getBuild: () => 'old-hash',
      onBuildOutdated,
      createEventSource: (url) => new FakeEventSource(url),
      fetchFn: vi.fn(async () => new Response(null, { status: 200, headers: { ETag: '"new-hash"' } })),
    });

    client.checkBuild();
    await Promise.resolve();
    await Promise.resolve();
    expect(onBuildOutdated).toHaveBeenCalledTimes(1);
    client.dispose();
  });
});
