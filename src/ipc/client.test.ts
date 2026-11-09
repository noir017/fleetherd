import { describe, expect, it } from 'vitest';
import { clientTimeoutFor } from './client.js';
import { ASK_CLIENT_TIMEOUT_MARGIN_MS, DEFAULT_ASK_TIMEOUT_MS } from './protocol.js';

/**
 * The client's default wait is 10 s; some commands block longer than that on the daemon side. The
 * distinction matters because giving up early is worse than waiting: `ask` leaves a question on
 * screen nobody is listening to, and `schedule add`, `task-new` and `pod-add` go through anyway, so
 * an agent that retries leaves a duplicate behind.
 */
describe('clientTimeoutFor', () => {
  it('gives schedule add enough time to read a model list', () => {
    expect(clientTimeoutFor({ kind: 'schedule-add', cron: '0 8 * * *', prompt: 'x', model: 'fast-model' })).toBe(60_000);
  });

  it('gives task-new, reload and pod-add the same, since each can outlast 10 s on a cold host', () => {
    expect(clientTimeoutFor({ kind: 'task-new', text: 'check it', agent: 'oc@laptop', model: 'newapi/x' })).toBe(60_000);
    expect(clientTimeoutFor({ kind: 'reload-config' })).toBe(60_000);
    expect(clientTimeoutFor({ kind: 'pod-add', name: 'laptop', ssh: 'user@10.0.0.9:10022', hostKey: 'ssh-ed25519 AAAA' })).toBe(60_000);
  });

  it('keeps the ask wait tied to its own timeout plus the margin', () => {
    expect(clientTimeoutFor({ kind: 'ask', prompt: 'ok?', options: ['yes', 'no'] })).toBe(
      DEFAULT_ASK_TIMEOUT_MS + ASK_CLIENT_TIMEOUT_MARGIN_MS
    );
    expect(clientTimeoutFor({ kind: 'ask', prompt: 'ok?', options: ['yes'], timeoutMs: 5_000 })).toBe(
      5_000 + ASK_CLIENT_TIMEOUT_MARGIN_MS
    );
  });

  it('leaves every other command on the default', () => {
    expect(clientTimeoutFor({ kind: 'schedule-list' })).toBeUndefined();
    expect(clientTimeoutFor({ kind: 'send-message', text: 'hi' })).toBeUndefined();
    expect(clientTimeoutFor({ kind: 'pod-list' })).toBeUndefined();
  });
});
