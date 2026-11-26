import { describe, expect, it, vi } from 'vitest';

import {
  KeybindingService,
  matchesKeybinding,
  normalizeKeybinding,
  parseKeybinding,
} from './keybindings.js';

describe('services/keybindings', () => {
  it('parses and normalizes Mod across Mac and non-Mac', () => {
    expect(parseKeybinding('Mod+Shift+P', false)).toEqual({
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
      key: 'p',
    });
    expect(parseKeybinding('Mod+Shift+P', true)).toEqual({
      ctrl: false,
      alt: false,
      shift: true,
      meta: true,
      key: 'p',
    });
    expect(normalizeKeybinding('Shift+Ctrl+Esc')).toBe('ctrl+shift+escape');
    expect(normalizeKeybinding('Cmd+Space', true)).toBe('meta+space');
    expect(() => parseKeybinding('')).toThrow();
    expect(() => parseKeybinding('Ctrl+Shift')).toThrow();
    expect(() => parseKeybinding('Ctrl+A+B')).toThrow();
  });

  it('matches exact modifiers and key case-insensitively', () => {
    const binding = parseKeybinding('Mod+K', false);
    expect(matchesKeybinding({ key: 'k', ctrlKey: true }, binding)).toBe(true);
    expect(matchesKeybinding({ key: 'K', ctrlKey: true }, binding)).toBe(true);
    expect(matchesKeybinding({ key: 'k', ctrlKey: true, shiftKey: true }, binding)).toBe(false);
    expect(matchesKeybinding({ key: 'k', metaKey: true }, binding)).toBe(false);
  });

  it('dispatches commands, ignores IME composition and editable inputs unless allowed', () => {
    const executed: Array<[string, unknown[]]> = [];
    const svc = new KeybindingService({
      isMac: false,
      executeCommand: (id, ...args) => {
        executed.push([id, args]);
      },
    });
    svc.register({ keybinding: 'Mod+K', command: 'quick.open', args: ['topics'] });
    svc.register({ keybinding: 'Mod+S', command: 'file.save', allowInInput: true });

    const preventDefault = vi.fn();
    expect(svc.handleKeydown({ key: 'k', ctrlKey: true, isComposing: true, preventDefault })).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();

    const textareaTarget = { tagName: 'TEXTAREA' } as unknown as EventTarget;
    expect(svc.handleKeydown({ key: 'k', ctrlKey: true, target: textareaTarget, preventDefault })).toBe(false);
    expect(svc.handleKeydown({ key: 's', ctrlKey: true, target: textareaTarget, preventDefault })).toBe(true);
    expect(svc.handleKeydown({ key: 'k', ctrlKey: true, preventDefault })).toBe(true);

    expect(executed).toEqual([
      ['file.save', []],
      ['quick.open', ['topics']],
    ]);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    svc.dispose();
  });

  it('prefers the most recently registered matching binding and honours when()', () => {
    const calls: string[] = [];
    let modalOpen = false;
    const svc = new KeybindingService({
      isMac: false,
      executeCommand: (id) => calls.push(id),
    });
    svc.register({ keybinding: 'Ctrl+P', command: 'base' });
    const d = svc.register({
      keybinding: 'Ctrl+P',
      command: 'modal',
      when: () => modalOpen,
    });

    svc.handleKeydown({ key: 'p', ctrlKey: true });
    modalOpen = true;
    svc.handleKeydown({ key: 'p', ctrlKey: true });
    d.dispose();
    svc.handleKeydown({ key: 'p', ctrlKey: true });

    expect(calls).toEqual(['base', 'modal', 'base']);
  });
});
