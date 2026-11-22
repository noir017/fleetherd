import { describe, expect, it } from 'vitest';
import { externalAction, externalToolDefinition } from './external-tools.js';
import { findNativeTool, SKILLS_TOOL_ACTIONS } from './tools.js';

/**
 * The external entrance's two tools (external-tools.ts): every call becomes the action the same
 * reverse command builds, `skills` never writes, and `tasks` takes only what each action uses.
 */

describe('externalAction: skills', () => {
  it('searches and shows, as the native tool does', () => {
    expect(externalAction('skills', { action: 'search', name: 'deploy check' })).toEqual({
      kind: 'skills',
      action: { kind: 'skills', action: 'search', query: 'deploy check' },
    });
    expect(externalAction('skills', { action: 'show', name: 'grilling', file: 'references/a.md' })).toEqual({
      kind: 'skills',
      action: { kind: 'skills', action: 'show', name: 'grilling', file: 'references/a.md' },
    });
  });

  it('refuses every write, and the options the writes would need', () => {
    for (const action of ['create', 'patch', 'archive', 'revert', 'write-file', 'list']) {
      expect(() => externalAction('skills', { action, name: 'x' })).toThrow(/action must be one of search, show/);
    }
    expect(() => externalAction('skills', { action: 'show', name: 'x', content: 'evil' })).toThrow(/unknown parameter\(s\) content/);
  });
});

describe('externalAction: tasks', () => {
  it('opens a topic, with or without a title', () => {
    expect(externalAction('tasks', { action: 'open' })).toEqual({ kind: 'open' });
    expect(externalAction('tasks', { action: 'open', title: 'Trip plan' })).toEqual({ kind: 'open', title: 'Trip plan' });
  });

  it('proposes in the topic it names, through task-new\'s own build', () => {
    expect(
      externalAction('tasks', { action: 'new', topic: 'web:main/aaaaaaaa', text: 'Fix it', agent: 'cc', cwd: 'repo', model: 'opus' })
    ).toEqual({
      kind: 'task',
      in: 'web:main/aaaaaaaa',
      action: { kind: 'task-new', agent: 'cc', text: 'Fix it', cwd: 'repo', title: undefined, model: 'opus' },
    });
  });

  it('takes the agent\'s own settings as option, parsed and refused exactly as task-new --option is', () => {
    expect(
      externalAction('tasks', { action: 'new', topic: 't', text: 'Fix it', agent: 'gt', option: 'account=alice@example.com, region=eu' })
    ).toMatchObject({ kind: 'task', in: 't', action: { kind: 'task-new', options: { account: 'alice@example.com', region: 'eu' } } });
    expect(() => externalAction('tasks', { action: 'new', topic: 't', text: 'x', agent: 'gt', option: 'account' })).toThrow(/key=value pairs/);
    expect(() => externalAction('tasks', { action: 'new', topic: 't', text: 'x', agent: 'gt', option: 'model=opus' })).toThrow(/use --model/);
    expect(() => externalAction('tasks', { action: 'list', topic: 't', option: 'account=a' })).toThrow(/option does not apply to list/);
  });

  it('lists the agents, or one in full when agents names it', () => {
    expect(externalAction('tasks', { action: 'agents' })).toEqual({ kind: 'task', action: { kind: 'task-agents' } });
    expect(externalAction('tasks', { action: 'agents', agent: 'gt' })).toEqual({ kind: 'task', action: { kind: 'task-agents', agent: 'gt' } });
    expect(() => externalAction('tasks', { action: 'agents', topic: 't' })).toThrow(/topic does not apply to agents/);
  });

  it('needs the topic and the agent for new: an external topic has no agent to default to', () => {
    expect(() => externalAction('tasks', { action: 'new', text: 'x', agent: 'cc' })).toThrow(/new needs topic/);
    expect(() => externalAction('tasks', { action: 'new', topic: 't', text: 'x' })).toThrow(/new needs agent/);
    expect(() => externalAction('tasks', { action: 'new', topic: 't', agent: 'cc' })).toThrow(/text is required/);
  });

  it('lists the caller\'s topics without a topic, and a topic\'s sub-tasks with one', () => {
    expect(externalAction('tasks', { action: 'list' })).toEqual({ kind: 'topics' });
    expect(externalAction('tasks', { action: 'list', topic: 'web:main/aaaaaaaa', limit: 5 })).toEqual({
      kind: 'task',
      in: 'web:main/aaaaaaaa',
      action: { kind: 'task-list', limit: 5 },
    });
    expect(() => externalAction('tasks', { action: 'list', limit: 5 })).toThrow(/limit applies to list with a topic/);
  });

  it('reads, checks and stops a sub-task by its own topic', () => {
    expect(externalAction('tasks', { action: 'read', topic: 'web:main/c1000000', reply: true })).toEqual({
      kind: 'task',
      action: { kind: 'task-read', topic: 'web:main/c1000000', reply: true },
    });
    // A model may send a switch as a string, and a number as a number.
    expect(externalAction('tasks', { action: 'read', topic: 'c1000000', full: 'true', turn: 3, reply: false })).toMatchObject({
      action: { kind: 'task-read', topic: 'c1000000', full: true, turn: '3' },
    });
    expect(externalAction('tasks', { action: 'status', topic: 'c1000000' })).toEqual({
      kind: 'task',
      action: { kind: 'task-status', topic: 'c1000000' },
    });
    expect(externalAction('tasks', { action: 'stop', topic: 'c1000000' })).toEqual({
      kind: 'task',
      action: { kind: 'task-stop', topic: 'c1000000' },
    });
    expect(externalAction('tasks', { action: 'agents' })).toEqual({ kind: 'task', action: { kind: 'task-agents' } });
  });

  it('refuses a parameter its action does not take, and anything that is not an action', () => {
    expect(() => externalAction('tasks', { action: 'stop', topic: 't', text: 'go on' })).toThrow(/text does not apply to stop; it takes topic/);
    expect(() => externalAction('tasks', { action: 'read', topic: 't', reply: 'maybe' })).toThrow(/reply is true or false/);
    // task-send is not among the actions: a caller cannot reach a running sub-agent.
    for (const action of ['send', 'task-send', 'schedule', undefined]) {
      expect(() => externalAction('tasks', { action, topic: 't', text: 'x' })).toThrow(/action must be one of open, agents, new, list, status, read, stop/);
    }
    // Filled-in blanks are no parameter at all.
    expect(externalAction('tasks', { action: 'agents', topic: '', text: null })).toEqual({ kind: 'task', action: { kind: 'task-agents' } });
  });
});

describe('externalAction: sessions', () => {
  it('lists, searches, and reads through the sessions reverse command spec', () => {
    expect(externalAction('sessions', { action: 'list', days: 14, limit: 20, before: '#42' })).toEqual({
      kind: 'sessions',
      action: { kind: 'sessions-list', days: 14, limit: 20, before: 42 },
    });
    expect(externalAction('sessions', { action: 'search', query: 'deploy check', agent: 'cc', days: 7, limit: 5, tools: true })).toEqual({
      kind: 'sessions',
      action: { kind: 'sessions-search', query: 'deploy check', agent: 'cc', days: 7, limit: 5, tools: true },
    });
    expect(externalAction('sessions', { action: 'read', session: 'web:main/2e233c24', reply: true })).toEqual({
      kind: 'sessions',
      action: { kind: 'sessions-read', session: 'web:main/2e233c24', role: 'agent', turn: 'done' },
    });
    expect(externalAction('sessions', { action: 'read', session: '2e233c24', around: '#87', window: 5 })).toEqual({
      kind: 'sessions',
      action: {
        kind: 'sessions-read',
        session: '2e233c24',
        around: 87,
        window: 5,
        role: undefined,
        turn: undefined,
        turns: undefined,
        since: undefined,
        grep: undefined,
        tail: undefined,
      },
    });
    expect(externalAction('sessions', { action: 'read', session: '#12', role: 'user', turns: 3, grep: 'reload', full: 'true' })).toMatchObject({
      kind: 'sessions',
      action: { kind: 'sessions-read', session: '#12', role: 'user', turns: 3, grep: 'reload' },
    });
  });

  it('requires query on search and session on read, and refuses stray or conflicting parameters', () => {
    expect(() => externalAction('sessions', { action: 'search' })).toThrow(/search needs query/);
    expect(() => externalAction('sessions', { action: 'read' })).toThrow(/read needs session/);
    expect(() => externalAction('sessions', { action: 'list', query: 'x' })).toThrow(/query does not apply to list/);
    expect(() => externalAction('sessions', { action: 'search', query: 'x', session: '#1' })).toThrow(/session does not apply to search/);
    expect(() => externalAction('sessions', { action: 'read', session: '#1', reply: true, limit: 5 })).toThrow(/--reply selects one turn/);
    expect(() => externalAction('sessions', { action: 'delete', session: '#1' })).toThrow(/action must be one of list, search, read/);
    // Filled-in blanks are ignored as absent.
    expect(externalAction('sessions', { action: 'list', query: '', session: null })).toEqual({
      kind: 'sessions',
      action: { kind: 'sessions-list', days: undefined, limit: undefined },
    });
  });
});

describe('externalToolDefinition', () => {
  it('describes skills for a caller with no skill list, and leaves the native description word for word', () => {
    const def = externalToolDefinition('skills') as { description: string };
    expect(def.description).not.toMatch(/skill list/i);
    expect(def.description).toMatch(/^The skill library\. Search it when/);
    // The half both audiences share is the native tool's own text, not a second copy.
    expect(def.description.endsWith(SKILLS_TOOL_ACTIONS)).toBe(true);
    expect(findNativeTool('skills')!.description).toBe(
      'The skill library. Most skills are not in your skill list: before work your listed skills do not cover, search here. ' +
        'search: name is what you need, in a few words; up to 5 skills come back. ' +
        "show: name is a skill; its SKILL.md comes back whole with the list of its other files, which file reads one of."
    );
  });

  it('describes tasks only in terms a caller has', () => {
    const def = externalToolDefinition('tasks') as { description: string };
    expect(def.description).not.toMatch(/skill list|this conversation|your listed/i);
    expect(def.description).toMatch(/topics you opened/);
  });

  it('offers skills with the native tool\'s schema: search and show only', () => {
    const def = externalToolDefinition('skills') as { inputSchema: { properties: Record<string, { enum?: string[] }> } };
    expect(def.inputSchema.properties.action?.enum).toEqual(['search', 'show']);
    expect(Object.keys(def.inputSchema.properties).sort()).toEqual(['action', 'file', 'name']);
  });

  it('declares MCP annotations so clients treat skills as read-only and tasks as non-destructive', () => {
    expect(externalToolDefinition('skills').annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(externalToolDefinition('sessions').annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(externalToolDefinition('tasks').annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it('describes every sessions parameter, with boolean switches and role enum', () => {
    const def = externalToolDefinition('sessions') as {
      description: string;
      inputSchema: { required: string[]; properties: Record<string, { type: string; enum?: string[]; description?: string }> };
    };
    expect(def.description).toMatch(/Read-only/);
    expect(def.inputSchema.required).toEqual(['action']);
    expect(def.inputSchema.properties.action?.enum).toEqual(['list', 'search', 'read']);
    expect(def.inputSchema.properties.role?.enum).toEqual(['user', 'agent', 'tool']);
    expect(def.inputSchema.properties.tools?.type).toBe('boolean');
    expect(def.inputSchema.properties.full?.type).toBe('boolean');
    expect(def.inputSchema.properties.reply?.type).toBe('boolean');
    for (const p of Object.values(def.inputSchema.properties)) expect(p.description).toBeTruthy();
  });

  it('describes every tasks parameter, with the switches as booleans', () => {
    const def = externalToolDefinition('tasks') as {
      inputSchema: { required: string[]; properties: Record<string, { type: string; enum?: string[]; description?: string }> };
    };
    expect(def.inputSchema.required).toEqual(['action']);
    expect(def.inputSchema.properties.action?.enum).toEqual(['open', 'agents', 'new', 'list', 'status', 'read', 'stop']);
    expect(def.inputSchema.properties.reply?.type).toBe('boolean');
    expect(def.inputSchema.properties.full?.type).toBe('boolean');
    expect(def.inputSchema.properties.limit?.type).toBe('string');
    for (const p of Object.values(def.inputSchema.properties)) expect(p.description).toBeTruthy();
  });

  it('unlocks full skills, tasks, schedule, send_file, messages and gateway for trusted callers', () => {
    const trusted = { trusted: true };
    expect(externalToolDefinition('skills', trusted).annotations?.readOnlyHint).toBe(false);
    expect(
      externalAction('skills', { action: 'create', name: 'my-skill', description: 'Use when testing', body: '# Hi' }, trusted)
    ).toEqual({
      kind: 'skills',
      action: { kind: 'skills', action: 'create', name: 'my-skill', description: 'Use when testing', body: '# Hi' },
    });
    expect(
      externalAction('tasks', { action: 'send', topic: 'web:main/c1000000', text: 'Continue', interrupt: true, forward: 'web:main/c2000000' }, trusted)
    ).toEqual({
      kind: 'task',
      action: { kind: 'task-send', topic: 'web:main/c1000000', text: 'Continue', interrupt: true, forward: 'web:main/c2000000' },
    });
    expect(
      externalAction(
        'tasks',
        { action: 'new', topic: 'web:main/aaaaaaaa', text: 'Ship it', agent: 'cc', reviewBy: 'codex', review: 'Check diff', rounds: 2 },
        trusted
      )
    ).toMatchObject({
      kind: 'task',
      in: 'web:main/aaaaaaaa',
      action: { kind: 'task-new', agent: 'cc', text: 'Ship it', reviewBy: 'codex', review: 'Check diff', rounds: 2 },
    });
    expect(
      externalAction('tasks', { action: 'read', topic: 'c1000000', role: 'agent', turns: 2, grep: 'ok' }, trusted)
    ).toMatchObject({
      kind: 'task',
      action: { kind: 'task-read', topic: 'c1000000', role: 'agent', turns: 2, grep: 'ok' },
    });
    expect(externalAction('schedule', { topic: 'web:main/aaaaaaaa', action: 'list' }, trusted)).toEqual({
      kind: 'reverse',
      topic: 'web:main/aaaaaaaa',
      action: { kind: 'schedule-list', id: undefined },
    });
    expect(externalAction('send_file', { topic: 'web:main/aaaaaaaa', path: '/tmp/a.png', caption: 'hi' }, trusted)).toEqual({
      kind: 'reverse',
      topic: 'web:main/aaaaaaaa',
      action: { kind: 'send-file', path: '/tmp/a.png', name: undefined, caption: 'hi', channelId: undefined },
    });
    expect(externalAction('messages', { action: 'channels', platform: 'web', limit: 5 }, trusted)).toEqual({
      kind: 'reverse',
      action: { kind: 'list-channels', platform: 'web', query: undefined, limit: 5 },
    });
    expect(
      externalAction('messages', { action: 'ask', topic: 'web:main/aaaaaaaa', prompt: 'Pick one', options: 'A, B', timeout: 5000 }, trusted)
    ).toEqual({
      kind: 'reverse',
      topic: 'web:main/aaaaaaaa',
      action: { kind: 'ask', prompt: 'Pick one', options: ['A', 'B'], timeoutMs: 5000, channelId: undefined },
    });
    expect(externalAction('gateway', { action: 'reload' }, trusted)).toEqual({
      kind: 'reverse',
      action: { kind: 'reload-config' },
    });
    for (const tool of ['schedule', 'send_file', 'messages', 'gateway'] as const) {
      expect(() => externalAction(tool, { action: 'list' })).toThrow(/requires a trusted caller/);
    }
  });
});
