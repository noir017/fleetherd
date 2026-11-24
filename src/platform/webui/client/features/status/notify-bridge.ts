import { Emitter } from '../../base/event.js';
import { DisposableStore } from '../../base/lifecycle.js';
import { createNotifyController, isPushSupported } from '../notify/index.js';
import type { StatusNotifyBridge, StatusNotifyState } from './types.js';

export interface StatusNotifyBridgeOptions {
  readonly doc?: Document;
  readonly win?: Window;
  readonly nav?: Navigator;
  readonly fetchFn?: typeof fetch;
  readonly postFn?: (path: string, body: unknown, tries: number) => Promise<Response>;
  readonly alertFn?: (message: string) => void;
  readonly onCachedMessage?: (
    topic: string,
    last: string | undefined,
    epoch: number | undefined,
  ) => void;
  readonly onGotoTopic?: (topicId: string) => void;
}

type NotificationWindow = Window & {
  Notification?: typeof Notification;
};

function readNotifyState(
  supported: boolean,
  btn: HTMLButtonElement,
  win: NotificationWindow,
  busy: boolean,
): StatusNotifyState {
  if (!supported || btn.hidden) {
    return { supported, available: false, enabled: false, blocked: false, busy };
  }
  const blocked = win.Notification?.permission === 'denied';
  const enabled = !blocked && btn.getAttribute('aria-pressed') === 'true';
  return { supported, available: true, enabled, blocked, busy };
}

export function createStatusNotifyBridge(options: StatusNotifyBridgeOptions = {}): StatusNotifyBridge {
  const win = (options.win ?? window) as NotificationWindow;
  const doc = options.doc ?? document;
  const nav = options.nav ?? win.navigator;
  const supported = isPushSupported(win, nav);
  const disposables = new DisposableStore();
  const emitter = disposables.add(new Emitter<StatusNotifyState>());

  if (!supported) {
    const unsupported: StatusNotifyState = {
      supported: false,
      available: false,
      enabled: false,
      blocked: false,
      busy: false,
    };
    return {
      onDidChange: emitter.event,
      getState: () => unsupported,
      init: async () => undefined,
      toggle: async () => undefined,
      dispose: () => disposables.dispose(),
    };
  }

  const notifyBtn = doc.createElement('button');
  notifyBtn.hidden = true;
  const notifyState = doc.createElement('span');

  const controller = disposables.add(
    createNotifyController({
      notifyBtn,
      notifyState,
      win,
      nav,
      fetchFn: options.fetchFn,
      post: options.postFn,
      alertFn: options.alertFn,
      onCachedMessage: options.onCachedMessage ?? (() => undefined),
      onGotoTopic: options.onGotoTopic ?? (() => undefined),
    }),
  );

  let busy = false;
  let state = readNotifyState(true, notifyBtn, win, false);

  const sync = (): void => {
    controller.paint();
    state = readNotifyState(true, notifyBtn, win, busy);
    emitter.fire(state);
  };

  return {
    onDidChange: emitter.event,
    getState: () => state,
    async init(): Promise<void> {
      await controller.init();
      sync();
    },
    async toggle(): Promise<void> {
      if (!state.available || state.blocked || busy) return;
      busy = true;
      state = { ...state, busy: true };
      emitter.fire(state);
      try {
        await controller.toggle();
      } finally {
        busy = false;
        sync();
      }
    },
    dispose(): void {
      disposables.dispose();
    },
  };
}
