import { describe, expect, it, vi } from 'vitest';

import { createApiClient, sendLimit, text } from './api.js';

describe('services/api', () => {
  it('text escapes HTML content and double quotes', () => {
    expect(text(null)).toBe('');
    expect(text(undefined)).toBe('');
    expect(text('<div title="a&b">hi</div>')).toBe('&lt;div title=&quot;a&amp;b&quot;&gt;hi&lt;/div&gt;');
  });

  it('sendLimit scales 15s + 1s per 64 KiB and caps at 300s', () => {
    expect(sendLimit({})).toBe(15000);
    expect(sendLimit({ text: 'a'.repeat(65536) })).toBe(16000);
    expect(
      sendLimit({
        text: '',
        files: [{ name: 'big.bin', data: 'x'.repeat(25 * 1024 * 1024) }],
      }),
    ).toBe(300000);
  });

  it('post sends JSON or binary with locale header and retries 5xx', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    let attempt = 0;
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      attempt++;
      if (attempt === 1) return new Response('err', { status: 502 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const api = createApiClient({
      fetchFn,
      getLocaleFn: () => 'zh-CN',
      retryDelayMs: 1,
    });

    const res = await api.post('api/send', { text: 'hi' }, 1);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Fleetherd-Locale']).toBe('zh-CN');

    const bytes = new Uint8Array([1, 2, 3]);
    await api.post('api/send', bytes, 0);
    const binHeaders = calls[2]?.init?.headers as Record<string, string>;
    expect(binHeaders['Content-Type']).toBe('application/octet-stream');
    expect(calls[2]?.init?.body).toBe(bytes);
  });

  it('post invokes onUnauthorized on 401 and does not retry 4xx', async () => {
    const onUnauthorized = vi.fn();
    const fetchFn = vi.fn(async () => new Response('no', { status: 401 }));
    const api = createApiClient({ fetchFn, getLocaleFn: () => 'en', retryDelayMs: 1, onUnauthorized });

    const res = await api.post('api/send', { text: 'x' }, 2);
    expect(res.status).toBe(401);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('post aborts on timeout and retries short limits', async () => {
    let calls = 0;
    const fetchFn = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          calls++;
          if (calls === 1) {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            return;
          }
          resolve(new Response('ok', { status: 200 }));
        }),
    );

    const api = createApiClient({ fetchFn, getLocaleFn: () => 'en', retryDelayMs: 1 });
    const res = await api.post('api/send', { text: 'hi' }, 1, 10);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });
});
