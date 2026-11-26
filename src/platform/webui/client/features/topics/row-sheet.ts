import type { Disposable } from '../../base/lifecycle.js';
import { openBottomSheet, type BottomSheetAction, type BottomSheetController, type MenuActionItem, type MenuEntry } from '../../components/index.js';
import type { OverlayManager } from '../../services/overlays.js';

export interface TopicRowSheetHeader {
  readonly title: string;
  readonly subtitle: string;
}

export interface TopicRowSheetOptions {
  readonly doc?: Document;
  readonly overlays?: OverlayManager;
  readonly container?: HTMLElement;
}

export interface TopicRowSheetController extends Disposable {
  isOpen(): boolean;
  open(header: TopicRowSheetHeader, entries: readonly MenuEntry[]): void;
  close(): void;
}

function filterSheetItems(entries: readonly MenuEntry[]): MenuActionItem[] {
  const out: MenuActionItem[] = [];
  for (const entry of entries) {
    if (entry.kind === 'separator' || entry.kind === 'header') continue;
    if (entry.id === 'topics.openInNewTab') continue;
    out.push(entry);
  }
  return out;
}

export function createTopicRowSheet(opts: TopicRowSheetOptions = {}): TopicRowSheetController {
  let active: BottomSheetController | null = null;

  const close = (): void => {
    if (!active) return;
    const cur = active;
    active = null;
    cur.close();
  };

  const open = (header: TopicRowSheetHeader, entries: readonly MenuEntry[]): void => {
    const items = filterSheetItems(entries);
    if (items.length === 0) return;
    close();
    const actions: BottomSheetAction[] = items.map((item) => ({
      id: item.id,
      label: item.label,
      icon: item.icon,
      danger: item.danger,
      disabled: item.disabled,
      onSelect: item.onSelect,
    }));
    active = openBottomSheet({
      title: header.title,
      subtitle: header.subtitle || undefined,
      actions,
      showCancel: true,
      doc: opts.doc,
      overlays: opts.overlays,
      container: opts.container,
      className: 'wb-topic-sheet-backdrop',
      onClose: () => {
        active = null;
      },
    });
  };

  return {
    isOpen: () => Boolean(active?.isOpen()),
    open,
    close,
    dispose(): void {
      close();
    },
  };
}
