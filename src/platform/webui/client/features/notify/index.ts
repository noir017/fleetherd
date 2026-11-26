import { addDisposableListener } from '../../base/dom.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import { post as defaultPost } from '../../services/api.js';

export interface NotifyDeps {
  readonly notifyBtn: HTMLButtonElement;
  readonly notifyState: HTMLElement;
  readonly post?: (path: string, body: unknown, tries: number) => Promise<Response>;
  readonly onCachedMessage: (
    topic: string,
    last: string | undefined,
    epoch: number | undefined,
  ) => void;
  readonly onGotoTopic: (topicId: string) => void;
  readonly win?: Window;
  readonly nav?: Navigator;
  readonly fetchFn?: typeof fetch;
  readonly alertFn?: (message: string) => void;
}

export interface NotifyController extends Disposable {
  isSupported(): boolean;
  init(): Promise<void>;
  paint(): void;
  toggle(): Promise<void>;
}

interface PushConfigResponse {
  readonly enabled?: boolean;
  readonly key?: string;
}

interface PushErrorResponse {
  readonly error?: string;
}

interface SwCachedPayload {
  readonly topic?: unknown;
  readonly last?: unknown;
  readonly epoch?: unknown;
}

interface SwMessageData {
  readonly cached?: unknown;
  readonly goto?: unknown;
}

type NotifyWindow = Window & {
  Notification?: typeof Notification;
  PushManager?: unknown;
};

export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url + '==='.slice((base64Url.length + 3) % 4);
  const normalized = padded.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let i = 0; i < decoded.length; i++) {
    out[i] = decoded.charCodeAt(i);
  }
  return out;
}

export function isPushSupported(win: Window = window, nav: Navigator = navigator): boolean {
  const w = win as NotifyWindow;
  return Boolean(
    w.isSecureContext &&
      nav.serviceWorker &&
      w.PushManager &&
      w.Notification,
  );
}

function errorMessageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
  }
  return String(err);
}

export function createNotifyController(deps: NotifyDeps): NotifyController {
  const win = (deps.win ?? window) as NotifyWindow;
  const nav = deps.nav ?? navigator;
  const postFn = deps.post ?? defaultPost;
  const fetchFn = deps.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const alertFn = deps.alertFn ?? ((msg: string) => win.alert(msg));
  const pushOk = isPushSupported(win, nav);
  const disposables = new DisposableStore();

  let pushKey: string | null = null;
  let pushSub: PushSubscription | null = null;
  let notifyInit = false;

  const paint = (): void => {
    if (!pushOk || !pushKey) {
      deps.notifyBtn.hidden = true;
      return;
    }
    deps.notifyBtn.hidden = false;
    if (win.Notification?.permission === 'denied') {
      deps.notifyBtn.disabled = true;
      deps.notifyBtn.setAttribute('aria-pressed', 'false');
      deps.notifyState.textContent = tr('menu.notificationsBlocked');
      deps.notifyBtn.title = tr('menu.notificationsBlockedTitle');
      return;
    }
    deps.notifyBtn.disabled = false;
    deps.notifyBtn.setAttribute('aria-pressed', pushSub ? 'true' : 'false');
    deps.notifyState.textContent = pushSub ? tr('common.on') : tr('common.off');
    deps.notifyBtn.title = pushSub ? tr('menu.notificationsOnTitle') : tr('menu.notificationsOffTitle');
  };

  const init = async (): Promise<void> => {
    if (!pushOk || notifyInit) return;
    notifyInit = true;
    try {
      const res = await fetchFn('api/push', { credentials: 'same-origin' });
      const data = (await res.json()) as PushConfigResponse | null;
      if (!data || !data.enabled || !data.key) return;
      pushKey = data.key;
      const reg = await nav.serviceWorker.getRegistration('sw.js');
      pushSub = reg ? await reg.pushManager.getSubscription() : null;
      paint();
    } catch {
      // Best-effort probe; keep notifications button hidden on failure.
    }
  };

  const unsubscribe = async (sub: PushSubscription): Promise<void> => {
    const endpoint = sub.endpoint;
    try {
      await sub.unsubscribe();
    } catch {
      // Proceed to remove server-side subscription even if local unsubscribe failed.
    }
    pushSub = null;
    try {
      await postFn('api/push/unsubscribe', { endpoint }, 1);
    } catch {
      // Best-effort cleanup.
    }
  };

  const subscribe = async (key: string): Promise<void> => {
    if (!win.Notification) return;
    const permission = await win.Notification.requestPermission();
    if (permission !== 'granted') return;
    await nav.serviceWorker.register('sw.js');
    const reg = await nav.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      }));
    const res = await postFn('api/push/subscribe', sub.toJSON(), 1);
    if (res.ok) {
      pushSub = sub;
      return;
    }
    const body = (await res.json()) as PushErrorResponse | null;
    throw new Error((body && body.error) || `HTTP ${res.status}`);
  };

  const toggle = async (): Promise<void> => {
    if (!pushKey) return;
    deps.notifyBtn.disabled = true;
    try {
      if (pushSub) {
        await unsubscribe(pushSub);
      } else {
        await subscribe(pushKey);
      }
    } catch (err) {
      alertFn(tr('menu.notificationsError', { err: errorMessageOf(err) }));
    } finally {
      paint();
    }
  };

  const handleSwMessage = (ev: Event): void => {
    const data = (ev as MessageEvent<SwMessageData | null | undefined>).data;
    if (!data || typeof data !== 'object') return;
    const kept = data.cached;
    if (kept && typeof kept === 'object') {
      const rec = kept as SwCachedPayload;
      if (typeof rec.topic === 'string') {
        deps.onCachedMessage(
          rec.topic,
          typeof rec.last === 'string' ? rec.last : undefined,
          typeof rec.epoch === 'number' ? rec.epoch : undefined,
        );
        return;
      }
    }
    if (typeof data.goto === 'string' && data.goto) {
      deps.onGotoTopic(data.goto);
    }
  };

  disposables.add(
    addDisposableListener(deps.notifyBtn, 'click', () => {
      void toggle();
    }),
  );

  if (pushOk) {
    disposables.add(addDisposableListener(nav.serviceWorker, 'message', handleSwMessage));
  }

  return {
    isSupported: () => pushOk,
    init,
    paint,
    toggle,
    dispose: () => disposables.dispose(),
  };
}
