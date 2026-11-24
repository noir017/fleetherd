import { t as tr } from '../../i18n/index.js';
import { text } from '../../services/api.js';
import { ageHtml } from './age.js';
import { agentTagHtml, rowRunning, splitTitle } from './tree.js';
import type { RowHtmlOpts, Topic, TopicIcons, TreeRow, TreeRowOpts } from './types.js';

export function rowHtml(o: RowHtmlOpts, rowMenuKey: string | null, icons: TopicIcons): string {
  const key = o.key || '';
  const moreTitle = o.moreTitle || tr('topic.rowActions');
  const more =
    `<button type="button" class="btn-icon topic-more" data-rm="${text(key)}"` +
    ` aria-haspopup="menu" aria-expanded="${rowMenuKey === key ? 'true' : 'false'}"` +
    ` title="${text(moreTitle)}" aria-label="${text(moreTitle)}">${icons.more}</button>`;
  const sub = o.sub || o.time ? `<span class="topic-sub">${o.sub || ''}${o.time || ''}</span>` : '';
  return (
    `<div class="topic-item${o.cls ? ` ${o.cls}` : ''}"${o.attrs}>` +
    `${o.legend || ''}` +
    `<span class="${o.dot || 'topic-dot'}"></span>` +
    `<span class="topic-main">${o.title || ''}${sub}</span>` +
    `${o.badge || ''}` +
    `<span class="topic-acts">${o.mark || ''}${more}</span>` +
    `</div>`
  );
}

export function forkFromText(t: Topic, topicById: (id: string) => Topic | null): string {
  const src = t.forkOf ? topicById(t.forkOf) : null;
  const source = src ? src.title || tr('common.untitled') : tr('topic.anotherTopic');
  return t.forkTurn
    ? tr('topic.forkedFromTurn', { source, turn: t.forkTurn })
    : tr('topic.forkedFrom', { source });
}

export function forkMarkHtml(
  t: Topic,
  topicById: (id: string) => Topic | null,
  icons: TopicIcons,
): string {
  if (!t.forkOf) return '';
  return `<span class="topic-fork-mark" title="${text(forkFromText(t, topicById))}">${icons.fork}</span>`;
}

export function topicDirHtml(
  t: Topic,
  offSince: (host: string) => number,
  offTitle: (host: string) => string,
  icons: TopicIcons,
): string {
  if (!t.dir) return '';
  const offAt = t.dir.host ? offSince(t.dir.host) : 0;
  const where = t.dir.host
    ? offAt
      ? `<span class="topic-off" title="${text(offTitle(t.dir.host))}">${icons.offline}${text(t.dir.host)}</span> · `
      : text(`${t.dir.host} · `)
    : '';
  return `<span class="topic-dir" title="${text(`${t.dir.host ? `${t.dir.host}:` : ''}${t.dir.path}`)}">${where}${text(t.dir.name)}</span>`;
}

export interface TreeRowRenderContext {
  readonly activeTopicId: string;
  readonly topics: readonly Topic[];
  readonly rowMenuKey: string | null;
  readonly icons: TopicIcons;
  readonly unreadOf: (t: Topic) => number;
  readonly topicById: (id: string) => Topic | null;
  readonly offSince: (host: string) => number;
  readonly offTitle: (host: string) => string;
  readonly now?: number;
}

function dotClassFor(t: Topic, isRunning: boolean): string {
  if (t.asking) return 'topic-dot asking';
  if (isRunning) return 'topic-dot running';
  if (t.stage === 'failed') return 'topic-dot failed';
  if (t.stage === 'review' && !t.parent) return 'topic-dot review';
  if (t.live) return 'topic-dot live';
  return 'topic-dot';
}

function foldButtonHtml(row: TreeRow, icons: TopicIcons): string {
  if (!row.kids) return '';
  const titleKey = row.shut
    ? row.kids > 1
      ? 'topic.foldShowPlural'
      : 'topic.foldShow'
    : row.kids > 1
      ? 'topic.foldHidePlural'
      : 'topic.foldHide';
  return (
    `<button type="button" class="topic-fold${row.shut ? ' folded' : ''}${row.under ? ` ${row.under}` : ''}"` +
    ` data-fold="${text(row.t.id)}" aria-expanded="${row.shut ? 'false' : 'true'}"` +
    ` title="${text(tr(titleKey, { count: row.kids }))}">` +
    `${row.shut ? icons.chevronRight : icons.chevronDown} ${row.kids}</button>`
  );
}

export function treeRowHtml(row: TreeRow, o: TreeRowOpts, ctx: TreeRowRenderContext): string {
  const t = row.t;
  const isCur = t.id === ctx.activeTopicId;
  const isRunning = rowRunning(t, ctx.topics);
  const isLive = Boolean(t.live);
  const unread = ctx.unreadOf(t);
  const cls =
    `${isCur ? 'on ' : ''}${isRunning ? 'running' : 'idle'}${isLive ? ' live' : ''}` +
    `${t.starred ? ' starred' : ''} framed${o.cls || ''}` +
    `${row.depth ? ` sub d${Math.min(row.depth, 3)}` : ''}${o.tail || ''}`;
  const badge = unread > 0 ? `<span class="topic-badge">${unread > 99 ? '99+' : unread}</span>` : '';
  const term = t.term ? `<span class="topic-term" title="${text(tr('topic.termAttached'))}">&gt;_</span>` : '';
  const line =
    o.sub !== undefined ? o.sub : topicDirHtml(t, ctx.offSince, ctx.offTitle, ctx.icons);
  const title =
    `<span class="topic-title">` +
    `${forkMarkHtml(t, ctx.topicById, ctx.icons)}` +
    `${text(splitTitle(t.title || tr('common.untitled')).rest)}</span>`;
  const starMark = t.starred
    ? `<span class="topic-star-mark" title="${text(tr('topic.starredTitle'))}" aria-hidden="true">${ctx.icons.star}</span>`
    : '';
  const fold = foldButtonHtml(row, ctx.icons);

  return rowHtml(
    {
      cls,
      attrs: ` ${o.attr}="${text(t.id)}" role="button" tabindex="0"${o.attrs || ''}`,
      key: `${o.menu}:${t.id}`,
      legend: agentTagHtml(t),
      dot: dotClassFor(t, isRunning),
      title,
      sub: fold ? `<span class="topic-line">${fold}${line}</span>` : line,
      time: o.time !== undefined ? o.time : ageHtml(t, ctx.topics, ctx.now),
      badge: term + badge,
      mark: starMark,
      moreTitle: o.moreTitle,
    },
    ctx.rowMenuKey,
    ctx.icons,
  );
}
