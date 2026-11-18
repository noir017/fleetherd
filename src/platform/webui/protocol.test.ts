import { describe, it, expect } from 'vitest';

import {
  ClickRequestSchema,
  CreateTopicRequestSchema,
  FilesCreateRequestSchema,
  FilesRemoveRequestSchema,
  FilesRenameRequestSchema,
  FilesWriteRequestSchema,
  DeleteTopicRequestSchema,
  ClearTopicsRequestSchema,
  LoginRequestSchema,
  ModelChooseRequestSchema,
  ScheduleOpRequestSchema,
  SendRequestSchema,
  StarTopicRequestSchema,
  parseBody,
} from './protocol.js';

const TOPIC = 'a1b2c3d4';

/**
 * These schemas are the shape of everything that crosses into the daemon from a browser, so
 * the assertions worth having are the rejections. `.strict()` in particular: an unknown key
 * silently surviving validation is how a field the server never declared ends up being read
 * by something downstream later.
 */
describe('webui protocol: inbound validation', () => {
  it('accepts a plain message', () => {
    expect(parseBody(SendRequestSchema, { topic: TOPIC, text: 'hi' })).toEqual({
      ok: true,
      value: { topic: TOPIC, text: 'hi' },
    });
  });

  it('accepts a message with attachments and a retry nonce', () => {
    const body = {
      topic: TOPIC,
      text: '',
      files: [{ name: 'a.txt', mime: 'text/plain', data: 'aGk=' }],
      nonce: 'abc123',
    };
    expect(parseBody(SendRequestSchema, body).ok).toBe(true);
  });

  it('accepts a quiet send, which the Settings menu uses to ask for its screen', () => {
    expect(parseBody(SendRequestSchema, { topic: TOPIC, text: '/setting', quiet: true }).ok).toBe(true);
  });

  it.each([
    ['too short', 'a1b2c3d'],
    ['too long', 'a1b2c3d4e'],
    ['not hex', 'ZZZZZZZZ'],
    ['containing the address separator', 'a1b2/c3d'],
    ['uppercase', 'A1B2C3D4'],
  ])('rejects a topic id %s', (_label, topic) => {
    // The id travels on as the lane half of `main/<id>`, which core splits on `/` and refuses
    // to see twice. Rejecting the wrong shape here keeps a malformed lane out of an address.
    expect(parseBody(SendRequestSchema, { topic, text: 'x' }).ok).toBe(false);
  });

  it.each([
    ['an unknown key', { topic: TOPIC, text: 'hi', admin: true }],
    ['a wrong type', { topic: TOPIC, text: 42 }],
    ['a missing field', {}],
    ['a non-object', 'hi'],
    ['null', null],
    ['too many files', { topic: TOPIC, text: '', files: Array.from({ length: 11 }, () => ({ name: 'a', mime: '', data: '' })) }],
    ['an unknown key inside a file', { topic: TOPIC, text: '', files: [{ name: 'a', mime: '', data: '', path: '/etc/passwd' }] }],
    ['a nameless file', { topic: TOPIC, text: '', files: [{ name: '', mime: '', data: '' }] }],
  ])('rejects %s', (_label, body) => {
    expect(parseBody(SendRequestSchema, body).ok).toBe(false);
  });

  it('names the offending path so a 400 is debuggable', () => {
    const res = parseBody(SendRequestSchema, { topic: TOPIC, text: 42 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('text');
  });

  it.each([
    ['both ids present', { topic: TOPIC, messageId: 'm1', buttonId: 'ask:r1:0' }, true],
    ['a missing button', { topic: TOPIC, messageId: 'm1' }, false],
    ['an empty id', { topic: TOPIC, messageId: '', buttonId: 'b' }, false],
    ['no topic', { messageId: 'm1', buttonId: 'b' }, false],
    ['an extra key', { topic: TOPIC, messageId: 'm1', buttonId: 'b', as: 'admin' }, false],
  ])('click with %s', (_label, body, want) => {
    expect(parseBody(ClickRequestSchema, body).ok).toBe(want);
  });

  it.each([
    ['a secret', { token: 's3cret' }, true],
    ['an empty secret', { token: '' }, false],
    ['no secret', {}, false],
    ['an extra key', { token: 's', remember: true }, false],
  ])('login with %s', (_label, body, want) => {
    expect(parseBody(LoginRequestSchema, body).ok).toBe(want);
  });

  it.each([
    ['nothing at all', {}, true],
    ['a name', { title: 'notes' }, true],
    ['an extra key', { title: 'x', pinned: true }, false],
  ])('creating a topic with %s', (_label, body, want) => {
    expect(parseBody(CreateTopicRequestSchema, body).ok).toBe(want);
  });

  it.each([
    ['a valid topic id', { topic: TOPIC }, true],
    ['a malformed topic id', { topic: 'not-hex' }, false],
    ['missing topic', {}, false],
    ['an extra key', { topic: TOPIC, force: true }, false],
  ])('deleting a topic with %s', (_label, body, want) => {
    expect(parseBody(DeleteTopicRequestSchema, body).ok).toBe(want);
  });

  it.each([
    ['nothing at all', {}, true],
    // The most destructive route here takes no fields, and `.strict()` is what makes that mean
    // it: a body carrying one is refused rather than quietly discarded.
    ['a topic it might have meant to spare', { topic: TOPIC }, false],
    ['an extra key', { confirm: true }, false],
  ])('clearing every topic with %s', (_label, body, want) => {
    expect(parseBody(ClearTopicsRequestSchema, body).ok).toBe(want);
  });

  it.each([
    ['a stated state', { topic: TOPIC, starred: true }, true],
    ['unstarring', { topic: TOPIC, starred: false }, true],
    // Stated, never toggled: the page retries a dropped request, and a retried toggle flips back.
    ['no state at all', { topic: TOPIC }, false],
    ['a state that is not a boolean', { topic: TOPIC, starred: 'yes' }, false],
    ['a malformed topic id', { topic: 'not-hex', starred: true }, false],
    ['an extra key', { topic: TOPIC, starred: true, pin: true }, false],
  ])('starring a topic with %s', (_label, body, want) => {
    expect(parseBody(StarTopicRequestSchema, body).ok).toBe(want);
  });

  it.each([
    ['pausing', { id: 'a1b2c3', action: 'pause' }, true],
    ['running one now', { id: 'a1b2c3', action: 'run' }, true],
    // The id is the daemon's own alphabet; the action is a closed set, because `run` starts an
    // unattended process and the four verbs are all the service accepts.
    ['a malformed task id', { id: 'A1B2C3', action: 'pause' }, false],
    ['an unknown action', { id: 'a1b2c3', action: 'delete' }, false],
    ['a command smuggled as an action', { id: 'a1b2c3', action: 'rm -rf /' }, false],
    ['a missing id', { action: 'pause' }, false],
    ['an extra key', { id: 'a1b2c3', action: 'pause', prompt: 'x' }, false],
  ])('acting on a scheduled task with %s', (_label, body, want) => {
    expect(parseBody(ScheduleOpRequestSchema, body).ok).toBe(want);
  });

  it.each([
    ['a model id', { topic: TOPIC, value: 'opencode/glm-5' }, true],
    // The daemon checks the value against the agent's own list; here only the envelope.
    ['an empty value', { topic: TOPIC, value: '' }, false],
    ['a value the length of a prompt', { topic: TOPIC, value: 'x'.repeat(201) }, false],
    ['a malformed topic', { topic: 'nope', value: 'opencode/glm-5' }, false],
    ['an extra key', { topic: TOPIC, value: 'opencode/glm-5', agent: 'cc' }, false],
  ])('switching a model with %s', (_label, body, want) => {
    expect(parseBody(ModelChooseRequestSchema, body).ok).toBe(want);
  });

  it.each([
    ['a typed value', { topic: TOPIC, messageId: 'm1', buttonId: 'stt:r:0', value: 'opus' }, true],
    ['an empty value', { topic: TOPIC, messageId: 'm1', buttonId: 'stt:r:0', value: '' }, false],
    ['a value too long to be one', { topic: TOPIC, messageId: 'm1', buttonId: 'stt:r:0', value: 'x'.repeat(201) }, false],
  ])('a click carrying %s', (_label, body, want) => {
    expect(parseBody(ClickRequestSchema, body).ok).toBe(want);
  });
});

describe('webui protocol: the file window', () => {
  it.each([
    ['a checked save', { topic: TOPIC, path: '/w/a.txt', text: 'x', mtimeMs: 5, size: 3 }, true],
    ['a create', { topic: TOPIC, path: '/w/a.txt', text: '', missing: true }, true],
    ['an explicit overwrite', { topic: TOPIC, path: '/w/a.txt', text: 'x', force: true }, true],
    ['a malformed topic', { topic: 'nope', path: '/w/a.txt', text: 'x' }, false],
    ['an empty path', { topic: TOPIC, path: '', text: 'x' }, false],
    ['a negative mtime', { topic: TOPIC, path: '/w/a.txt', text: 'x', mtimeMs: -1 }, false],
    // `.strict()`: the editor sends exactly this shape, and a stray key is a refused body rather
    // than a field somebody downstream later reads.
    ['an extra key', { topic: TOPIC, path: '/w/a.txt', text: 'x', mode: 0o777 }, false],
  ])('a save with %s', (_label, body, want) => {
    expect(parseBody(FilesWriteRequestSchema, body).ok).toBe(want);
  });

  it.each([
    ['a file', { topic: TOPIC, path: '/w/a.txt', dir: false }, true],
    ['a default dir', { topic: TOPIC, path: '/w/sub' }, true],
    ['no path', { topic: TOPIC, dir: true }, false],
  ])('creating %s', (_label, body, want) => {
    expect(parseBody(FilesCreateRequestSchema, body).ok).toBe(want);
  });

  it('takes only both ends of a rename, and only one path to remove', () => {
    expect(parseBody(FilesRenameRequestSchema, { topic: TOPIC, from: '/w/a', to: '/w/b' }).ok).toBe(true);
    expect(parseBody(FilesRenameRequestSchema, { topic: TOPIC, from: '/w/a' }).ok).toBe(false);
    expect(parseBody(FilesRenameRequestSchema, { topic: TOPIC, from: '/w/a', to: '/w/b', owned: '/w' }).ok).toBe(false);
    expect(parseBody(FilesRemoveRequestSchema, { topic: TOPIC, path: '/w/a' }).ok).toBe(true);
    expect(parseBody(FilesRemoveRequestSchema, { topic: TOPIC, path: '/w/a', recursive: true }).ok).toBe(false);
  });
});
