import { t as tr } from '../../../i18n/index.js';
import { post, sendLimit, text } from '../../../services/api.js';
import { DRAFT_MAX } from './drafts.js';
import type {
  ComposerAttachment,
  ComposerTopic,
  ComposerTopicStatusBridge,
  ComposerTranscriptBridge,
  EchoMessage,
  LegacyLocalMessage,
  LocalBubbleMessage,
  LocalBubbleState,
  SendBody,
  UnsentRecord,
} from './types.js';

export const UNSENT_STORAGE_KEY = 'aa_unsent';

export function parseStoredUnsent(raw: string | null): Record<string, UnsentRecord> {
  const result: Record<string, UnsentRecord> = {};
  if (!raw) return result;
  let saved: unknown = null;
  try {
    saved = JSON.parse(raw);
  } catch {
    return result;
  }
  if (!saved || typeof saved !== 'object') return result;
  for (const [nonce, value] of Object.entries(saved as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const rec = value as Record<string, unknown>;
    if (typeof rec.t !== 'string' || typeof rec.x !== 'string') continue;
    result[nonce] = {
      t: rec.t,
      x: rec.x,
      n: Array.isArray(rec.n) ? rec.n.map(String) : [],
      at: Number(rec.at) || 0,
      s: rec.s === 'failed' ? 'failed' : 'unsure',
      g: Number(rec.g) || 0,
    };
  }
  return result;
}

export function localBody(typed: string, names: readonly string[]): string {
  const h = `<div class="raw">${text(typed)}</div>`;
  if (!names.length) return h;
  let chips = '';
  for (const name of names) chips += `<span class="chip">${text(name)}</span>`;
  return `${h}<div class="files">${chips}</div>`;
}

export function localMsg(nonce: string, r: UnsentRecord): LocalBubbleMessage {
  return {
    id: `p:${nonce}`,
    _local: 1,
    _nonce: nonce,
    _state: r.s,
    _text: r.x,
    own: true,
    html: localBody(r.x, r.n),
    at: r.at,
    buttons: [],
    reactions: [],
  };
}

export function shouldQueueOptimistically(typed: string, curTopic: ComposerTopic | undefined): boolean {
  if (!curTopic || !curTopic.running || curTopic.asking) return false;
  if (/^\s*\//.test(typed)) return false;
  return true;
}

// 4-byte big-endian JSON header length + UTF-8 metadata + raw file bytes (matches server.ts readFramedSend).
export function framed(body: SendBody): Uint8Array {
  const files = body.files ?? [];
  const meta: {
    topic: string;
    text: string;
    files: { name: string; mime: string; size: number }[];
    nonce?: string;
    quiet?: boolean;
  } = { topic: body.topic, text: body.text, files: [] };
  if (body.nonce) meta.nonce = body.nonce;
  if (body.quiet) meta.quiet = true;

  const parts: string[] = [];
  let total = 0;
  for (const f of files) {
    const bin = atob(f.data);
    meta.files.push({ name: f.name, mime: f.mime || '', size: bin.length });
    parts.push(bin);
    total += bin.length;
  }

  const headBytes = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + headBytes.length + total);
  out[0] = (headBytes.length >>> 24) & 255;
  out[1] = (headBytes.length >>> 16) & 255;
  out[2] = (headBytes.length >>> 8) & 255;
  out[3] = headBytes.length & 255;
  out.set(headBytes, 4);
  let at = 4 + headBytes.length;
  for (const part of parts) {
    for (let j = 0; j < part.length; j++) out[at++] = part.charCodeAt(j);
  }
  return out;
}

export interface UnsentDeps {
  readonly doc: Document;
  readonly storage: Storage | undefined;
  readonly getTopic: () => string;
  readonly topicById: (id: string) => ComposerTopic | undefined;
  readonly getEpoch: () => number;
  readonly settleAdopted: (topicId: string, typed: string) => void;
  readonly cacheSave: () => void;
  readonly copyText: (value: string, done: (ok: boolean) => void) => void;
  readonly topicStatus: ComposerTopicStatusBridge;
  readonly transcript: ComposerTranscriptBridge;
  readonly postFn?: (path: string, body: unknown, tries?: number, limit?: number) => Promise<Response>;
  readonly now?: () => number;
}

export interface UnsentController {
  hasOutbox(nonce: string): boolean;
  dropUnsent(nonce: string): void;
  retireLocalNonce(nonce: string): void;
  showUnsent(topicId: string): void;
  settleUnsure(): void;
  adoptLegacy(msg: LegacyLocalMessage): boolean;
  dispatch(typed: string, attached: readonly ComposerAttachment[]): void;
  deliver(nonce: string): void;
  setLocal(nonce: string, state: LocalBubbleState): void;
  copyLocal(nonce: string, btn: HTMLElement): void;
  discardLocal(nonce: string): void;
  claim(msg: EchoMessage): void;
  forgetTopic(id: string): void;
  pruneTopics(known: Readonly<Record<string, unknown>>): void;
  keepOnly(keep: Readonly<Record<string, unknown>>): void;
}

function readRaw(storage: Storage | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

class UnsentControllerImpl implements UnsentController {
  private readonly postFn: (path: string, body: unknown, tries?: number, limit?: number) => Promise<Response>;
  private readonly nowFn: () => number;
  private readonly outbox: Record<string, SendBody> = {};
  private readonly unsent: Record<string, UnsentRecord>;

  constructor(private readonly deps: UnsentDeps) {
    this.postFn = deps.postFn ?? post;
    this.nowFn = deps.now ?? (() => Date.now());
    this.unsent = parseStoredUnsent(readRaw(deps.storage, UNSENT_STORAGE_KEY));
  }

  hasOutbox(nonce: string): boolean {
    return Boolean(this.outbox[nonce]);
  }

  private writeUnsent(nonce: string): void {
    if (!this.deps.storage) return;
    try {
      const parsed = JSON.parse(this.deps.storage.getItem(UNSENT_STORAGE_KEY) || 'null') as Record<
        string,
        UnsentRecord
      > | null;
      const all: Record<string, UnsentRecord> = parsed && typeof parsed === 'object' ? parsed : {};
      const r = this.unsent[nonce];
      if (r && r.x.length <= DRAFT_MAX) {
        all[nonce] = r;
      } else if (Object.prototype.hasOwnProperty.call(all, nonce)) {
        delete all[nonce];
      } else {
        return;
      }
      const hasLeft = Object.keys(all).length > 0;
      if (hasLeft) this.deps.storage.setItem(UNSENT_STORAGE_KEY, JSON.stringify(all));
      else this.deps.storage.removeItem(UNSENT_STORAGE_KEY);
    } catch {
      // Ignore storage errors.
    }
  }

  dropUnsent(nonce: string): void {
    if (!this.unsent[nonce]) return;
    delete this.unsent[nonce];
    this.writeUnsent(nonce);
  }

  retireLocalNonce(nonce: string): void {
    const pk = `p:${nonce}`;
    delete this.outbox[nonce];
    const r = this.unsent[nonce];
    this.dropUnsent(nonce);
    if (r) this.deps.settleAdopted(r.t, r.x);
    this.deps.transcript.removeElement(pk);
    this.deps.transcript.deleteMessage(pk);
  }

  setLocal(nonce: string, state: LocalBubbleState): void {
    const r = this.unsent[nonce];
    if (r && r.s !== state) {
      if (state === 'sent') {
        delete this.unsent[nonce];
        this.deps.settleAdopted(r.t, r.x);
      } else {
        r.s = state;
      }
      this.writeUnsent(nonce);
    }
    if (this.deps.topicStatus.hasLocalPending(nonce)) {
      if (state === 'failed') {
        this.deps.topicStatus.removeLocalPending(nonce);
        if (r && r.t === this.deps.getTopic()) {
          const pk = `p:${nonce}`;
          this.deps.transcript.setMessage(pk, localMsg(nonce, r));
          this.deps.transcript.paint(pk);
          this.deps.transcript.syncEmptyNote();
          this.deps.transcript.toBottom();
        }
      }
      return;
    }
    const key = `p:${nonce}`;
    const msg = this.deps.transcript.getMessage(key);
    if (!msg) return;
    const stick = this.deps.transcript.atBottom();
    msg._state = state;
    this.deps.transcript.paint(key);
    if (stick) this.deps.transcript.toBottom();
  }

  deliver(nonce: string): void {
    const body = this.outbox[nonce];
    if (!body) return;
    this.setLocal(nonce, 'sending');
    let sent: Promise<Response>;
    try {
      sent = this.postFn('api/send', body.files ? framed(body) : body, 2, sendLimit(body));
    } catch (err) {
      sent = Promise.reject(err);
    }
    sent.then(
      (res) => {
        this.setLocal(nonce, res && res.ok ? 'sent' : 'failed');
      },
      () => {
        this.setLocal(nonce, 'failed');
      },
    );
  }

  dispatch(typed: string, attached: readonly ComposerAttachment[]): void {
    const topicId = this.deps.getTopic();
    const nonce = Math.random().toString(36).slice(2) + this.nowFn().toString(36);
    const body: SendBody = { topic: topicId, text: typed, nonce };
    const names = attached.map((a) => a.name);
    if (attached.length) body.files = [...attached];
    this.outbox[nonce] = body;
    const record: UnsentRecord = {
      t: topicId,
      x: typed,
      n: names,
      at: this.nowFn(),
      s: 'sending',
      g: this.deps.getEpoch(),
    };
    this.unsent[nonce] = record;
    this.writeUnsent(nonce);

    if (shouldQueueOptimistically(typed, this.deps.topicById(topicId))) {
      this.deps.topicStatus.addLocalPending({
        topic: topicId,
        nonce,
        content: typed,
        attachments: names.length,
        at: record.at,
      });
    } else {
      const pk = `p:${nonce}`;
      const bubble = localMsg(nonce, record);
      this.deps.transcript.setMessage(pk, bubble);
      this.deps.transcript.paint(pk);
      this.deps.transcript.onBtwAsked(pk, bubble);
      this.deps.transcript.syncEmptyNote();
      this.deps.transcript.toBottom();
    }
    this.deliver(nonce);
  }

  showUnsent(topicId: string): void {
    const list: string[] = [];
    for (const nonce of Object.keys(this.unsent)) {
      const rec = this.unsent[nonce];
      if (
        rec &&
        rec.t === topicId &&
        !this.deps.transcript.getMessage(`p:${nonce}`) &&
        !this.deps.topicStatus.hasLocalPending(nonce)
      ) {
        list.push(nonce);
      }
    }
    if (!list.length) return;
    list.sort((a, b) => (this.unsent[a]?.at ?? 0) - (this.unsent[b]?.at ?? 0));
    const stick = this.deps.transcript.atBottom();
    for (const nonce of list) {
      const rec = this.unsent[nonce];
      if (!rec) continue;
      if (!this.outbox[nonce] && !rec.n.length) {
        this.outbox[nonce] = { topic: rec.t, text: rec.x, nonce };
      }
      const pk = `p:${nonce}`;
      this.deps.transcript.setMessage(pk, localMsg(nonce, rec));
      this.deps.transcript.paint(pk);
    }
    this.deps.transcript.sinkLocals();
    this.deps.transcript.syncEmptyNote();
    if (stick) this.deps.transcript.toBottom();
  }

  settleUnsure(): void {
    const curTopic = this.deps.getTopic();
    const curEpoch = this.deps.getEpoch();
    for (const nonce of Object.keys(this.unsent)) {
      const rec = this.unsent[nonce];
      if (rec && rec.t === curTopic && rec.s === 'unsure' && rec.g && rec.g === curEpoch) {
        this.setLocal(nonce, 'failed');
      }
    }
  }

  adoptLegacy(msg: LegacyLocalMessage): boolean {
    const nonce = msg._nonce;
    if (!nonce || this.unsent[nonce]) return false;
    const tpl = this.deps.doc.createElement('template');
    tpl.innerHTML = String(msg.html || '');
    const chipNodes = tpl.content.querySelectorAll('.files .chip');
    const names: string[] = [];
    for (let i = 0; i < chipNodes.length; i++) {
      names.push(chipNodes[i]?.textContent ?? '');
    }
    this.unsent[nonce] = {
      t: this.deps.getTopic(),
      x: String(msg._text || ''),
      n: names,
      at: Number(msg.at) || 0,
      s: 'failed',
      g: 0,
    };
    this.writeUnsent(nonce);
    return true;
  }

  copyLocal(nonce: string, btn: HTMLElement): void {
    const msg = this.deps.transcript.getMessage(`p:${nonce}`);
    if (!msg) return;
    this.deps.copyText(msg._text, (ok) => {
      btn.textContent = ok ? tr('common.copied') : tr('common.selectAbove');
    });
  }

  discardLocal(nonce: string): void {
    delete this.outbox[nonce];
    this.dropUnsent(nonce);
    this.deps.transcript.drop(`p:${nonce}`);
    this.deps.cacheSave();
  }

  claim(msg: EchoMessage): void {
    if (!msg.nonce) return;
    this.deps.topicStatus.removeLocalPending(msg.nonce);
    const pk = `p:${msg.nonce}`;
    delete this.outbox[msg.nonce];
    const r = this.unsent[msg.nonce];
    this.dropUnsent(msg.nonce);
    if (r) this.deps.settleAdopted(r.t, r.x);
    if (!this.deps.transcript.hasElement(pk)) return;
    const key = `${msg.g || this.deps.getEpoch()}:${msg.id}`;
    if (this.deps.transcript.hasElement(key)) {
      this.deps.transcript.removeElement(pk);
    } else {
      this.deps.transcript.adoptElement(pk, key);
    }
    this.deps.transcript.deleteMessage(pk);
    this.deps.transcript.onClaimKeyMoved(pk, key);
  }

  forgetTopic(id: string): void {
    for (const nonce of Object.keys(this.unsent)) {
      if (this.unsent[nonce]?.t === id) this.dropUnsent(nonce);
    }
  }

  pruneTopics(known: Readonly<Record<string, unknown>>): void {
    for (const nonce of Object.keys(this.unsent)) {
      const rec = this.unsent[nonce];
      if (rec && !known[rec.t]) this.dropUnsent(nonce);
    }
  }

  keepOnly(keep: Readonly<Record<string, unknown>>): void {
    for (const nonce of Object.keys(this.unsent)) {
      const rec = this.unsent[nonce];
      if (rec && !keep[rec.t]) delete this.unsent[nonce];
    }
    if (!this.deps.storage) return;
    try {
      const parsed = JSON.parse(this.deps.storage.getItem(UNSENT_STORAGE_KEY) || 'null') as Record<
        string,
        UnsentRecord
      > | null;
      const out: Record<string, UnsentRecord> = parsed && typeof parsed === 'object' ? parsed : {};
      let kept = 0;
      for (const nonce of Object.keys(out)) {
        const rec = out[nonce];
        if (!(rec && keep[rec.t])) delete out[nonce];
        else kept++;
      }
      if (kept) this.deps.storage.setItem(UNSENT_STORAGE_KEY, JSON.stringify(out));
      else this.deps.storage.removeItem(UNSENT_STORAGE_KEY);
    } catch {
      // Ignore storage errors.
    }
  }
}

export function createUnsentController(deps: UnsentDeps): UnsentController {
  return new UnsentControllerImpl(deps);
}
