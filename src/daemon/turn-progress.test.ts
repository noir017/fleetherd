import { describe, expect, it } from 'vitest';
import { DETAIL_CHARS, RECENT_TOOLS, TurnProgressBoard } from './turn-progress.js';

/**
 * The live half of a sub-agent's status: what its turn is running right now. The board is fed from
 * `onToolStart` and read by `tasks`/`task-status`; what it must never do is report a tool that no
 * turn is running (that is the previous turn's, and the outcome is the honest answer for it).
 */

const ID = 'web#main#c1';

function board() {
  let now = 1_000;
  const b = new TurnProgressBoard({ now: () => now });
  return { b, advance: (ms: number) => (now += ms) };
}

const tool = (name: string, detail = '', agent?: string) => ({ name, inputPreview: detail, ...(agent ? { agent } : {}) });

describe('TurnProgressBoard', () => {
  it('counts steps and keeps the newest tool calls', () => {
    const { b } = board();
    b.started(ID);
    for (let i = 0; i < RECENT_TOOLS + 2; i++) b.tool(ID, tool('Bash', `cmd ${i}`));
    const live = b.progressOf(ID)!;
    expect(live.steps).toBe(RECENT_TOOLS + 2);
    expect(live.current).toMatchObject({ tool: 'Bash', detail: `cmd ${RECENT_TOOLS + 1}` });
    expect(live.recent.map((t) => t.detail)).toEqual([`cmd 2`, `cmd 3`, `cmd 4`]);
  });

  it('flattens a multi-line preview and cuts it at DETAIL_CHARS', () => {
    const { b } = board();
    b.started(ID);
    b.tool(ID, tool('Bash', `${'a'.repeat(DETAIL_CHARS + 50)}\nsecond line`));
    const detail = b.progressOf(ID)!.current!.detail;
    expect(detail).toHaveLength(DETAIL_CHARS);
    expect(detail.endsWith('…')).toBe(true);
    expect(detail).not.toContain('\n');
  });

  it('keeps a subagent’s attribution in the tool name', () => {
    const { b } = board();
    b.started(ID);
    b.tool(ID, tool('Bash', 'ls', 'probe'));
    expect(b.progressOf(ID)!.current!.tool).toBe('probe · Bash');
  });

  it('ignores tool calls with no turn to bound them', () => {
    const { b } = board();
    b.tool(ID, tool('Bash', 'ls'));
    expect(b.progressOf(ID)).toBeUndefined();
  });

  it('starts a fresh turn on the next start, and forget drops it', () => {
    const { b } = board();
    b.started(ID);
    b.tool(ID, tool('Bash', 'ls'));
    b.started(ID);
    expect(b.progressOf(ID)).toMatchObject({ steps: 0, recent: [] });
    b.forget(ID);
    expect(b.progressOf(ID)).toBeUndefined();
  });
});
