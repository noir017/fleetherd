import { addDisposableListener, isEditableTarget } from '../base/dom.js';
import { type Disposable, DisposableStore, toDisposable } from '../base/lifecycle.js';

export interface ParsedKeybinding {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly key: string;
}

export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly metaKey?: boolean;
  readonly isComposing?: boolean;
  readonly target?: EventTarget | null;
  preventDefault?(): void;
  stopPropagation?(): void;
}

export interface KeybindingEntry {
  readonly keybinding: string;
  readonly command: string;
  readonly args?: readonly unknown[];
  readonly when?: () => boolean;
  readonly allowInInput?: boolean;
}

export interface KeybindingServiceOptions {
  readonly executeCommand: (id: string, ...args: unknown[]) => unknown;
  readonly isMac?: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  space: ' ',
  spacebar: ' ',
  del: 'delete',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  plus: '+',
};

function normalizeKeyName(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

export function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
}

export function parseKeybinding(spec: string, isMac = false): ParsedKeybinding {
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`Invalid keybinding: ${spec}`);
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  let key = '';

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'mod') {
      if (isMac) meta = true;
      else ctrl = true;
    } else if (lower === 'ctrl' || lower === 'control') {
      ctrl = true;
    } else if (lower === 'alt' || lower === 'option' || lower === 'opt') {
      alt = true;
    } else if (lower === 'shift') {
      shift = true;
    } else if (lower === 'meta' || lower === 'cmd' || lower === 'command') {
      meta = true;
    } else {
      if (key) throw new Error(`Multiple keys in keybinding: ${spec}`);
      key = normalizeKeyName(part);
    }
  }
  if (!key) throw new Error(`Missing key in keybinding: ${spec}`);
  return { ctrl, alt, shift, meta, key };
}

export function normalizeKeybinding(spec: string, isMac = false): string {
  const parsed = parseKeybinding(spec, isMac);
  const tokens: string[] = [];
  if (parsed.ctrl) tokens.push('ctrl');
  if (parsed.alt) tokens.push('alt');
  if (parsed.shift) tokens.push('shift');
  if (parsed.meta) tokens.push('meta');
  tokens.push(parsed.key === ' ' ? 'space' : parsed.key);
  return tokens.join('+');
}

export function matchesKeybinding(ev: KeyEventLike, binding: ParsedKeybinding): boolean {
  if (Boolean(ev.ctrlKey) !== binding.ctrl) return false;
  if (Boolean(ev.altKey) !== binding.alt) return false;
  if (Boolean(ev.shiftKey) !== binding.shift) return false;
  if (Boolean(ev.metaKey) !== binding.meta) return false;
  return normalizeKeyName(ev.key) === binding.key;
}

interface CompiledBinding {
  readonly parsed: ParsedKeybinding;
  readonly entry: KeybindingEntry;
}

export class KeybindingService implements Disposable {
  private readonly _bindings: CompiledBinding[] = [];
  private readonly _disposables = new DisposableStore();
  private readonly _executeCommand: (id: string, ...args: unknown[]) => unknown;
  private readonly _isMac: boolean;

  constructor(options: KeybindingServiceOptions) {
    this._executeCommand = options.executeCommand;
    this._isMac = options.isMac ?? detectMac();
  }

  register(entry: KeybindingEntry): Disposable {
    const compiled: CompiledBinding = {
      parsed: parseKeybinding(entry.keybinding, this._isMac),
      entry,
    };
    this._bindings.push(compiled);
    return toDisposable(() => {
      const idx = this._bindings.indexOf(compiled);
      if (idx >= 0) this._bindings.splice(idx, 1);
    });
  }

  handleKeydown(ev: KeyEventLike): boolean {
    if (ev.isComposing) return false;
    const inInput = isEditableTarget(ev.target ?? null);
    for (let i = this._bindings.length - 1; i >= 0; i--) {
      const item = this._bindings[i];
      if (!item) continue;
      if (inInput && !item.entry.allowInInput) continue;
      if (!matchesKeybinding(ev, item.parsed)) continue;
      if (item.entry.when && !item.entry.when()) continue;
      ev.preventDefault?.();
      void this._executeCommand(item.entry.command, ...(item.entry.args ?? []));
      return true;
    }
    return false;
  }

  attach(target: EventTarget = document): Disposable {
    const sub = addDisposableListener(target, 'keydown', (ev) => {
      this.handleKeydown(ev as KeyboardEvent);
    });
    return this._disposables.add(sub);
  }

  dispose(): void {
    this._bindings.length = 0;
    this._disposables.dispose();
  }
}
