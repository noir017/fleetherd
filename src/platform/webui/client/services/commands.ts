import { Emitter, type Event } from '../base/event.js';
import { type Disposable, toDisposable } from '../base/lifecycle.js';

export interface CommandMetadata {
  readonly title?: string;
  readonly keybinding?: string;
  readonly category?: string;
}

export type CommandHandler = (...args: unknown[]) => unknown;

export interface CommandEntry {
  readonly id: string;
  readonly run: CommandHandler;
  readonly meta?: CommandMetadata;
}

export class CommandRegistry implements Disposable {
  private readonly _commands = new Map<string, CommandEntry>();
  private readonly _onDidChange = new Emitter<void>();

  readonly onDidChange: Event<void> = this._onDidChange.event;

  register(id: string, run: CommandHandler, meta?: CommandMetadata): Disposable {
    if (!id) throw new Error('Command id must not be empty');
    if (this._commands.has(id)) {
      throw new Error(`Command already registered: ${id}`);
    }
    const entry: CommandEntry = meta ? { id, run, meta } : { id, run };
    this._commands.set(id, entry);
    this._onDidChange.fire();
    return toDisposable(() => {
      if (this._commands.get(id) === entry) {
        this._commands.delete(id);
        this._onDidChange.fire();
      }
    });
  }

  has(id: string): boolean {
    return this._commands.has(id);
  }

  get(id: string): CommandEntry | undefined {
    return this._commands.get(id);
  }

  list(): readonly CommandEntry[] {
    return [...this._commands.values()];
  }

  async execute(id: string, ...args: unknown[]): Promise<unknown> {
    const entry = this._commands.get(id);
    if (!entry) throw new Error(`Unknown command: ${id}`);
    return await entry.run(...args);
  }

  dispose(): void {
    this._commands.clear();
    this._onDidChange.dispose();
  }
}
