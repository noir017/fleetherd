import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '../../i18n/index.js';
import { forkFromText, forkMarkHtml, rowHtml, topicDirHtml, treeRowHtml, wbTopicRowHtml } from './row-render.js';
import type { Topic, TopicIcons } from './types.js';

const ICONS: TopicIcons = {
  more: '<svg>more</svg>',
  star: '<svg>star</svg>',
  chevronRight: '<svg>cr</svg>',
  chevronDown: '<svg>cd</svg>',
  fork: '<svg>fork</svg>',
  offline: '<svg>off</svg>',
  search: '<svg>s</svg>',
  cross: '<svg>x</svg>',
  filter: '<svg>f</svg>',
  sort: '<svg>so</svg>',
  arrowUp: '<svg>u</svg>',
  arrowDown: '<svg>d</svg>',
  copy: '<svg>c</svg>',
  power: '<svg>p</svg>',
  trash: '<svg>t</svg>',
  pause: '<svg>pa</svg>',
  play: '<svg>pl</svg>',
  clock: '<svg>cl</svg>',
  pencil: '<svg>pe</svg>',
};

function makeTopic(overrides: Partial<Topic> & { id: string }): Topic {
  return {
    title: '[cc] Build feature',
    lastAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('topics/row-render', () => {
  beforeEach(() => {
    setLocale('en');
  });

  it('renders rowHtml with aria-expanded matching open menu key', () => {
    const html = rowHtml(
      { key: 'topic:t1', attrs: ' data-topic="t1"', title: '<span>Hi</span>' },
      'topic:t1',
      ICONS,
    );
    expect(html).toContain('data-rm="topic:t1"');
    expect(html).toContain('aria-expanded="true"');
  });

  it('renders forkFromText and forkMarkHtml for forked topics', () => {
    const src = makeTopic({ id: 'src', title: 'Original' });
    const fork = makeTopic({ id: 'f1', forkOf: 'src', forkTurn: 4 });
    const byId = (id: string) => (id === 'src' ? src : null);

    expect(forkFromText(fork, byId)).toContain('Original');
    expect(forkFromText(fork, byId)).toContain('4');
    expect(forkMarkHtml(fork, byId, ICONS)).toContain('topic-fork-mark');
    expect(forkMarkHtml(src, byId, ICONS)).toBe('');
  });

  it('renders topicDirHtml with offline badge when host is unreachable', () => {
    const t = makeTopic({ id: 't1', dir: { name: 'proj', path: '/home/proj', host: 'box' } });
    const online = topicDirHtml(t, () => 0, () => '', ICONS);
    expect(online).toContain('box · ');
    expect(online).not.toContain('topic-off');

    const offline = topicDirHtml(t, () => 123, () => 'Offline since 10:00', ICONS);
    expect(offline).toContain('class="topic-off"');
    expect(offline).toContain('Offline since 10:00');
  });

  it('renders treeRowHtml with framed class, agent legend, 99+ badge, term, star, fold, and depth clamp', () => {
    const t = makeTopic({
      id: 't1',
      title: '[cc] Deep task',
      agent: { id: 'cc', harness: 'claude' },
      starred: true,
      term: true,
      asking: true,
      live: true,
      msgCount: 150,
    });
    const html = treeRowHtml(
      { t, depth: 5, kids: 2, shut: true, under: 'failed' },
      { attr: 'data-topic', menu: 'topic' },
      {
        activeTopicId: 't1',
        topics: [t],
        rowMenuKey: null,
        icons: ICONS,
        unreadOf: () => 120,
        topicById: () => t,
        offSince: () => 0,
        offTitle: () => '',
        now: 1_700_000_060_000,
      },
    );
    expect(html).toContain('on idle live starred framed sub d3');
    expect(html).toContain('topic-dot asking');
    expect(html).toContain('class="agent-tag h-claude"');
    expect(html).toContain('<span class="topic-badge">99+</span>');
    expect(html).toContain('class="topic-term"');
    expect(html).toContain('class="topic-star-mark"');
    expect(html).toContain('class="topic-fold folded failed"');
    expect(html).toContain('Deep task');
  });

  it('renders wbTopicRowHtml with quiet agent tag separated by middle dot on both normal and new-topic rows', () => {
    const named = makeTopic({
      id: 't1',
      title: 'Deploy fix',
      agent: { id: 'cc@myhost', harness: 'claude' },
      dir: { name: 'workspace', path: '/home/me/projects', host: 'myhost' },
    });
    const untitled = makeTopic({
      id: 't2',
      title: '',
      agent: { id: 'cc', harness: 'claude' },
    });
    const agentOnly = makeTopic({
      id: 't3',
      title: 'No dir',
      agent: { id: 'cc', harness: 'claude' },
    });
    const baseCtx = {
      activeTopicId: '',
      topics: [named, untitled, agentOnly],
      rowMenuKey: null,
      icons: ICONS,
      unreadOf: () => 0,
      topicById: () => null,
      offSince: () => 0,
      offTitle: () => '',
      now: 1_700_000_060_000,
    };

    const namedHtml = wbTopicRowHtml({ t: named, depth: 0, kids: 0, shut: false, under: '' }, { attr: 'data-topic', menu: 'topic' }, baseCtx);
    expect(namedHtml).toContain('<span class="topic-hc h-claude" title="Agent: cc@myhost">cc</span><span class="topic-sep" aria-hidden="true">·</span><span class="topic-dir"');

    const untitledHtml = wbTopicRowHtml({ t: untitled, depth: 0, kids: 0, shut: false, under: '' }, { attr: 'data-topic', menu: 'topic' }, baseCtx);
    expect(untitledHtml).toContain('<span class="topic-hc h-claude" title="Agent: cc">cc</span><span class="topic-sep" aria-hidden="true">·</span><span class="topic-dir">Choose an agent</span>');

    const agentOnlyHtml = wbTopicRowHtml({ t: agentOnly, depth: 0, kids: 0, shut: false, under: '' }, { attr: 'data-topic', menu: 'topic' }, baseCtx);
    expect(agentOnlyHtml).toContain('<span class="topic-hc h-claude" title="Agent: cc">cc</span>');
    expect(agentOnlyHtml).not.toContain('topic-sep');
  });
});
