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
});
