import type { Event } from '../../base/event.js';
import type { Disposable } from '../../base/lifecycle.js';
import type { OverlayManager } from '../../services/overlays.js';
import type { StorageService } from '../../services/storage.js';
import type { WebuiEvents } from '../../plugins/api.js';

export type ConnectionState =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'restarting'
  | 'parked'
  | 'closed';

export interface StatusNotifyState {
  readonly supported: boolean;
  readonly available: boolean;
  readonly enabled: boolean;
  readonly blocked: boolean;
  readonly busy: boolean;
}

export interface StatusNotifyBridge extends Disposable {
  readonly onDidChange: Event<StatusNotifyState>;
  getState(): StatusNotifyState;
  init(): Promise<void>;
  toggle(): Promise<void>;
}

export interface StatusPluginError {
  readonly pluginId: string;
  readonly phase?: string;
  readonly message: string;
  readonly timestamp?: number;
}

export interface CloseIdleResponse {
  readonly closed: readonly string[];
  readonly kept: readonly string[];
}

export interface StatusPluginDeps {
  readonly storage?: StorageService;
  readonly overlays?: OverlayManager;
  readonly doc?: Document;
  readonly win?: Window;
  readonly appElement?: HTMLElement | null;
  readonly brandLabel?: string;
  readonly version?: string;
  readonly updateAvailable?: boolean;
  readonly initialConnectionState?: ConnectionState;
  readonly notify?: StatusNotifyBridge;
  readonly getPluginErrors?: () => readonly StatusPluginError[];
  readonly onPluginError?: (cb: (err: StatusPluginError) => void) => Disposable;
  readonly onConnectionStateChange?: (cb: (state: ConnectionState) => void) => Disposable;
  readonly onUpdateAvailable?: (cb: (available: boolean) => void) => Disposable;
  readonly onBeforeReload?: () => void;
  readonly onReload?: () => void;
  readonly onResetLayout?: () => void;
  readonly onRefreshStatusBar?: (id?: string) => void;
  readonly postCloseIdle?: (topicIds: readonly string[]) => Promise<CloseIdleResponse>;
  readonly emitEvent?: <K extends keyof WebuiEvents>(key: K, payload: WebuiEvents[K]) => void;
  readonly fetchFn?: typeof fetch;
  readonly postFn?: (path: string, body: unknown, tries: number) => Promise<Response>;
  readonly alertFn?: (message: string) => void;
}
