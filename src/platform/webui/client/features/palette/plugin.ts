import { type Disposable, toDisposable } from '../../base/lifecycle.js';
import { openQuickPick } from '../../components/quickpick/index.js';
import { definePlugin, type PluginContext, type WebuiPlugin } from '../../plugins/api.js';
import type { CommandEntry } from '../../services/commands.js';
import { detectMac } from '../../services/keybindings.js';
import { buildCommandQuickPickItems, buildTopicQuickPickItems } from './format.js';
import { PALETTE_I18N_EN, PALETTE_I18N_ZH_CN } from './i18n.js';
import { renderPaletteIcon } from './icons.js';
import { openKeybindingsDialog } from './keybindings-dialog.js';
import { PALETTE_COMMAND_IDS, type PalettePluginDeps } from './types.js';

export { PALETTE_COMMAND_IDS, type PaletteCommandId, type PalettePluginDeps } from './types.js';

type ActiveOverlayKind = 'topics' | 'commands' | 'keybindings';

interface ActiveOverlay {
  readonly kind: ActiveOverlayKind;
  dispose(): void;
}

const PALETTE_CATEGORY = 'Palette';

function resolveCommandList(deps: PalettePluginDeps): readonly CommandEntry[] {
  if (deps.listCommands) return deps.listCommands();
  if (deps.commands) return deps.commands.list();
  return [];
}

function registerAllowInInputBindings(
  ctx: PluginContext,
  deps: PalettePluginDeps,
): void {
  if (!deps.keybindings) return;
  const specs: readonly { readonly command: string; readonly keybinding: string }[] = [
    { command: PALETTE_COMMAND_IDS.quickOpenTopic, keybinding: 'Mod+K' },
    { command: PALETTE_COMMAND_IDS.commands, keybinding: 'Mod+Shift+P' },
    { command: PALETTE_COMMAND_IDS.keybindings, keybinding: 'Mod+/' },
  ];
  for (const spec of specs) {
    ctx.subscriptions.add(
      deps.keybindings.register({
        keybinding: spec.keybinding,
        command: spec.command,
        allowInInput: true,
      }),
    );
  }
}

export function createPalettePlugin(deps: PalettePluginDeps = {}): WebuiPlugin {
  let activeOverlay: ActiveOverlay | null = null;

  const closeActiveOverlay = (): void => {
    if (!activeOverlay) return;
    const current = activeOverlay;
    activeOverlay = null;
    current.dispose();
  };

  const toggleOrReplace = (kind: ActiveOverlayKind): boolean => {
    if (activeOverlay?.kind === kind) {
      closeActiveOverlay();
      return false;
    }
    closeActiveOverlay();
    return true;
  };

  const trackOverlay = (kind: ActiveOverlayKind, handle: Disposable): void => {
    const entry: ActiveOverlay = { kind, dispose: () => handle.dispose() };
    activeOverlay = entry;
  };

  const clearOverlayIfCurrent = (kind: ActiveOverlayKind): void => {
    if (activeOverlay?.kind === kind) {
      activeOverlay = null;
    }
  };

  return definePlugin({
    id: 'palette',
    activate(ctx) {
      ctx.i18n.add('en', { ...PALETTE_I18N_EN });
      ctx.i18n.add('zh-CN', { ...PALETTE_I18N_ZH_CN });

      const t = (key: string, vars?: Record<string, unknown>): string => ctx.i18n.t(key, vars);
      const isMac = deps.isMac ?? detectMac();

      const openTopicQuickPick = (): void => {
        if (!toggleOrReplace('topics')) return;
        const items = buildTopicQuickPickItems(ctx.topics.list(), ctx.topics.active()?.id, t);
        const qp = openQuickPick({
          items,
          placeholder: t('palette.topicPlaceholder'),
          emptyText: t('palette.topicEmpty'),
          searchIcon: renderPaletteIcon('search'),
          overlays: deps.overlays,
          container: deps.container,
          doc: deps.doc,
          className: 'fh-palette-topics',
          onSelect: (picked) => {
            clearOverlayIfCurrent('topics');
            if (picked.data) ctx.topics.open(picked.data.id);
          },
          onCancel: () => {
            clearOverlayIfCurrent('topics');
          },
        });
        trackOverlay('topics', qp);
      };

      const openCommandPalette = (): void => {
        if (!toggleOrReplace('commands')) return;
        const items = buildCommandQuickPickItems(resolveCommandList(deps), isMac);
        const qp = openQuickPick({
          items,
          placeholder: t('palette.commandPlaceholder'),
          emptyText: t('palette.commandEmpty'),
          searchIcon: renderPaletteIcon('command'),
          overlays: deps.overlays,
          container: deps.container,
          doc: deps.doc,
          className: 'fh-palette-commands',
          onSelect: (picked) => {
            clearOverlayIfCurrent('commands');
            if (!picked.data) return;
            const cmdId = picked.data.id;
            void ctx.commands.execute(cmdId).catch((err: unknown) => {
              deps.onCommandError?.(cmdId, err);
            });
          },
          onCancel: () => {
            clearOverlayIfCurrent('commands');
          },
        });
        trackOverlay('commands', qp);
      };

      const openKeybindings = (): void => {
        if (!toggleOrReplace('keybindings')) return;
        const dialog = openKeybindingsDialog({
          listCommands: () => resolveCommandList(deps),
          listExtraKeybindings: deps.extraKeybindings,
          isMac,
          t,
          overlays: deps.overlays,
          container: deps.container,
          doc: deps.doc,
          onClose: () => {
            clearOverlayIfCurrent('keybindings');
          },
        });
        trackOverlay('keybindings', dialog);
      };

      ctx.commands.register(PALETTE_COMMAND_IDS.quickOpenTopic, openTopicQuickPick, {
        title: `${PALETTE_CATEGORY}: ${t('palette.cmdQuickOpenTopic')}`,
        keybinding: 'Mod+K',
      });
      ctx.commands.register(PALETTE_COMMAND_IDS.commands, openCommandPalette, {
        title: `${PALETTE_CATEGORY}: ${t('palette.cmdCommands')}`,
        keybinding: 'Mod+Shift+P',
      });
      ctx.commands.register(PALETTE_COMMAND_IDS.keybindings, openKeybindings, {
        title: `${PALETTE_CATEGORY}: ${t('palette.cmdKeybindings')}`,
        keybinding: 'Mod+/',
      });

      registerAllowInInputBindings(ctx, deps);
      ctx.subscriptions.add(toDisposable(closeActiveOverlay));
    },
    deactivate() {
      closeActiveOverlay();
    },
  });
}
