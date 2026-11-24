// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { createNotifyController, isPushSupported, urlBase64ToUint8Array } from './index.js';

function makeFakeEnv(permission: NotificationPermission = 'default') {
  const swTarget = new EventTarget();
  const existingSub = {
    endpoint: 'https://push.example/sub-1',
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint: 'https://push.example/sub-1', keys: { p256dh: 'k', auth: 'a' } }),
  } as unknown as PushSubscription;

  let currentSub: PushSubscription | null = null;
  const pushManager = {
    getSubscription: vi.fn(async () => currentSub),
    subscribe: vi.fn(async () => {
      currentSub = existingSub;
      return existingSub;
    }),
  };
  const reg = { pushManager } as unknown as ServiceWorkerRegistration;
  const serviceWorker = Object.assign(swTarget, {
    getRegistration: vi.fn(async () => reg),
    register: vi.fn(async () => reg),
    ready: Promise.resolve(reg),
  });
  const NotificationCtor = {
    permission,
    requestPermission: vi.fn(async () => 'granted' as NotificationPermission),
  };
  const win = {
    isSecureContext: true,
    PushManager: function PushManager() {},
    Notification: NotificationCtor,
    alert: vi.fn(),
  } as unknown as Window;
  const nav = { serviceWorker } as unknown as Navigator;
  return {
    win,
    nav,
    swTarget,
    serviceWorker,
    pushManager,
    NotificationCtor,
    existingSub,
    setSub: (sub: PushSubscription | null) => {
      currentSub = sub;
    },
  };
}

describe('features/notify', () => {
  it('decodes URL-safe base64 VAPID keys into bytes', () => {
    const raw = [0xfb, 0xff, 0xfe, 0x01, 0x02];
    const b64url = Buffer.from(raw).toString('base64url');
    expect(b64url).toContain('-');
    expect(b64url).toContain('_');
    expect(Array.from(urlBase64ToUint8Array(b64url))).toEqual(raw);
  });

  it('detects push support from secure context and browser APIs', () => {
    const env = makeFakeEnv();
    expect(isPushSupported(env.win, env.nav)).toBe(true);
    expect(isPushSupported({ isSecureContext: false } as Window, env.nav)).toBe(false);
  });

  it('initializes, subscribes, unsubscribes, and reflects denied permission', async () => {
    const env = makeFakeEnv('default');
    const notifyBtn = document.createElement('button');
    notifyBtn.hidden = true;
    const notifyState = document.createElement('span');
    const post = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({ enabled: true, key: 'AQID' }),
        }) as Response,
    );

    const ctrl = createNotifyController({
      notifyBtn,
      notifyState,
      post,
      fetchFn: fetchFn as unknown as typeof fetch,
      onCachedMessage: vi.fn(),
      onGotoTopic: vi.fn(),
      win: env.win,
      nav: env.nav,
    });

    await ctrl.init();
    expect(notifyBtn.hidden).toBe(false);
    expect(notifyBtn.getAttribute('aria-pressed')).toBe('false');

    await ctrl.toggle();
    expect(post).toHaveBeenCalledWith('api/push/subscribe', env.existingSub.toJSON(), 1);
    expect(notifyBtn.getAttribute('aria-pressed')).toBe('true');

    await ctrl.toggle();
    expect(env.existingSub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      'api/push/unsubscribe',
      { endpoint: 'https://push.example/sub-1' },
      1,
    );
    expect(notifyBtn.getAttribute('aria-pressed')).toBe('false');

    env.NotificationCtor.permission = 'denied';
    ctrl.paint();
    expect(notifyBtn.disabled).toBe(true);
    ctrl.dispose();
  });

  it('routes service worker cached and goto messages to callbacks', () => {
    const env = makeFakeEnv('granted');
    const onCachedMessage = vi.fn();
    const onGotoTopic = vi.fn();
    const ctrl = createNotifyController({
      notifyBtn: document.createElement('button'),
      notifyState: document.createElement('span'),
      onCachedMessage,
      onGotoTopic,
      win: env.win,
      nav: env.nav,
    });

    env.swTarget.dispatchEvent(
      new MessageEvent('message', { data: { cached: { topic: 't1', last: 'w9', epoch: 3 } } }),
    );
    expect(onCachedMessage).toHaveBeenCalledWith('t1', 'w9', 3);
    expect(onGotoTopic).not.toHaveBeenCalled();

    env.swTarget.dispatchEvent(new MessageEvent('message', { data: { goto: 't2' } }));
    expect(onGotoTopic).toHaveBeenCalledWith('t2');

    ctrl.dispose();
    env.swTarget.dispatchEvent(new MessageEvent('message', { data: { goto: 't3' } }));
    expect(onGotoTopic).toHaveBeenCalledTimes(1);
  });
});
