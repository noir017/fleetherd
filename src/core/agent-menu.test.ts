import { describe, expect, it } from 'vitest';
import type { AgentDef } from '../config/schema.js';
import {
  agentCatalog,
  agentGroups,
  agentKindOf,
  agentListText,
  buildAgentMenu,
  flatAgents,
  LOCAL_GROUP,
  matchAgent,
  offlinePlaces,
  parseAgentButtonId,
} from './agent-menu.js';

const agent = (id: string, extra: Partial<AgentDef> = {}): AgentDef =>
  ({ id, harness: 'claude', args: [], env: {}, permissions: 'auto', ...extra }) as AgentDef;

const agents = [
  agent('cc'),
  agent('cc-ua', { host: 'uniagent' }),
  agent('oc-ua', { host: 'uniagent', harness: 'opencode' }),
  agent('cx-box', { host: 'box', group: 'build' }),
];

describe('agentGroups', () => {
  it('groups by group, else host, else this machine, in config order', () => {
    expect(agentGroups(agents).map((g) => [g.name, g.agents.map((a) => a.id)])).toEqual([
      [LOCAL_GROUP, ['cc']],
      ['uniagent', ['cc-ua', 'oc-ua']],
      ['build', ['cx-box']],
    ]);
  });
});

describe('buildAgentMenu', () => {
  const groups = agentGroups(agents);

  it('asks for the machine first when there is more than one, marking the current one', () => {
    const view = buildAgentMenu({ reqId: 'r1', groups, current: 'oc-ua', pageSize: 6 });
    expect(view.buttons.map((b) => b.label)).toEqual([`${LOCAL_GROUP} (1)`, '● uniagent (2)', 'build (1)']);
    expect(view.buttons.map((b) => parseAgentButtonId(b.id))).toEqual([
      { kind: 'group', reqId: 'r1', group: 0 },
      { kind: 'group', reqId: 'r1', group: 1 },
      { kind: 'group', reqId: 'r1', group: 2 },
    ]);
  });

  it("lists a group's agents with indexes into the flat list, and a way back", () => {
    const view = buildAgentMenu({ reqId: 'r1', groups, current: 'oc-ua', group: 1, pageSize: 6 });
    expect(view.text).toContain('on uniagent');
    expect(view.buttons.map((b) => b.label)).toEqual(['cc-ua · claude', '● oc-ua · opencode', '‹ machines']);
    const picks = view.buttons.map((b) => parseAgentButtonId(b.id));
    expect(picks[0]).toEqual({ kind: 'pick', reqId: 'r1', index: 1 });
    expect(flatAgents(groups)[1]!.id).toBe('cc-ua');
    expect(picks[2]).toEqual({ kind: 'back', reqId: 'r1' });
  });

  it('skips the machine question when there is only one group', () => {
    const one = agentGroups([agent('a'), agent('b')]);
    const view = buildAgentMenu({ reqId: 'r', groups: one, current: undefined, pageSize: 6 });
    expect(view.buttons.map((b) => b.label)).toEqual(['a · claude', 'b · claude']);
  });

  it('pages a long group', () => {
    const many = agentGroups(Array.from({ length: 8 }, (_, i) => agent(`a${i}`)));
    const view = buildAgentMenu({ reqId: 'r', groups: many, current: undefined, page: 1, pageSize: 6 });
    expect(view.buttons.map((b) => b.label)).toEqual(['a6 · claude', 'a7 · claude', '‹', '›']);
    expect(parseAgentButtonId(view.buttons[2]!.id)).toEqual({ kind: 'page', reqId: 'r', group: 0, page: 0 });
    expect(parseAgentButtonId(view.buttons[0]!.id)).toEqual({ kind: 'pick', reqId: 'r', index: 6 });
  });
});

describe('matchAgent and agentListText', () => {
  it('matches an exact id first, then a unique substring', () => {
    expect(matchAgent(agents, 'CC')).toMatchObject({ kind: 'one', def: { id: 'cc' } });
    expect(matchAgent(agents, 'box')).toMatchObject({ kind: 'one', def: { id: 'cx-box' } });
    expect(matchAgent(agents, 'ua')).toEqual({ kind: 'many', ids: ['cc-ua', 'oc-ua'] });
    expect(matchAgent(agents, 'zz')).toEqual({ kind: 'none' });
  });

  it('lists every agent under its group', () => {
    const text = agentListText(agentGroups(agents), 'cc-ua');
    expect(text).toContain('uniagent:\n  ● cc-ua — claude\n    oc-ua — opencode');
  });
});

describe('agentCatalog (the web UI new topic lays this out)', () => {
  it('keeps the menu grouping and order, says what each agent is, and names a model as the footer does', () => {
    const catalog = agentCatalog(
      agentGroups([...agents, agent('ag-box', { host: 'box', group: 'build', harness: 'agy', model: 'google/gemini-3-pro' })]),
      'cc'
    );
    expect(catalog).toEqual({
      current: 'cc',
      groups: [
        { name: LOCAL_GROUP, agents: [{ id: 'cc', harness: 'claude', kind: 'Claude Code' }] },
        {
          name: 'uniagent',
          agents: [
            { id: 'cc-ua', harness: 'claude', kind: 'Claude Code' },
            { id: 'oc-ua', harness: 'opencode', kind: 'OpenCode' },
          ],
        },
        {
          name: 'build',
          agents: [
            { id: 'cx-box', harness: 'claude', kind: 'Claude Code' },
            { id: 'ag-box', harness: 'agy', kind: 'Antigravity', model: 'gemini-3-pro' },
          ],
        },
      ],
    });
  });

  it('names a custom harness by its command, not as "custom"', () => {
    expect(agentKindOf(agent('cb', { harness: 'custom', command: '/usr/local/bin/codebuddy' }))).toBe('codebuddy');
    expect(agentKindOf(agent('w', { harness: 'custom', command: 'C:\\tools\\agent.exe' }))).toBe('agent.exe');
    expect(agentKindOf(agent('x', { harness: 'codex' }))).toBe('Codex');
  });
});

describe('offline machines (daemon/host-availability.ts measures the hosts)', () => {
  it('lists a place only when every agent there runs on a host that is down', () => {
    const down = new Map([['uniagent', 100], ['box', 200]]);
    expect(offlinePlaces(agents, down)).toEqual([
      { name: 'uniagent', since: 100 },
      { name: 'build', since: 200 },
    ]);
    // A local agent is never offline, and names no place of its own.
    expect(offlinePlaces([agent('cc')], down)).toEqual([]);
  });

  it('keeps a group with an agent elsewhere off the list, and dates a whole one by its last host', () => {
    const split = [agent('a', { host: 'h1', group: 'lab' }), agent('b', { host: 'h2', group: 'lab' })];
    expect(offlinePlaces(split, new Map([['h1', 100]]))).toEqual([]);
    expect(offlinePlaces(split, new Map([['h1', 100], ['h2', 300]]))).toEqual([{ name: 'lab', since: 300 }]);
    const mixed = [agent('c', { group: 'lab' }), ...split];
    expect(offlinePlaces(mixed, new Map([['h1', 100], ['h2', 300]]))).toEqual([]);
  });

  it('marks the groups it is told about, and every menu built from them says so', () => {
    const groups = agentGroups(agents, new Set(['uniagent']));
    expect(groups.map((g) => [g.name, g.offline ?? false])).toEqual([
      [LOCAL_GROUP, false],
      ['uniagent', true],
      ['build', false],
    ]);

    const top = buildAgentMenu({ reqId: 'r', groups, current: 'cc', pageSize: 6 });
    expect(top.buttons.map((b) => b.label)).toEqual(['● this machine (1)', 'uniagent (2) · offline', 'build (1)']);
    // Said, not refused: its agents can still be picked.
    const inside = buildAgentMenu({ reqId: 'r', groups, current: 'cc', group: 1, pageSize: 6 });
    expect(inside.text).toContain('uniagent is offline: its agents cannot answer until it is back.');
    expect(inside.buttons.map((b) => b.label)).toContain('cc-ua · claude');

    expect(agentListText(groups, 'cc')).toContain('uniagent (offline):');
    expect(agentListText(agentGroups([agent('cc-ua', { host: 'uniagent' })], new Set(['uniagent'])), 'cc-ua')).toContain(
      '(uniagent is offline)'
    );
  });

  it('marks nothing without the set, as before', () => {
    expect(agentGroups(agents).some((g) => g.offline)).toBe(false);
    expect(buildAgentMenu({ reqId: 'r', groups: agentGroups(agents), current: 'cc', pageSize: 6 }).buttons.map((b) => b.label)).not.toContain(
      'uniagent (2) · offline'
    );
  });
});
