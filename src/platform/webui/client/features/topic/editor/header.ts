import { addDisposableListener } from '../../../base/dom.js';
import { html, nothing, render } from '../../../base/html.js';
import { type Disposable, DisposableStore } from '../../../base/lifecycle.js';
import {
  createMenu,
  mountStatusDot,
  renderBadge,
  type MenuController,
  type MenuEntry,
  type StatusTone,
} from '../../../components/index.js';
import { renderIcon } from '../../../components/shared.js';
import { t as tr } from '../../../i18n/index.js';
import type { TopicInfo } from '../../../plugins/api.js';
import type { OverlayManager } from '../../../services/overlays.js';
import type {
  TopicEditorElements,
  TopicEditorMenuEntry,
  TopicEditorToolDescriptor,
  TopicStreamState,
} from './types.js';

export interface TopicHeaderDeps {
  readonly els: TopicEditorElements;
  readonly doc: Document;
  readonly win: Window;
  readonly overlays?: OverlayManager;
  readonly resolveIcon?: (name: string) => string;
  readonly getTopicTools?: (topic: TopicInfo) => readonly TopicEditorToolDescriptor[];
  readonly onToggleTopicTool?: (toolId: string, topicId: string) => void;
  readonly getTitleMenuGroups?: (topic: TopicInfo) => readonly (readonly TopicEditorMenuEntry[])[];
  readonly onBack?: () => void;
}

export interface TopicHeaderController extends Disposable {
  refresh(topic: TopicInfo | undefined, streamState: TopicStreamState): void;
  openMenu(): void;
  closeMenu(): void;
  isMenuOpen(): boolean;
}

function resolveStatusDot(topic: TopicInfo | undefined): {
  readonly status: StatusTone;
  readonly pulsing: boolean;
  readonly label: string;
} {
  if (!topic) return { status: 'idle', pulsing: false, label: '' };
  if (topic.asking) return { status: 'warn', pulsing: false, label: tr('topic.awaitingYou') };
  if (topic.running) return { status: 'ok', pulsing: true, label: tr('topic.running') };
  if (topic.live) return { status: 'ok', pulsing: false, label: '' };
  return { status: 'idle', pulsing: false, label: '' };
}

function resolveStatePill(topic: TopicInfo | undefined): { readonly text: string; readonly tone: string } | null {
  if (!topic) return null;
  if (topic.asking) return { text: tr('topic.awaitingYou'), tone: 'warn' };
  if (topic.running) return { text: tr('topic.running'), tone: 'ok' };
  return null;
}

function resolveConnectionLabel(state: TopicStreamState): string {
  if (state === 'reconnecting' || state === 'connecting') return tr('chat.reconnecting');
  if (state === 'closed') return tr('common.reachDaemonError');
  return '';
}

function buildMenuEntries(
  groups: readonly (readonly TopicEditorMenuEntry[])[],
  target: TopicInfo,
  resolveIcon?: (name: string) => string,
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (!group || group.length === 0) continue;
    if (entries.length > 0) entries.push({ kind: 'separator' });
    for (const resolved of group) {
      const iconSvg = resolved.item.icon
        ? resolveIcon
          ? resolveIcon(resolved.item.icon)
          : resolved.item.icon
        : undefined;
      entries.push({
        id: resolved.item.id,
        label: resolved.item.label,
        icon: iconSvg,
        title: resolved.disabledReason ?? resolved.item.title,
        disabled: resolved.disabled,
        danger: resolved.item.danger,
        onSelect: () => {
          void resolved.item.run(target);
        },
      });
    }
  }
  return entries;
}

export function createTopicHeaderController(deps: TopicHeaderDeps): TopicHeaderController {
  const listeners = new DisposableStore();
  const menu: MenuController = createMenu({
    doc: deps.doc,
    win: deps.win,
    overlays: deps.overlays,
    align: 'end',
    className: 'wb-topic-title-menu',
  });

  let currentTopic: TopicInfo | undefined;

  const openMenu = (): void => {
    if (!currentTopic || !deps.getTitleMenuGroups) return;
    if (menu.isOpen()) {
      menu.close(true);
      return;
    }
    const groups = deps.getTitleMenuGroups(currentTopic);
    const entries = buildMenuEntries(groups, currentTopic, deps.resolveIcon);
    if (entries.length === 0) return;
    menu.open(deps.els.moreBtn, entries);
  };

  if (deps.onBack) {
    deps.els.backBtn.hidden = false;
    listeners.add(addDisposableListener(deps.els.backBtn, 'click', () => deps.onBack?.()));
  }

  listeners.add(addDisposableListener(deps.els.moreBtn, 'click', () => openMenu()));

  const renderTools = (topic: TopicInfo | undefined): void => {
    const tools = topic && deps.getTopicTools ? deps.getTopicTools(topic) : [];
    if (!topic || tools.length === 0) {
      deps.els.toolsHost.hidden = true;
      render(nothing, deps.els.toolsHost);
      return;
    }
    deps.els.toolsHost.hidden = false;
    const topicId = topic.id;
    render(
      html`${tools.map((tool) => {
        const iconMarkup = deps.resolveIcon ? deps.resolveIcon(tool.icon) : tool.icon;
        return html`<button
          type="button"
          class=${`wb-topic-tool-btn${tool.active ? ' on is-active' : ''}`}
          data-tool-id=${tool.id}
          title=${tool.title}
          aria-pressed=${tool.active ? 'true' : 'false'}
          @click=${() => deps.onToggleTopicTool?.(tool.id, topicId)}
        >
          ${renderIcon(iconMarkup, 'wb-topic-tool-icon')}
          <span class="wb-topic-tool-label">${tool.title}</span>
          ${tool.badge != null && tool.badge !== '' ? renderBadge({ count: tool.badge }) : nothing}
        </button>`;
      })}`,
      deps.els.toolsHost,
    );
  };

  const refresh = (topic: TopicInfo | undefined, streamState: TopicStreamState): void => {
    currentTopic = topic;
    deps.els.titleEl.textContent = topic?.title || tr('common.untitled');
    deps.els.titleEl.title = topic?.title || '';

    const dot = resolveStatusDot(topic);
    mountStatusDot(deps.els.statusDotHost, {
      status: dot.status,
      pulsing: dot.pulsing,
      label: dot.label || undefined,
    });

    const pill = resolveStatePill(topic);
    if (pill) {
      deps.els.statePillEl.hidden = false;
      deps.els.statePillEl.textContent = pill.text;
      deps.els.statePillEl.dataset.tone = pill.tone;
    } else {
      deps.els.statePillEl.hidden = true;
      deps.els.statePillEl.textContent = '';
      delete deps.els.statePillEl.dataset.tone;
    }

    const connLabel = resolveConnectionLabel(streamState);
    if (connLabel) {
      deps.els.connPillEl.hidden = false;
      deps.els.connPillEl.textContent = connLabel;
      deps.els.connPillEl.dataset.streamState = streamState;
    } else {
      deps.els.connPillEl.hidden = true;
      deps.els.connPillEl.textContent = '';
      delete deps.els.connPillEl.dataset.streamState;
    }

    renderTools(topic);

    const hasMenu = Boolean(topic && deps.getTitleMenuGroups);
    deps.els.moreBtn.hidden = !hasMenu;
    deps.els.moreBtn.title = tr('topic.topicActions');
    deps.els.moreBtn.setAttribute('aria-label', tr('topic.topicActions'));
  };

  return {
    refresh,
    openMenu,
    closeMenu: () => menu.close(false),
    isMenuOpen: () => menu.isOpen(),
    dispose(): void {
      menu.dispose();
      listeners.dispose();
      render(nothing, deps.els.toolsHost);
    },
  };
}
