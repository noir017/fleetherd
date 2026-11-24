// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  createSlashHintsController,
  filterSlashCommands,
  findArgCommand,
  renderSlashHintsHtml,
} from './slash-hints.js';
import type { SlashCommand } from './types.js';

const COMMANDS: SlashCommand[] = [
  { name: 'super', description: 'Run sub-agents', options: [{ name: 'task' }] },
  { name: 'stop', description: 'Stop current turn' },
  { name: 'setting', description: 'Open settings' },
  { name: 'status', description: 'Show status' },
];

describe('composer/slash-hints', () => {
  it('matches prefix slash commands and ignores plain text or multi-line input', () => {
    expect(filterSlashCommands('/s', COMMANDS).map((c) => c.name)).toEqual([
      'super',
      'stop',
      'setting',
      'status',
    ]);
    expect(filterSlashCommands('/st', COMMANDS).map((c) => c.name)).toEqual(['stop', 'status']);
    expect(filterSlashCommands('hello', COMMANDS)).toEqual([]);
    expect(filterSlashCommands('/stop now', COMMANDS)).toEqual([]);
    expect(filterSlashCommands('/stop\n', COMMANDS)).toEqual([]);
  });

  it('detects argument hint when a command with options is followed by a trailing space', () => {
    expect(findArgCommand('/super ', COMMANDS)?.name).toBe('super');
    expect(findArgCommand('/stop ', COMMANDS)).toBeNull();
    expect(findArgCommand('/super task', COMMANDS)).toBeNull();
    expect(renderSlashHintsHtml('/super ', COMMANDS)).toContain('/super &lt;task&gt;');
  });

  it('fills input on hint click and invokes onPick', () => {
    const input = document.createElement('textarea');
    const hints = document.createElement('div');
    hints.hidden = true;
    document.body.append(input, hints);

    const onPick = vi.fn();
    const ctrl = createSlashHintsController({ input, hints, onPick });
    const sub = ctrl.attach();
    ctrl.setCommands(COMMANDS);

    input.value = '/su';
    ctrl.suggest();
    expect(ctrl.isOpen()).toBe(true);
    const btn = hints.querySelector<HTMLButtonElement>('button[data-cmd="super"]');
    expect(btn).not.toBeNull();
    btn?.click();

    expect(input.value).toBe('/super ');
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(hints.innerHTML).toContain('arg-hint');

    ctrl.close();
    expect(ctrl.isOpen()).toBe(false);
    expect(hints.innerHTML).toBe('');
    sub.dispose();
  });
});
