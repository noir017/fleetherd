import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '../../i18n/index.js';
import {
  agentOf,
  agentTagHtml,
  buildTabForest,
  buildTopicFilterGroups,
  buildTopicForest,
  buildTopicRows,
  convMatch,
  createTreeWalker,
  idleTopics,
  listRank,
  needsYou,
  rowRunning,
  runOwners,
  splitTitle,
  stateRank,
  subtreeOf,
  topicTree,
} from './tree.js';
import type { Topic } from './types.js';

function makeTopic(overrides: Partial<Topic> & { id: string }): Topic {
  return {
    title: 'Untitled',
    lastAt: 1000,
    ...overrides,
  };
}

describe('topics/tree', () => {
  beforeEach(() => {
    setLocale('en');
  });

  it('splits leading [agent] tag and resolves agentOf with @host stripping', () => {
    expect(splitTitle('[cc] Fix parser')).toEqual({ tag: 'cc', rest: 'Fix parser' });
    expect(splitTitle('Plain title')).toEqual({ tag: '', rest: 'Plain title' });

    const bound = makeTopic({
      id: 't1',
      title: '[old] Subject',
      agent: { id: 'cbc@uniagent', harness: 'claude' },
      dir: { name: 'repo', path: '/repo', host: 'uniagent' },
    });
    expect(agentOf(bound)).toEqual({ id: 'cbc@uniagent', label: 'cbc', harness: 'claude' });
    expect(agentTagHtml(bound)).toContain('class="agent-tag h-claude"');
    expect(agentTagHtml(bound)).toContain('title="Agent: cbc@uniagent"');
    expect(agentTagHtml(bound)).toContain('>cbc</span>');

    const differentHost = makeTopic({
      id: 't2',
      agent: { id: 'cbc@uniagent', harness: 'claude' },
      dir: { name: 'repo', path: '/repo', host: 'other' },
    });
    expect(agentOf(differentHost)?.label).toBe('cbc@uniagent');

    const fallback = makeTopic({ id: 't3', title: '[codex] Fallback' });
    expect(agentOf(fallback)).toEqual({ id: 'codex', label: 'codex', harness: '' });
  });

  it('identifies scheduled run owners across nested sub-agents', () => {
    const topics: Topic[] = [
      makeTopic({ id: 'run1', scheduled: true }),
      makeTopic({ id: 'sub1', parent: 'run1' }),
      makeTopic({ id: 'sub2', parent: 'sub1' }),
      makeTopic({ id: 'normal' }),
    ];
    expect(runOwners(topics)).toEqual({ run1: 'run1', sub1: 'run1', sub2: 'run1' });
  });

  it('builds topicTree with kids, forks beside source, and default folding', () => {
    const root = makeTopic({ id: 'r1', title: 'Root' });
    const child = makeTopic({ id: 'c1', title: 'Child', parent: 'r1', asking: true });
    const fork = makeTopic({ id: 'f1', title: 'Fork', forkOf: 'r1' });
    const tree = topicTree([root, child, fork]);

    expect(tree.roots.map((t) => t.id)).toEqual(['r1']);
    expect(tree.kids['r1']?.map((t) => t.id)).toEqual(['c1']);
    expect(tree.forks['r1']?.map((t) => t.id)).toEqual(['f1']);

    // Folded by default: child hidden with under='asking', fork still drawn at depth 0
    const wFolded = createTreeWalker(tree, 'other', {});
    wFolded.walk(root, 0);
    expect(wFolded.rows.map((r) => [r.t.id, r.depth, r.shut, r.under])).toEqual([
      ['r1', 0, true, 'asking'],
      ['f1', 0, false, ''],
    ]);

    // Active child forces ancestor open
    const wActive = createTreeWalker(tree, 'c1', {});
    wActive.walk(root, 0);
    expect(wActive.rows.map((r) => [r.t.id, r.depth, r.shut])).toEqual([
      ['r1', 0, false],
      ['c1', 1, false],
      ['f1', 0, false],
    ]);
  });

  it('recovers parent loops via walker.rest without dropping topics', () => {
    const a = makeTopic({ id: 'a', parent: 'b' });
    const b = makeTopic({ id: 'b', parent: 'a' });
    const tree = topicTree([a, b]);
    expect(tree.roots).toEqual([]);
    const w = createTreeWalker(tree, 'other', { a: false });
    w.rest();
    expect(w.rows.map((r) => r.t.id)).toEqual(['a', 'b']);
  });

  it('ranks needs-you, untitled, running, live, idle, and starred properly', () => {
    const tNeeds = makeTopic({ id: 'n', title: 'Needs', stage: 'answer', lastAt: 100 });
    const tUntitled = makeTopic({ id: 'u', title: '', lastAt: 200 });
    const tRun = makeTopic({ id: 'r', title: 'Run', running: true, lastAt: 300 });
    const tLive = makeTopic({ id: 'l', title: 'Live', live: true, lastAt: 400 });
    const tStar = makeTopic({ id: 's', title: 'Star', live: true, starred: true, lastAt: 350 });
    const tNone = makeTopic({ id: 'x', title: 'None', lastAt: 500 });
    const all = [tNeeds, tUntitled, tRun, tLive, tStar, tNone];

    expect(needsYou(tNeeds, 'other')).toBe(true);
    expect(needsYou(tNeeds, 'n')).toBe(false);
    expect(stateRank(tNeeds, all, 'other')).toBe(0);
    expect(listRank(tUntitled, all, 'other')).toBe(1);
    expect(listRank(tRun, all, 'other')).toBe(2);

    const forest = buildTopicForest(all, 'other');
    const painted = buildTopicRows(forest, all, 'other', {}, null);
    expect(painted.rows.map((r) => r.t.id)).toEqual(['n', 'u', 'r', 's', 'l', 'x']);
    expect(painted.dividers[1]).toBe(true);
    expect(painted.stars).toBe(1);
  });

  it('splits topics vs starred tabs and builds filter groups and matches', () => {
    const activeStar = makeTopic({ id: 'as', title: '[cc] Active Star', live: true, starred: true });
    const coldStar = makeTopic({ id: 'cs', title: '[cc] Cold Star', starred: true });
    const plain = makeTopic({ id: 'p', title: '[codex] Plain', dir: { name: 'app', path: '/app', host: 'dev' } });
    const all = [activeStar, coldStar, plain];

    const full = buildTopicForest(all, 'other');
    const topicsTab = buildTabForest(full, 'topics');
    const starredTab = buildTabForest(full, 'starred');

    // Cold starred (rank >= 3) lives only in Starred tab; active starred stays in both
    expect(topicsTab.convOrder).toEqual(['as', 'p']);
    expect(starredTab.convOrder).toEqual(['as', 'cs']);

    const fg = buildTopicFilterGroups(topicsTab, 'topics');
    expect(fg.groups.map((g) => g.id)).toEqual(['state', 'starred', 'agent', 'host']);
    expect(buildTopicFilterGroups(starredTab, 'starred').groups.map((g) => g.id)).toEqual([
      'state',
      'agent',
      'host',
    ]);

    expect(convMatch(topicsTab.convs['p']!, ['plain', 'dev'], { host: ['dev'] })).toBe(true);
    expect(convMatch(topicsTab.convs['p']!, ['plain'], { agent: ['cc'] })).toBe(false);
  });

  it('computes rowRunning, subtreeOf, and idleTopics excluding busy dispatchers', () => {
    const disp = makeTopic({ id: 'd', live: true, starred: true });
    const kid = makeTopic({ id: 'k', parent: 'd', live: true, running: true });
    const idleStar = makeTopic({ id: 'is', live: true, starred: true });
    const idlePlain = makeTopic({ id: 'ip', live: true });
    const all = [disp, kid, idlePlain, idleStar];

    expect(rowRunning(disp, all)).toBe(true);
    expect(subtreeOf('d', all).map((t) => t.id)).toEqual(['d', 'k']);
    expect(idleTopics(all).map((t) => t.id)).toEqual(['is', 'ip']);
  });
});
