import { addDisposableListener } from '../../../base/dom.js';
import { type Disposable, DisposableStore } from '../../../base/lifecycle.js';
import { t as tr } from '../../../i18n/index.js';
import { post } from '../../../services/api.js';
import type { OverlayManager } from '../../../services/overlays.js';
import type { ComposerAttachment, ComposerIcons } from './types.js';

export const MIC_TYPES = [
  'audio/ogg;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/webm',
] as const;
export const MIC_MAX_MS = 10 * 60 * 1000;
export const MIC_BITRATE = 24000;

export function voiceExt(mime: string): string {
  const sub = mime.split('/')[1] || 'webm';
  return sub === 'mp4' ? 'm4a' : sub;
}

export function selectRecordType(isSupported?: (mime: string) => boolean): string {
  const check =
    isSupported ??
    ((mime: string) =>
      typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
        ? MediaRecorder.isTypeSupported(mime)
        : false);
  for (const mime of MIC_TYPES) {
    try {
      if (check(mime)) return mime;
    } catch {
      // Ignore unsupported codec query errors.
    }
  }
  return '';
}

export function formatMicElapsed(startedMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

interface ActiveRecording {
  readonly mr: MediaRecorder;
  readonly stream: MediaStream;
  readonly type: string;
  readonly parts: Blob[];
  readonly started: number;
  keep: boolean;
  timer: ReturnType<typeof setInterval> | null;
  cap: ReturnType<typeof setTimeout> | null;
}

interface TranscribeResponse {
  readonly ok?: unknown;
  readonly error?: string;
  readonly noSpeech?: boolean;
  readonly reason?: string;
  readonly cleaned?: string;
  readonly text?: string;
  readonly latencyMs?: number;
}

export interface VoiceDeps {
  readonly micBtn: HTMLButtonElement | null;
  readonly note: HTMLElement;
  readonly overlays: OverlayManager;
  readonly doc: Document;
  readonly win: Window;
  readonly getTopic: () => string;
  readonly getIcons: () => ComposerIcons;
  readonly appendDictation: (into: string, dictated: string) => void;
  readonly dispatchAudio: (files: readonly ComposerAttachment[]) => void;
  readonly postFn?: (path: string, body: unknown, tries?: number, limit?: number) => Promise<Response>;
  readonly now?: () => number;
}

export interface VoiceController {
  isRecording(): boolean;
  micLabel(): void;
  stopRec(keep: boolean): void;
  attach(): Disposable;
  dispose(): void;
}

function releaseMic(r: ActiveRecording): void {
  r.stream.getTracks().forEach((track) => track.stop());
}

function createMediaRecorder(stream: MediaStream, type: string): MediaRecorder {
  try {
    const opts: MediaRecorderOptions = type
      ? { mimeType: type, audioBitsPerSecond: MIC_BITRATE }
      : { audioBitsPerSecond: MIC_BITRATE };
    return new MediaRecorder(stream, opts);
  } catch {
    return type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
  }
}

class VoiceControllerImpl implements VoiceController {
  private readonly postFn: (path: string, body: unknown, tries?: number, limit?: number) => Promise<Response>;
  private readonly nowFn: () => number;
  private rec: ActiveRecording | null = null;
  private recStarting = false;
  private recTranscribing = false;
  private voices = 0;

  constructor(private readonly deps: VoiceDeps) {
    this.postFn = deps.postFn ?? post;
    this.nowFn = deps.now ?? (() => Date.now());
  }

  isRecording(): boolean {
    return Boolean(this.rec);
  }

  micLabel(): void {
    const btn = this.deps.micBtn;
    if (!btn) return;
    const icons = this.deps.getIcons();
    if (this.recTranscribing) {
      btn.innerHTML = icons.mic;
      btn.classList.remove('rec');
      btn.disabled = true;
      btn.title = tr('composer.micTranscribing');
      return;
    }
    btn.disabled = false;
    if (!this.rec) {
      btn.innerHTML = icons.mic;
      btn.classList.remove('rec');
      btn.title = tr('composer.micTitle');
      return;
    }
    btn.innerHTML = `${icons.stop} ${formatMicElapsed(this.rec.started, this.nowFn())}`;
    btn.classList.add('rec');
    btn.title = tr('composer.micStopTitle');
  }

  private micFailed(err: unknown): void {
    this.recStarting = false;
    const e = err as { message?: string; name?: string } | null;
    this.deps.note.textContent = tr('composer.micFailed', {
      err: (e && (e.message || e.name)) || tr('composer.micUnavailable'),
    });
    this.micLabel();
  }

  private handleTranscribeResult(
    into: string,
    res: Response,
    data: TranscribeResponse | null,
    fallback: () => void,
  ): void {
    if (!data || typeof data.ok !== 'boolean') {
      if (res.ok) {
        fallback();
        return;
      }
      this.deps.note.textContent = tr('composer.micTranscribeFailed', {
        err: (data && data.error) || `HTTP ${res.status}`,
      });
      return;
    }
    if (!data.ok) {
      this.deps.note.textContent = data.noSpeech
        ? tr('composer.micNoSpeech')
        : tr('composer.micTranscribeFailed', { err: data.reason || 'unknown error' });
      return;
    }
    const out = data.cleaned || data.text || '';
    this.deps.appendDictation(into, out);
    const sec = ((data.latencyMs || 0) / 1000).toFixed(1);
    this.deps.note.textContent =
      data.cleaned && data.text && data.cleaned !== data.text
        ? tr('composer.micTranscribedWithRaw', { seconds: sec, raw: data.text })
        : tr('composer.micTranscribed', { seconds: sec });
  }

  private dictateOrSend(into: string, mime: string, b64: string): void {
    this.recTranscribing = true;
    this.micLabel();
    this.deps.note.textContent = tr('composer.micTranscribing');
    const fallback = (): void => {
      this.voices += 1;
      this.deps.note.textContent = '';
      this.deps.dispatchAudio([{ name: `voice-${this.voices}.${voiceExt(mime)}`, mime, data: b64 }]);
    };
    this.postFn('api/voice/transcribe', { mime, data: b64 }, 1, 95000).then(
      (res) => {
        this.recTranscribing = false;
        this.micLabel();
        if (res.status === 404) {
          fallback();
          return;
        }
        return res
          .json()
          .catch(() => null)
          .then((data) => this.handleTranscribeResult(into, res, data as TranscribeResponse | null, fallback));
      },
      (err: unknown) => {
        this.recTranscribing = false;
        this.micLabel();
        const e = err as { message?: string } | null;
        this.deps.note.textContent = tr('composer.micTranscribeFailed', {
          err: (e && e.message) || 'network error',
        });
      },
    );
  }

  stopRec(keep: boolean): void {
    const active = this.rec;
    if (!active) return;
    this.rec = null;
    active.keep = keep;
    if (active.timer !== null) clearInterval(active.timer);
    if (active.cap !== null) clearTimeout(active.cap);
    this.micLabel();
    try {
      active.mr.stop();
    } catch {
      releaseMic(active);
    }
  }

  private startRec(): void {
    this.recStarting = true;
    const into = this.deps.getTopic();
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      this.recStarting = false;
      const type = selectRecordType();
      let mr: MediaRecorder;
      try {
        mr = createMediaRecorder(stream, type);
      } catch (err) {
        stream.getTracks().forEach((track) => track.stop());
        this.micFailed(err);
        return;
      }
      const active: ActiveRecording = {
        mr,
        stream,
        type,
        parts: [],
        started: this.nowFn(),
        keep: true,
        timer: null,
        cap: null,
      };
      mr.ondataavailable = (ev) => {
        if (ev.data && ev.data.size) active.parts.push(ev.data);
      };
      mr.onstop = () => {
        releaseMic(active);
        if (!active.keep || !active.parts.length) return;
        const mime = (mr.mimeType || active.type || 'audio/webm').split(';')[0] || 'audio/webm';
        const fr = new FileReader();
        fr.onload = () => {
          const s = String(fr.result);
          const comma = s.indexOf(',');
          this.dictateOrSend(into, mime, comma < 0 ? '' : s.slice(comma + 1));
        };
        fr.readAsDataURL(new Blob(active.parts, { type: mime }));
      };
      this.rec = active;
      mr.start();
      active.timer = setInterval(() => this.micLabel(), 1000);
      active.cap = setTimeout(() => this.stopRec(true), MIC_MAX_MS);
      this.deps.note.textContent = '';
      this.micLabel();
    }, (err) => this.micFailed(err));
  }

  attach(): Disposable {
    const store = new DisposableStore();
    if (this.deps.micBtn) {
      const hasMedia = Boolean(
        navigator.mediaDevices &&
          typeof navigator.mediaDevices.getUserMedia === 'function' &&
          'MediaRecorder' in this.deps.win &&
          Boolean((this.deps.win as Window & { MediaRecorder?: unknown }).MediaRecorder),
      );
      this.deps.micBtn.hidden = !hasMedia;
      store.add(
        addDisposableListener(this.deps.micBtn, 'click', () => {
          if (this.rec) this.stopRec(true);
          else if (!this.recStarting && !this.recTranscribing && this.deps.getTopic()) this.startRec();
        }),
      );
    }
    store.add(this.deps.overlays.addGuard(() => Boolean(this.rec)));
    store.add(
      addDisposableListener(
        this.deps.doc,
        'keydown',
        (e) => {
          if (e.isComposing) return;
          if (e.key === 'Escape' && this.rec) {
            this.stopRec(false);
            e.stopPropagation();
          }
        },
        true,
      ),
    );
    return store;
  }

  dispose(): void {
    if (this.rec) this.stopRec(false);
  }
}

export function createVoiceController(deps: VoiceDeps): VoiceController {
  return new VoiceControllerImpl(deps);
}
