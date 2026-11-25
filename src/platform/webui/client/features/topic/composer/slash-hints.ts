import { addDisposableListener } from '../../../base/dom.js';
import type { Disposable } from '../../../base/lifecycle.js';
import { text } from '../../../services/api.js';
import type { SlashCommand } from './types.js';

export function findArgCommand(value: string, commands: readonly SlashCommand[]): SlashCommand | null {
  if (value.charAt(0) !== '/' || value.charAt(value.length - 1) !== ' ') return null;
  const name = value.slice(1, -1);
  for (const cmd of commands) {
    if (cmd.name === name && cmd.options && cmd.options.length > 0) return cmd;
  }
  return null;
}

export function filterSlashCommands(
  value: string,
  commands: readonly SlashCommand[],
  limit = 8,
): SlashCommand[] {
  if (value.charAt(0) !== '/' || value.indexOf(' ') >= 0 || value.indexOf('\n') >= 0) return [];
  const query = value.slice(1).toLowerCase();
  return commands.filter((c) => c.name.indexOf(query) === 0).slice(0, limit);
}

export function renderSlashHintsHtml(value: string, commands: readonly SlashCommand[]): string {
  const picked = findArgCommand(value, commands);
  const firstOpt = picked?.options?.[0];
  if (picked && firstOpt) {
    return `<span class="arg-hint"><b>/${text(picked.name)} &lt;${text(firstOpt.name)}&gt;</b> — ${text(picked.description)}</span>`;
  }
  const hits = filterSlashCommands(value, commands, 8);
  if (!hits.length) return '';
  let html = '';
  for (const hit of hits) {
    html += `<button type="button" data-cmd="${text(hit.name)}" title="${text(hit.description)}">/${text(hit.name)}</button>`;
  }
  return html;
}

export interface SlashHintsDeps {
  readonly input: HTMLTextAreaElement;
  readonly hints: HTMLElement;
  readonly onPick: () => void;
}

export interface SlashHintsController {
  setCommands(list: readonly SlashCommand[]): void;
  suggest(): void;
  isOpen(): boolean;
  close(): void;
  attach(): Disposable;
}

export function createSlashHintsController(deps: SlashHintsDeps): SlashHintsController {
  let commands: readonly SlashCommand[] = [];

  function suggest(): void {
    const html = renderSlashHintsHtml(deps.input.value, commands);
    if (!html) {
      if (!deps.hints.hidden) deps.hints.hidden = true;
      if (deps.hints.innerHTML) deps.hints.innerHTML = '';
      return;
    }
    if (deps.hints.innerHTML !== html) deps.hints.innerHTML = html;
    if (deps.hints.hidden) deps.hints.hidden = false;
  }

  function close(): void {
    deps.hints.hidden = true;
    deps.hints.innerHTML = '';
  }

  function attach(): Disposable {
    return addDisposableListener(deps.hints, 'click', (e) => {
      const target = e.target;
      const btn = target instanceof Element ? target.closest<HTMLButtonElement>('button[data-cmd]') : null;
      if (!btn) return;
      const cmd = btn.getAttribute('data-cmd');
      if (!cmd) return;
      deps.input.value = `/${cmd} `;
      suggest();
      deps.input.focus();
      deps.onPick();
    });
  }

  return {
    setCommands(list) {
      commands = list;
    },
    suggest,
    isOpen: () => !deps.hints.hidden,
    close,
    attach,
  };
}
