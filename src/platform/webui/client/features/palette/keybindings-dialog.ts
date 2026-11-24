import { focusSafely } from '../../base/dom.js';
import { html, nothing, render, type TemplateResult } from '../../base/html.js';
import { openDialog, type DialogController } from '../../components/dialog/index.js';
import type { CommandEntry } from '../../services/commands.js';
import type { OverlayManager } from '../../services/overlays.js';
import { collectKeybindingGroups, type TranslateFn } from './format.js';
import { renderPaletteIcon } from './icons.js';
import type { KeybindingDisplayItem, KeybindingGroup } from './types.js';

export interface KeybindingsDialogOptions {
  readonly listCommands: () => readonly CommandEntry[];
  readonly listExtraKeybindings?: () => readonly KeybindingDisplayItem[];
  readonly isMac: boolean;
  readonly t: TranslateFn;
  readonly overlays?: OverlayManager;
  readonly container?: HTMLElement;
  readonly doc?: Document;
  readonly onClose?: () => void;
}

function renderKeybindingGroups(groups: readonly KeybindingGroup[], t: TranslateFn): TemplateResult {
  if (groups.length === 0) {
    return html`<div class="fh-palette-kb-empty">${t('palette.kbEmpty')}</div>`;
  }
  return html`
    <div class="fh-palette-kb-groups">
      ${groups.map(
        (group) => html`
          <section class="fh-palette-kb-group" data-kb-group=${group.category}>
            <h3 class="fh-palette-kb-group-title">${group.category}</h3>
            <table class="fh-palette-kb-table">
              <thead>
                <tr>
                  <th scope="col">${t('palette.kbColCommand')}</th>
                  <th scope="col" class="fh-palette-kb-col-keys">${t('palette.kbColKeybinding')}</th>
                </tr>
              </thead>
              <tbody>
                ${group.items.map(
                  (row) => html`
                    <tr class="fh-palette-kb-row" data-kb-command=${row.command}>
                      <td class="fh-palette-kb-cmd">
                        <span class="fh-palette-kb-cmd-title">${row.title}</span>
                        <span class="fh-palette-kb-cmd-id">${row.command}</span>
                      </td>
                      <td class="fh-palette-kb-keys">
                        <span class="fh-palette-kb-chord" aria-label=${row.display}>
                          ${row.tokens.map((token) => html`<kbd class="fh-palette-kbd">${token}</kbd>`)}
                        </span>
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </section>
        `,
      )}
    </div>
  `;
}

export function openKeybindingsDialog(opts: KeybindingsDialogOptions): DialogController {
  const doc = opts.doc ?? document;
  const host = doc.createElement('div');
  host.className = 'fh-palette-kb';

  let query = '';
  let closed = false;

  const paint = (): void => {
    if (closed) return;
    const groups = collectKeybindingGroups(
      opts.listCommands(),
      opts.listExtraKeybindings ? opts.listExtraKeybindings() : [],
      query,
      opts.isMac,
    );
    const total = groups.reduce((acc, g) => acc + g.items.length, 0);

    render(
      html`
        <div class="fh-palette-kb-toolbar">
          <div class="fh-palette-kb-search">
            ${renderPaletteIcon('search', 'fh-palette-kb-search-icon')}
            <input
              type="text"
              class="fh-palette-kb-input"
              autocomplete="off"
              spellcheck="false"
              .value=${query}
              placeholder=${opts.t('palette.kbSearchPlaceholder')}
              aria-label=${opts.t('palette.kbSearchPlaceholder')}
              @input=${(ev: Event) => {
                query = (ev.currentTarget as HTMLInputElement).value;
                paint();
              }}
            />
          </div>
          <span class="fh-palette-kb-count">${opts.t('palette.kbCount', { count: total })}</span>
        </div>
        ${renderKeybindingGroups(groups, opts.t)}
      `,
      host,
    );
  };

  paint();

  const dialog = openDialog({
    title: opts.t('palette.kbTitle'),
    body: html`${host}`,
    showCancel: false,
    confirmLabel: opts.t('palette.kbClose'),
    closeIcon: renderPaletteIcon('close'),
    overlays: opts.overlays,
    container: opts.container,
    doc,
    className: 'fh-palette-kb-dialog',
    onClose: () => {
      closed = true;
      render(nothing, host);
      opts.onClose?.();
    },
  });

  focusSafely(host.querySelector<HTMLInputElement>('.fh-palette-kb-input'));
  return dialog;
}
