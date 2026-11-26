import { t as tr } from '../../i18n/index.js';
import { text } from '../../services/api.js';
import { ageHtml } from './age.js';
import { agentOf, agentTagHtml, rowRunning, splitTitle } from './tree.js';
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

function harnessBadgeHtml(t: Topic): string {
  const agent = agentOf(t);
  if (!agent) return '';
  const harnessCls = agent.harness ? ` h-${text(agent.harness)}` : '';
  return `<span class="topic-hc${harnessCls}" title="${text(`Agent: ${agent.id}`)}">${text(agent.label)}</span>`;
}

function wbMetaHtml(
  row: TreeRow,
  o: TreeRowOpts,
  ctx: TreeRowRenderContext,
  untitled: boolean,
): string {
  const t = row.t;
  const hc = harnessBadgeHtml(t);
  const fold = foldButtonHtml(row, ctx.icons);
  let detail = '';
  if (o.sub !== undefined) {
    detail = o.sub;
  } else if (untitled) {
    detail = `<span class="topic-dir">${text(tr('topics.chooseAgentHint'))}</span>`;
  } else if (t.line && (t.asking || t.stage === 'failed' || t.stage === 'answer')) {
    detail = `<span class="topic-dir">${text(t.line)}</span>`;
  } else {
    detail = topicDirHtml(t, ctx.offSince, ctx.offTitle, ctx.icons);
  }
  if (!hc && !fold && !detail) return '';
  const sep = hc && detail ? '<span class="topic-sep" aria-hidden="true">·</span>' : '';
  return `<span class="topic-sub">${fold}${hc}${sep}${detail}</span>`;
}

function swipeActionsHtml(t: Topic, icons: TopicIcons): string {
  const starLabel = tr(t.starred ? 'topics.swipeUnstar' : 'topics.swipeStar');
  const moreLabel = tr('topics.swipeMore');
  const delLabel = tr('topics.swipeDelete');
  const id = text(t.id);
  return (
    `<div class="wb-topic-swipe-actions" aria-hidden="true">` +
    `<button type="button" class="wb-swipe-btn wb-swipe-star" data-swipe-act="star" data-swipe-id="${id}" tabindex="-1">${icons.star}<span>${text(starLabel)}</span></button>` +
    `<button type="button" class="wb-swipe-btn wb-swipe-more" data-swipe-act="more" data-swipe-id="${id}" tabindex="-1">${icons.more}<span>${text(moreLabel)}</span></button>` +
    `<button type="button" class="wb-swipe-btn wb-swipe-del" data-swipe-act="delete" data-swipe-id="${id}" tabindex="-1">${icons.trash}<span>${text(delLabel)}</span></button>` +
    `</div>`
  );
}

function wbTopicRowClasses(
  row: TreeRow,
  o: TreeRowOpts,
  isCur: boolean,
  isRunning: boolean,
  untitled: boolean,
): string {
  const t = row.t;
  const parts = [
    isCur ? 'on' : '',
    isRunning ? 'running' : 'idle',
    t.live ? 'live' : '',
    t.starred ? 'starred' : '',
    untitled ? 'is-untitled' : '',
    o.cls ? o.cls.trim() : '',
    row.depth ? `sub d${Math.min(row.depth, 3)}` : '',
    o.tail ? o.tail.trim() : '',
  ];
  return parts.filter(Boolean).join(' ');
}

export function wbTopicRowHtml(row: TreeRow, o: TreeRowOpts, ctx: TreeRowRenderContext): string {
  const t = row.t;
  const isCur = t.id === ctx.activeTopicId;
  const isRunning = rowRunning(t, ctx.topics);
  const untitled = !t.title;
  const unread = ctx.unreadOf(t);
  const cls = wbTopicRowClasses(row, o, isCur, isRunning, untitled);
  const key = `${o.menu}:${t.id}`;
  const moreTitle = o.moreTitle || tr('topic.topicActions');
  const more =
    `<button type="button" class="btn-icon topic-more" data-rm="${text(key)}"` +
    ` aria-haspopup="menu" aria-expanded="${ctx.rowMenuKey === key ? 'true' : 'false'}"` +
    ` title="${text(moreTitle)}" aria-label="${text(moreTitle)}">${ctx.icons.more}</button>`;
  const titleText = untitled
    ? tr('topics.newPlaceholderTitle')
    : splitTitle(t.title || tr('common.untitled')).rest;
  const title = `<span class="topic-title">${forkMarkHtml(t, ctx.topicById, ctx.icons)}${text(titleText)}</span>`;
  const starMark = t.starred
    ? `<span class="topic-star-mark" title="${text(tr('topic.starredTitle'))}" aria-hidden="true">${ctx.icons.star}</span>`
    : '';
  const badge = unread > 0 ? `<span class="topic-badge">${unread > 99 ? '99+' : unread}</span>` : '';
  const term = t.term ? `<span class="topic-term" title="${text(tr('topic.termAttached'))}">&gt;_</span>` : '';
  const age = o.time !== undefined ? o.time : ageHtml(t, ctx.topics, ctx.now);
  const meta = wbMetaHtml(row, o, ctx, untitled);
  const rowMarkup =
    `<div class="topic-item wb-topic-row ${cls}" ${o.attr}="${text(t.id)}" role="button" tabindex="0"${o.attrs || ''}>` +
    `<span class="${dotClassFor(t, isRunning)}"></span>` +
    `${title}` +
    `<span class="topic-tail">${term}${badge}${starMark}${age}</span>` +
    `${meta}` +
    `<span class="topic-acts">${more}</span>` +
    `</div>`;
  return `<div class="wb-topic-swipe-wrap" data-swipe-wrap="${text(t.id)}">${swipeActionsHtml(t, ctx.icons)}${rowMarkup}</div>`;
}
