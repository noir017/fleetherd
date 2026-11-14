import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readSteerOutcome, STEER_METHOD, steeringModeOf, steerParams } from './acp-steering.js';

describe('steeringModeOf', () => {
  it('prefers a second prompt where the harness queues one (claude-agent-acp advertises both)', () => {
    expect(
      steeringModeOf({
        agentCapabilities: { _meta: { claudeCode: { promptQueueing: true } } },
        _meta: { steering: { supported: true } },
      })
    ).toBe('prompt');
  });

  it('uses the steering request where that is all the harness offers (codex-acp)', () => {
    expect(steeringModeOf({ agentCapabilities: { _meta: { authStatus: {} } }, _meta: { steering: { supported: true } } })).toBe(
      'steer'
    );
  });

  it('offers nothing when neither is advertised (opencode), or when a marker is not literally true', () => {
    expect(steeringModeOf({ agentCapabilities: { loadSession: true } })).toBe('none');
    expect(steeringModeOf({ agentCapabilities: { _meta: { claudeCode: { promptQueueing: 'yes' } } } })).toBe('none');
    expect(steeringModeOf({ _meta: { steering: true } })).toBe('none');
    expect(steeringModeOf({ _meta: null, agentCapabilities: { _meta: null } })).toBe('none');
  });

  it('queues a second prompt for a harness measured to take one unadvertised (agy), unless it advertises its own', () => {
    expect(steeringModeOf({ agentCapabilities: { loadSession: true } }, true)).toBe('prompt');
    expect(steeringModeOf({ _meta: { steering: { supported: true } } }, true)).toBe('steer');
  });
});

describe('the steering request', () => {
  it('asks a harness with no running turn to hand the message back rather than start one', () => {
    expect(steerParams('s1', [{ type: 'text', text: 'hi' }])).toEqual({
      sessionId: 's1',
      prompt: [{ type: 'text', text: 'hi' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    });
  });

  it('reads injected as joined and startedNewTurn as detached', () => {
    expect(readSteerOutcome({ outcome: 'injected' })).toBe('joined');
    expect(readSteerOutcome({ outcome: 'startedNewTurn' })).toBe('detached');
  });

  it('reads everything else as refused — the gateway keeps the message', () => {
    expect(readSteerOutcome({ outcome: 'promptRequired', reason: 'noRunningTurn' })).toBe('refused');
    expect(readSteerOutcome({ outcome: 'failed' })).toBe('refused');
    expect(readSteerOutcome(undefined)).toBe('refused');
    expect(readSteerOutcome('injected')).toBe('refused');
  });
});

/**
 * ⚠️ HYRUM'S LAW contract: everything above leans on claude-agent-acp's private markers and its
 * extension method. If an upgrade renames them, these fail here rather than the feature quietly
 * degrading to "wait for the turn" in production. Read off the installed dist, the way the
 * `_claude/origin` contract test in agent-acp-pump.test.ts does.
 */
describe('claude-agent-acp contract (installed dist)', () => {
  const dist = readFileSync(
    createRequire(import.meta.url).resolve('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'),
    'utf8'
  );

  it('still advertises promptQueueing and the steering extension', () => {
    expect(dist).toMatch(/claudeCode:\s*\{\s*promptQueueing:\s*true/);
    expect(dist).toMatch(/steering:\s*\{\s*supported:\s*true/);
  });

  it('still names the extension method the runtime sends', () => {
    expect(dist).toContain(`"${STEER_METHOD}"`);
  });

  it('still accepts the promptRequired opt-out and answers with the outcomes read above', () => {
    expect(dist).toContain('"promptRequired"');
    expect(dist).toContain('outcome: "injected"');
    expect(dist).toContain('outcome: "startedNewTurn"');
  });
});
