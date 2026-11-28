import { describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../config/schema.js';
import type { QuotaPool } from '../types.js';
import type { AgentStreamHandlers } from './agent.js';
import { AgyMeterHelper } from './agent-acp-harness.js';
import type { AcpOptionState } from './agent-acp-options.js';
import type { QuotaMeter } from './quota-meter.js';

const POOLS: QuotaPool[] = [{ id: 'gemini-5h', remaining: 0.5 }];

function rig(opts: { disposed?: () => boolean } = {}) {
  const refresh = vi.fn<QuotaMeter['refresh']>(async () => {});
  const record = vi.fn<QuotaMeter['record']>();
  const meter: QuotaMeter = { refresh, read: () => POOLS, record };
  const reported: QuotaPool[][] = [];
  const handlers = { onQuota: (q: QuotaPool[]) => reported.push(q) } as unknown as AgentStreamHandlers;
  const options = { liveConfigOptions: undefined, liveModel: undefined } as unknown as AcpOptionState;
  const def = { id: 'web', harness: 'custom', env: {} } as unknown as AgentDef;
  const helper = new AgyMeterHelper(def, 'c1', options, meter, opts.disposed ?? (() => false), () => undefined);
  return { helper, refresh, record, reported, handlers };
}

describe('AgyMeterHelper: when the quota is read', () => {
  it('shows the last reading as a turn starts without asking, and asks at the first output and after each turn', async () => {
    const { helper, refresh, reported, handlers } = rig();
    helper.quotaAtTurnStart(handlers);
    expect(refresh).not.toHaveBeenCalled();
    expect(reported).toEqual([POOLS]);

    helper.quotaOnFirstOutput(handlers, '/w');
    helper.quotaAfterTurn(handlers, '/w');
    // A later turn: its first output is not a reason to ask again — the end of the last turn was.
    helper.quotaAtTurnStart(handlers);
    helper.quotaOnFirstOutput(handlers, '/w');
    helper.quotaAfterTurn(handlers, '/w');
    expect(refresh).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(reported).toHaveLength(5));
  });

  it('asks at the first output only while the session has not asked yet', () => {
    const { helper, refresh, handlers } = rig();
    helper.quotaAfterTurn(handlers, '/w');
    helper.quotaOnFirstOutput(handlers, '/w');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('asks nothing for a session that has been let go', () => {
    const { helper, refresh, reported, handlers } = rig({ disposed: () => true });
    helper.quotaOnFirstOutput(handlers, '/w');
    helper.quotaAfterTurn(handlers, '/w');
    expect(refresh).not.toHaveBeenCalled();
    expect(reported).toEqual([]);
  });
});

describe('AgyMeterHelper: quota the harness reports by itself', () => {
  it('keeps it with the agent and shows the reading at once, without asking the meter to run anything', () => {
    const { helper, refresh, record, reported, handlers } = rig();
    const pushed: QuotaPool[] = [{ id: 'claude-5h', remaining: 0.7 }];
    helper.recordReportedQuota(pushed, handlers);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ id: 'web' }), pushed);
    expect(refresh).not.toHaveBeenCalled();
    expect(reported).toEqual([POOLS]);
  });

  it('drops it for a session that has been let go', () => {
    const { helper, record, reported, handlers } = rig({ disposed: () => true });
    helper.recordReportedQuota([{ id: 'claude-5h', remaining: 0.7 }], handlers);
    expect(record).not.toHaveBeenCalled();
    expect(reported).toEqual([]);
  });
});
