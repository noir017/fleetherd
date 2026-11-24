import { addDisposableListener } from '../../base/dom.js';
import { type Disposable, DisposableStore } from '../../base/lifecycle.js';
import { t as tr } from '../../i18n/index.js';
import { post as defaultPost } from '../../services/api.js';
import { StorageService } from '../../services/storage.js';

export const TERM_H_KEY = 'aa_term_h';
export const TERM_MIN = 120;
export const TERM_MIN_LOG = 120;

export type TermState = 'open' | 'min';

export interface TermLimits {
  readonly min: number;
  readonly max: number;
}

export interface TerminalDeps {
  readonly enabled: boolean;
  readonly canEnd: boolean;
  readonly chat: HTMLElement;
  readonly chatHead: HTMLElement;
  readonly composer: HTMLElement;
  readonly termBtn: HTMLButtonElement;
  readonly termHost: HTMLElement;
  readonly termEl: HTMLElement;
  readonly termGrip: HTMLElement;
  readonly termName: HTMLElement;
  readonly termMinBtn: HTMLButtonElement;
  readonly termEndBtn: HTMLButtonElement;
  readonly getTopic: () => string;
  readonly getTopicTitle: (topicId: string) => string | undefined;
  readonly isOverlayCovering: () => boolean;
  readonly atBottom: () => boolean;
  readonly toBottom: () => void;
  readonly post?: (path: string, body: unknown, tries: number) => Promise<Response>;
  readonly storage?: StorageService;
  readonly win?: Window;
  readonly doc?: Document;
  readonly confirmFn?: (message: string) => boolean;
  readonly alertFn?: (message: string) => void;
}

export interface TerminalController extends Disposable {
  isOpen(topicId?: string): boolean;
  getState(topicId: string): TermState | undefined;
  urlNow(): string;
  apply(): void;
  paintFrames(): void;
  paintHeight(): void;
  paintHeightIfOpen(): void;
  show(): void;
  minimize(): void;
  end(): Promise<void>;
  drop(topicId: string): void;
  pruneFrames(keep: Readonly<Record<string, unknown>>): void;
}

interface TermEndErrorBody {
  readonly error?: string;
}

export function computeTermLimits(
  chatHeight: number,
  headerHeight: number,
  composerHeight: number,
  gripHeight: number,
): TermLimits {
  if (!chatHeight) return { min: TERM_MIN, max: TERM_MIN + 40 };
  const fixed = headerHeight + composerHeight + (gripHeight || 12) + TERM_MIN_LOG;
  const max = Math.min(chatHeight, Math.max(TERM_MIN, chatHeight - fixed));
  return { min: Math.min(TERM_MIN, max), max };
}

export function computeTermHeight(
  savedHeight: number,
  chatHeight: number,
  limits: TermLimits,
): number {
  const target = savedHeight || Math.round(chatHeight * 0.5);
  return Math.max(limits.min, Math.min(limits.max, target));
}

export function formatTopicUrl(topic: string, isOpen: boolean): string {
  return `?t=${encodeURIComponent(topic)}${isOpen ? '&v=term' : ''}`;
}

function readSavedTermHeight(storage: StorageService): number {
  const raw = storage.getRaw(TERM_H_KEY);
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

class TerminalControllerImpl implements TerminalController {
  private readonly _deps: TerminalDeps;
  private readonly _win: Window;
  private readonly _doc: Document;
  private readonly _storage: StorageService;
  private readonly _post: (path: string, body: unknown, tries: number) => Promise<Response>;
  private readonly _confirm: (message: string) => boolean;
  private readonly _alert: (message: string) => void;
  private readonly _disposables = new DisposableStore();
  private readonly _state: Record<string, TermState> = {};
  private readonly _frames: Record<string, HTMLIFrameElement> = {};
  private _termBoot: boolean;
  private _termH: number;

  constructor(deps: TerminalDeps) {
    this._deps = deps;
    this._win = deps.win ?? window;
    this._doc = deps.doc ?? document;
    this._storage = deps.storage ?? new StorageService();
    this._post = deps.post ?? defaultPost;
    this._confirm = deps.confirmFn ?? ((msg: string) => this._win.confirm(msg));
    this._alert = deps.alertFn ?? ((msg: string) => this._win.alert(msg));
    this._termBoot = deps.enabled && new URLSearchParams(this._win.location.search).get('v') === 'term';
    this._termH = readSavedTermHeight(this._storage);
    if (deps.enabled) this._attachControls();
  }

  private _limits(): TermLimits {
    return computeTermLimits(
      this._deps.chat.clientHeight,
      this._deps.chatHead.clientHeight,
      this._deps.composer.clientHeight,
      this._deps.termGrip.offsetHeight,
    );
  }

  private _currentHeight(): number {
    return computeTermHeight(this._termH, this._deps.chat.clientHeight, this._limits());
  }

  private _setHeight(h: number): void {
    const lim = this._limits();
    this._termH = Math.max(lim.min, Math.min(lim.max, Math.round(h)));
    this.paintHeight();
  }

  private _saveHeight(): void {
    if (this._termH) this._storage.setRaw(TERM_H_KEY, String(this._termH));
    else this._storage.remove(TERM_H_KEY);
  }

  private _mount(id: string): void {
    if (this._frames[id]) return;
    const frame = this._doc.createElement('iframe');
    frame.setAttribute('title', 'Terminal');
    frame.setAttribute('src', `term/?arg=${encodeURIComponent(id)}`);
    this._frames[id] = frame;
    this._deps.termHost.appendChild(frame);
  }

  private _attachControls(): void {
    const d = this._deps;
    d.termBtn.hidden = false;
    this._disposables.add(
      addDisposableListener(d.termBtn, 'click', () => {
        const topic = d.getTopic();
        if (topic && this._state[topic] === 'open') this.minimize();
        else this.show();
      }),
    );
    this._disposables.add(addDisposableListener(d.termMinBtn, 'click', () => this.minimize()));
    this._disposables.add(
      addDisposableListener(d.termEndBtn, 'click', () => {
        void this.end();
      }),
    );
    this._attachDragAndResize();
  }

  private _attachDragAndResize(): void {
    const d = this._deps;
    let drag: { y: number; h: number } | null = null;
    const endDrag = (): void => {
      if (!drag) return;
      drag = null;
      d.termGrip.classList.remove('drag');
      this._saveHeight();
    };

    this._disposables.add(
      addDisposableListener(d.termGrip, 'pointerdown', (ev) => {
        const topic = d.getTopic();
        if (!topic || !this._state[topic]) return;
        ev.preventDefault();
        drag = { y: ev.clientY, h: this._currentHeight() };
        d.termGrip.classList.add('drag');
        if (typeof d.termGrip.setPointerCapture === 'function') {
          try {
            d.termGrip.setPointerCapture(ev.pointerId);
          } catch {
            // Pointer capture can fail in synthetic tests or detached elements.
          }
        }
      }),
    );
    this._disposables.add(
      addDisposableListener(d.termGrip, 'pointermove', (ev) => {
        if (drag) this._setHeight(drag.h - (ev.clientY - drag.y));
      }),
    );
    this._disposables.add(addDisposableListener(this._win, 'pointerup', endDrag));
    this._disposables.add(addDisposableListener(this._win, 'pointercancel', endDrag));
    this._disposables.add(addDisposableListener(d.termGrip, 'lostpointercapture', endDrag));
    this._disposables.add(
      addDisposableListener(d.termGrip, 'dblclick', () => {
        this._termH = 0;
        this.paintHeight();
        this._saveHeight();
      }),
    );
    this._disposables.add(
      addDisposableListener(d.termGrip, 'keydown', (ev) => {
        if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
        ev.preventDefault();
        this._setHeight(this._currentHeight() + (ev.key === 'ArrowUp' ? 24 : -24));
        this._saveHeight();
      }),
    );
    this._disposables.add(
      addDisposableListener(this._win, 'resize', () => {
        const topic = d.getTopic();
        if (topic && this._state[topic] === 'open' && !d.isOverlayCovering()) {
          this.paintHeight();
        }
      }),
    );
  }

  isOpen(topicId?: string): boolean {
    const id = topicId ?? this._deps.getTopic();
    return Boolean(id && this._state[id] === 'open');
  }

  getState(topicId: string): TermState | undefined {
    return this._state[topicId];
  }

  urlNow(): string {
    const topic = this._deps.getTopic();
    return formatTopicUrl(topic, Boolean(topic && this._state[topic] === 'open'));
  }

  paintHeight(): void {
    if (this._deps.isOverlayCovering()) return;
    const lim = this._limits();
    const h = computeTermHeight(this._termH, this._deps.chat.clientHeight, lim);
    this._deps.termEl.style.height = `${h}px`;
    this._deps.termGrip.setAttribute('aria-valuenow', String(h));
    this._deps.termGrip.setAttribute('aria-valuemin', String(lim.min));
    this._deps.termGrip.setAttribute('aria-valuemax', String(lim.max));
  }

  paintHeightIfOpen(): void {
    const topic = this._deps.getTopic();
    if (topic && this._state[topic] === 'open') this.paintHeight();
  }

  paintFrames(): void {
    const topic = this._deps.getTopic();
    const on = Boolean(topic && this._state[topic] === 'open' && !this._deps.isOverlayCovering());
    for (const id of Object.keys(this._frames)) {
      const frame = this._frames[id];
      if (!frame) continue;
      const live = on && id === topic;
      frame.classList.toggle('on', live);
      frame.toggleAttribute('inert', !live);
    }
    this._deps.termEl.toggleAttribute('inert', !on);
    const title = topic ? this._deps.getTopicTitle(topic) : undefined;
    this._deps.termName.textContent = title ? title : 'Untitled';
  }

  apply(): void {
    if (!this._deps.enabled) return;
    const topic = this._deps.getTopic();
    if (this._termBoot && topic) {
      this._termBoot = false;
      if (!this._state[topic]) this._state[topic] = 'open';
    }
    const state = topic ? this._state[topic] : undefined;
    const on = state === 'open';
    this._deps.chat.classList.toggle('term', on);
    // Paint height after toggling `.term` (so the grip is measured) and before mounting the iframe.
    if (on) this.paintHeight();
    this._deps.termBtn.classList.toggle('on', Boolean(state));
    this._deps.termBtn.title = on
      ? tr('term.minBtnTitle')
      : state
        ? tr('term.showRunningTitle')
        : tr('term.title');
    this._deps.termEndBtn.hidden = !this._deps.canEnd;
    if (state && topic) this._mount(topic);
    this.paintFrames();
  }

  drop(id: string): void {
    const frame = this._frames[id];
    if (frame) {
      if (frame.parentNode) frame.parentNode.removeChild(frame);
      delete this._frames[id];
    }
    delete this._state[id];
  }

  pruneFrames(keep: Readonly<Record<string, unknown>>): void {
    for (const id of Object.keys(this._frames)) {
      if (!keep[id]) this.drop(id);
    }
  }

  show(): void {
    const topic = this._deps.getTopic();
    if (!this._deps.enabled || !topic) return;
    const stick = this._deps.atBottom();
    this._state[topic] = 'open';
    this._win.history.replaceState(null, '', this.urlNow());
    this.apply();
    if (stick) this._deps.toBottom();
  }

  minimize(): void {
    const topic = this._deps.getTopic();
    if (!this._deps.enabled || !topic || !this._state[topic]) return;
    this._state[topic] = 'min';
    this._win.history.replaceState(null, '', this.urlNow());
    this.apply();
  }

  async end(): Promise<void> {
    const topic = this._deps.getTopic();
    if (!this._deps.enabled || !this._deps.canEnd || !topic || !this._state[topic]) return;
    const title = this._deps.getTopicTitle(topic) || tr('common.untitled');
    if (!this._confirm(tr('term.confirmEnd', { title }))) return;
    try {
      const res = await this._post('api/terminal/end', { topic }, 0);
      if (!res.ok) {
        let error = tr('term.endFailed');
        try {
          const body = (await res.json()) as TermEndErrorBody | null;
          if (body && body.error) error = body.error;
        } catch {
          // Use generic fallback message when response is not JSON.
        }
        this._alert(error);
        return;
      }
      this.drop(topic);
      if (topic === this._deps.getTopic()) {
        this._win.history.replaceState(null, '', this.urlNow());
        this.apply();
      }
    } catch {
      this._alert(tr('term.endReachErr'));
    }
  }

  dispose(): void {
    this._disposables.dispose();
  }
}

export function createTerminalController(deps: TerminalDeps): TerminalController {
  return new TerminalControllerImpl(deps);
}
