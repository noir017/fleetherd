import { describe, expect, it, vi } from 'vitest';

import { CommandRegistry } from './commands.js';

describe('services/commands', () => {
  it('registers, lists, executes, and unregisters commands', async () => {
    const reg = new CommandRegistry();
    const onChange = vi.fn();
    reg.onDidChange(onChange);

    const d = reg.register(
      'topic.open',
      (id: unknown) => `opened:${String(id)}`,
      { title: 'Open topic', keybinding: 'Mod+K' },
    );

    expect(reg.has('topic.open')).toBe(true);
    expect(reg.get('topic.open')?.meta?.title).toBe('Open topic');
    expect(reg.list()).toHaveLength(1);
    await expect(reg.execute('topic.open', 'abc')).resolves.toBe('opened:abc');

    d.dispose();
    expect(reg.has('topic.open')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
    await expect(reg.execute('topic.open')).rejects.toThrow(/Unknown command/);
  });

  it('rejects duplicate or empty command ids', () => {
    const reg = new CommandRegistry();
    expect(() => reg.register('', () => {})).toThrow(/empty/);
    const d = reg.register('cmd.a', () => 1);
    expect(() => reg.register('cmd.a', () => 2)).toThrow(/already registered/);
    d.dispose();
    expect(() => reg.register('cmd.a', () => 2)).not.toThrow();
  });
});
