import { describe, it, expect } from 'vitest';
import { parseIpcRequest } from './protocol.js';

/**
 * parseIpcRequest is the runtime trust boundary for the reverse-command IPC: the peer is an
 * arbitrary short-lived process and its JSON is untrusted. Compile-time _AssertActionAligned only
 * guards TS/zod drift; this guards malformed/hostile input at runtime. Tested per action arm plus
 * the rejection paths.
 */
const TOKEN = 'sess_abc';

describe('parseIpcRequest — valid requests round-trip', () => {
  const valid: Record<string, unknown>[] = [
    { kind: 'send-message', text: 'hi' },
    { kind: 'send-message', text: 'hi', channelId: 'c1' },
    { kind: 'reply', messageId: 'm1', text: 'yo' },
    { kind: 'edit-message', messageId: 'm1', text: 'updated' },
    { kind: 'send-file', path: '/tmp/x' },
    { kind: 'send-file', path: '/tmp/x', name: 'x', caption: 'c', channelId: 'c1' },
    { kind: 'react', messageId: 'm1', emoji: '👍' },
    { kind: 'delete', messageId: 'm1' },
    { kind: 'fetch-messages' },
    { kind: 'fetch-messages', limit: 10, before: 'm0' },
    { kind: 'fetch-messages', fields: ['content', 'attachments'] },
    { kind: 'create-thread', messageId: 'm1', name: 'topic' },
    { kind: 'ask', prompt: 'pick', options: ['a', 'b'] },
    { kind: 'ask', prompt: 'pick', options: [], timeoutMs: 5000 },
    { kind: 'voice-log' },
    { kind: 'voice-log', limit: 5 },
    { kind: 'send-message', text: 'hi', channelId: 'web:main/t1' },
    { kind: 'list-channels' },
    { kind: 'list-channels', platform: 'tg', query: '量化', limit: 10 },
    { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'new', channelId: 'tg:586' },
    { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'daily', model: 'fast-model' },
    { kind: 'schedule-add', at: '+30m', bash: 'du -sh /', timeoutMs: 60_000, cwd: '/tmp' },
    { kind: 'schedule-edit', id: 'a1b2c3', agent: 'oc', cwd: '/srv/app', cron: '0 9 * * *' },
    { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'p', tags: ['ci', 'release'] },
    { kind: 'schedule-edit', id: 'a1b2c3', tags: [] },
    { kind: 'schedule-list' },
    { kind: 'schedule-list', id: 'a1b2c3' },
    { kind: 'schedule-op', id: 'a1b2c3', op: 'remove' },
    { kind: 'task-new', text: 'go' },
    { kind: 'task-new', agent: 'cc', text: 'go', model: 'fast-model', cwd: '/tmp', title: 'part' },
    { kind: 'task-send', topic: 'web:main/t1', text: 'go' },
    { kind: 'task-send', topic: 'web:main/t1', text: 'go', interrupt: true },
    { kind: 'task-read', topic: 'web:main/t1' },
    { kind: 'task-read', topic: 'web:main/t1', limit: 5, full: true, tail: 20 },
    { kind: 'task-read', topic: 'web:main/t1', role: 'tool', turn: 'last', grep: 'x', tail: 20 },
    { kind: 'task-read', topic: 'web:main/t1', turns: 3, since: 40 },
    { kind: 'task-read', topic: 'web:main/t1', reply: true },
    { kind: 'task-status', topic: 'web:main/t1' },
    { kind: 'task-stop', topic: 'web:main/t1' },
    { kind: 'sessions-search', query: '跨会话查询' },
    { kind: 'sessions-search', query: 'git status', agent: 'cc', days: 30, limit: 20 },
    { kind: 'sessions-search', query: 'git push', tools: true },
    { kind: 'sessions-read', session: '#12' },
    { kind: 'sessions-read', session: '12', around: 87, window: 10 },
    { kind: 'sessions-read', session: '12', role: 'tool', turn: 'last', since: 40, grep: '查询', tail: 20 },
    { kind: 'sessions-read', session: '12', turns: 3 },
    { kind: 'sessions-list' },
    { kind: 'sessions-list', days: 7, limit: 30 },
    { kind: 'skills', action: 'list' },
    { kind: 'skills', action: 'show', name: 'deploy-check', file: 'references/api.md' },
    { kind: 'skills', action: 'patch', name: 'deploy-check', version: 'abc123', content: '---\nname: deploy-check\ndescription: x\n---\n' },
  ];
  it.each(valid)('accepts %j', (action) => {
    const r = parseIpcRequest({ token: TOKEN, action });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.action.kind).toBe(action.kind);
  });
});

describe('parseIpcRequest — rejects malformed / hostile input', () => {
  const bad: [string, unknown][] = [
    ['missing token', { action: { kind: 'fetch-messages' } }],
    ['empty token', { token: '', action: { kind: 'fetch-messages' } }],
    ['non-string token', { token: 123, action: { kind: 'fetch-messages' } }],
    ['unknown discriminator', { token: TOKEN, action: { kind: 'rm-rf' } }],
    ['unknown skills action', { token: TOKEN, action: { kind: 'skills', action: 'frobnicate', name: 'x' } }],
    ['skills extra field (strict)', { token: TOKEN, action: { kind: 'skills', action: 'list', evil: 1 } }],
    ['missing required field (reply.text)', { token: TOKEN, action: { kind: 'reply', messageId: 'm1' } }],
    ['wrong field type (text number)', { token: TOKEN, action: { kind: 'send-message', text: 5 } }],
    ['empty channelId string', { token: TOKEN, action: { kind: 'fetch-messages', channelId: '' } }],
    ['extra field (strict)', { token: TOKEN, action: { kind: 'fetch-messages', evil: 1 } }],
    ['extra top-level field', { token: TOKEN, action: { kind: 'fetch-messages' }, evil: 1 }],
    ['non-object', 'just a string'],
    ['null', null],
    ['missing action', { token: TOKEN }],
    ['fetch-messages negative limit', { token: TOKEN, action: { kind: 'fetch-messages', limit: -1 } }],
    // voice-log reads the caller's own conversation only: there is no channel to point it at.
    ['voice-log with a channel', { token: TOKEN, action: { kind: 'voice-log', channelId: 'c2' } }],
    ['voice-log zero limit', { token: TOKEN, action: { kind: 'voice-log', limit: 0 } }],
    // list-channels lists places; it has no target of its own.
    ['list-channels with a channel', { token: TOKEN, action: { kind: 'list-channels', channelId: 'c2' } }],
    ['list-channels empty query', { token: TOKEN, action: { kind: 'list-channels', query: '' } }],
    ['list-channels zero limit', { token: TOKEN, action: { kind: 'list-channels', limit: 0 } }],
    // The schedule arms check shape only (buildTask owns the cross-field rules), but shape strictly.
    ['schedule-add unknown session', { token: TOKEN, action: { kind: 'schedule-add', cron: 'x', prompt: 'p', session: 'forever' } }],
    ['schedule-add extra field', { token: TOKEN, action: { kind: 'schedule-add', cron: 'x', prompt: 'p', shell: 'zsh' } }],
    ['schedule-add tags not a list', { token: TOKEN, action: { kind: 'schedule-add', cron: 'x', prompt: 'p', tags: 'ci' } }],
    ['schedule-add empty prompt', { token: TOKEN, action: { kind: 'schedule-add', cron: 'x', prompt: '' } }],
    ['schedule-op unknown op', { token: TOKEN, action: { kind: 'schedule-op', id: 'a', op: 'explode' } }],
    ['schedule-op missing id', { token: TOKEN, action: { kind: 'schedule-op', op: 'remove' } }],
    ['schedule-list with a channel', { token: TOKEN, action: { kind: 'schedule-list', channelId: 'c' } }],
    ['schedule-edit missing id', { token: TOKEN, action: { kind: 'schedule-edit', name: 'x' } }],
    ['schedule-edit with a session', { token: TOKEN, action: { kind: 'schedule-edit', id: 'a', session: 'new' } }],
    ['schedule-edit with a channel', { token: TOKEN, action: { kind: 'schedule-edit', id: 'a', channelId: 'c' } }],
    ['schedule-edit empty prompt', { token: TOKEN, action: { kind: 'schedule-edit', id: 'a', prompt: '' } }],
    // Task commands are strict too, and their bounds are real.
    ['task-new empty agent', { token: TOKEN, action: { kind: 'task-new', agent: '', text: 'x' } }],
    ['task-new empty model', { token: TOKEN, action: { kind: 'task-new', text: 'x', model: '' } }],
    ['task-read zero tail', { token: TOKEN, action: { kind: 'task-read', topic: 't', tail: 0 } }],
    ['task-read unknown field', { token: TOKEN, action: { kind: 'task-read', topic: 't', noTruncate: true } }],
    ['task-send non-boolean interrupt', { token: TOKEN, action: { kind: 'task-send', topic: 't', text: 'x', interrupt: 'yes' } }],
    ['task-status missing topic', { token: TOKEN, action: { kind: 'task-status' } }],
    // The library arms: a query is text, a session is an id, and none targets a channel.
    ['sessions-search empty query', { token: TOKEN, action: { kind: 'sessions-search', query: '' } }],
    ['sessions-search with a channel', { token: TOKEN, action: { kind: 'sessions-search', query: 'x', channelId: 'c' } }],
    ['sessions-search zero limit', { token: TOKEN, action: { kind: 'sessions-search', query: 'x', limit: 0 } }],
    ['sessions-read missing session', { token: TOKEN, action: { kind: 'sessions-read' } }],
    ['sessions-read zero window', { token: TOKEN, action: { kind: 'sessions-read', session: '1', window: -1 } }],
    ['sessions-read unknown role', { token: TOKEN, action: { kind: 'sessions-read', session: '1', role: 'robot' } }],
    ['sessions-read zero turns', { token: TOKEN, action: { kind: 'sessions-read', session: '1', turns: 0 } }],
    ['sessions-read zero tail', { token: TOKEN, action: { kind: 'sessions-read', session: '1', tail: 0 } }],
    ['sessions-list extra field', { token: TOKEN, action: { kind: 'sessions-list', query: 'x' } }],
  ];
  it.each(bad)('rejects %s', (_label, raw) => {
    const r = parseIpcRequest(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(typeof r.error).toBe('string');
  });

  it('says which range --turns accepts, not just that 0 is wrong', () => {
    const r = parseIpcRequest({ token: TOKEN, action: { kind: 'sessions-read', session: '1', turns: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/action\.turns must be at least 1/);
  });
});
