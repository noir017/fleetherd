import type { CommandEntry, CommandRegistry } from '../../services/commands.js';
import type { KeybindingService } from '../../services/keybindings.js';
import type { OverlayManager } from '../../services/overlays.js';

export const PALETTE_COMMAND_IDS = {
  quickOpenTopic: 'palette.quickOpenTopic',
  commands: 'palette.commands',
  keybindings: 'palette.keybindings',
} as const;

export type PaletteCommandId = (typeof PALETTE_COMMAND_IDS)[keyof typeof PALETTE_COMMAND_IDS];

export interface KeybindingDisplayItem {
  readonly command: string;
  readonly keybinding: string;
  readonly title?: string;
  readonly category?: string;
}

export interface ResolvedKeybindingRow {
  readonly command: string;
  readonly title: string;
  readonly category: string;
  readonly keybinding: string;
  readonly display: string;
  readonly tokens: readonly string[];
}

export interface KeybindingGroup {
  readonly category: string;
  readonly items: readonly ResolvedKeybindingRow[];
}

export interface PalettePluginDeps {
  readonly commands?: CommandRegistry;
  readonly listCommands?: () => readonly CommandEntry[];
  readonly keybindings?: KeybindingService;
  readonly extraKeybindings?: () => readonly KeybindingDisplayItem[];
  readonly overlays?: OverlayManager;
  readonly container?: HTMLElement;
  readonly doc?: Document;
  readonly isMac?: boolean;
  readonly onCommandError?: (commandId: string, error: unknown) => void;
}
