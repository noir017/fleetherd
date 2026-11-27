import { describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../config/schema.js';
import {
  resolveAgent,
  resolveScope,
  routeInputFromMessage,
  type RouteInput,
} from './routing.js';
import type { InboundMessage } from '../types.js';

/** Build a minimal valid config with a customizable routing.pipeline. */
function makeConfig(pipeline: unknown[], scope = 'per_channel'): Config {
  return parseConfig({
    // Two instances: pipeline rules reference "slack" and superRefine now validates
    // when.platform against the platforms map keys.
    platforms: {
      discord: { type: 'discord', token: 't' },
      slack: { type: 'slack', appToken: 'xapp-t', botToken: 'xoxb-t' },
    },
    agents: [
      { id: 'claude', harness: 'claude' },
      { id: 'codex', harness: 'codex' },
    ],
    routing: { default: 'claude', pipeline },
    session: { scope },
  });
}

const base: RouteInput = {
  platform: 'discord',
  channel: 'c1',
  user: 'u1',
  kind: 'group',
};

describe('resolveAgent', () => {
  it('falls back to routing.default when no pipeline matches, and does not claim to be explicit', () => {
    const cfg = makeConfig([]);
    expect(resolveAgent(cfg, base)).toEqual({ agentId: 'claude', explicit: false });
  });

  it('the first fully-matching rule wins (platform + serverId)', () => {
    const cfg = makeConfig([
      { when: { platform: 'slack', serverId: 'T_BIZ' }, use: { agent: 'codex' } },
    ]);
    expect(resolveAgent(cfg, { ...base, platform: 'slack', space: 'T_BIZ' }).agentId).toBe('codex');
    // platform mismatch → no match, fall back to default
    expect(resolveAgent(cfg, { ...base, platform: 'discord', space: 'T_BIZ' }).agentId).toBe('claude');
  });

  it('a serverId condition does not match when the message has no space (no false global match)', () => {
    const cfg = makeConfig([{ when: { serverId: 'T_BIZ' }, use: { agent: 'codex' } }]);
    expect(resolveAgent(cfg, base).agentId).toBe('claude');
  });

  it('chat kind matches private/thread/group off the conversation kind', () => {
    const cfg = makeConfig([{ when: { chat: 'thread' }, use: { agent: 'codex' } }]);
    expect(resolveAgent(cfg, { ...base, kind: 'thread' }).agentId).toBe('codex');
    expect(resolveAgent(cfg, { ...base, kind: 'direct' }).agentId).toBe('claude'); // private ≠ thread
    expect(resolveAgent(cfg, base).agentId).toBe('claude'); // group ≠ thread
  });

  it('a channelId condition matches the channel and ignores the lane', () => {
    // An operator naming a channel means "this channel", which naturally includes its topics —
    // each of which is still its own conversation.
    const cfg = makeConfig([{ when: { channelId: 'c1' }, use: { agent: 'codex' } }]);
    expect(resolveAgent(cfg, { ...base, thread: '99' }).agentId).toBe('codex');
    expect(resolveAgent(cfg, { ...base, channel: 'other' }).agentId).toBe('claude');
  });

  it('an isBot condition distinguishes bots', () => {
    const cfg = makeConfig([{ when: { isBot: true }, use: { agent: 'codex' } }]);
    expect(resolveAgent(cfg, { ...base, isBot: true }).agentId).toBe('codex');
    expect(resolveAgent(cfg, base).agentId).toBe('claude');
  });
});

/**
 * `explicit` is the hinge of the sticky-binding fix.
 *
 * It must be true ONLY when the user named the agent with `/name`. A rule matching on platform or
 * channel supplies a conversation's INITIAL agent; if such a rule also counted as explicit it
 * would re-assert itself on every message, making the binding impossible to change and
 * stickiness meaningless.
 */
describe('resolveAgent: explicit vs incidental', () => {
  it('a command rule is explicit and matches the parsed /name', () => {
    const cfg = makeConfig([{ when: { command: '/review' }, use: { agent: 'codex' } }]);
    const hit = resolveAgent(cfg, { ...base, command: 'review' });
    expect(hit).toEqual({ agentId: 'codex', explicit: true }); // leading / stripped before match
  });

  it('a non-command rule chooses the agent WITHOUT being explicit', () => {
    const cfg = makeConfig([{ when: { platform: 'discord' }, use: { agent: 'codex' } }]);
    expect(resolveAgent(cfg, base)).toEqual({ agentId: 'codex', explicit: false });
  });

  it('a command that matches no rule is neither routed nor consumed', () => {
    const cfg = makeConfig([{ when: { command: '/review' }, use: { agent: 'codex' } }]);
    // `/model` must reach the agent untouched — it is the harness's own command, not ours.
    expect(resolveAgent(cfg, { ...base, command: 'model' })).toEqual({
      agentId: 'claude',
      explicit: false,
    });
  });

  it('a message with no command never resolves as explicit', () => {
    const cfg = makeConfig([{ when: { command: '/review' }, use: { agent: 'codex' } }]);
    expect(resolveAgent(cfg, base).explicit).toBe(false);
  });
});

describe('resolveScope', () => {
  it('uses the global scope when no rule matches', () => {
    expect(resolveScope(makeConfig([], 'per_user'), base)).toBe('per_user');
  });

  it('use.scope on the matching rule overrides the global scope', () => {
    const cfg = makeConfig([
      { when: { chat: 'private' }, use: { agent: 'codex', scope: 'per_user' } },
    ]);
    expect(resolveScope(cfg, { ...base, kind: 'direct' })).toBe('per_user');
    expect(resolveScope(cfg, base)).toBe('per_channel'); // rule didn't match → global
  });
});

describe('routeInputFromMessage', () => {
  it('populates RouteInput.command from plain message text (no native slash event needed)', () => {
    const msg = {
      conversation: { platform: 'lark', channel: 'c1', kind: 'group', user: 'u1' },
      messageId: 'm1',
      content: '/codex hi',
      timestamp: 0,
    } as InboundMessage;
    expect(routeInputFromMessage(msg).command).toBe('codex');
    expect(routeInputFromMessage({ ...msg, content: 'hi' }).command).toBeUndefined();
  });

  it('carries the conversation shape through to the route input', () => {
    const msg = {
      conversation: {
        platform: 'tg',
        channel: '-100123',
        thread: '99',
        space: '-100123',
        kind: 'thread',
        user: 'u1',
      },
      messageId: 'm1',
      content: 'hi',
      timestamp: 0,
    } as InboundMessage;
    expect(routeInputFromMessage(msg)).toMatchObject({
      platform: 'tg',
      channel: '-100123',
      thread: '99',
      space: '-100123',
      kind: 'thread',
      user: 'u1',
    });
  });
});
