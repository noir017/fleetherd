import { describe, it, expect } from 'vitest';

import {
  ClickRequestSchema,
  CreateTopicRequestSchema,
  DeleteTopicRequestSchema,
  ClearTopicsRequestSchema,
  LoginRequestSchema,
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
});
