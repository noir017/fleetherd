import { describe, expect, it, vi } from 'vitest';
import type { AgentStreamHandlers } from './agent.js';
import { trackVisibleOutput } from './agent-acp-translate.js';

const sink = (): AgentStreamHandlers =>
  ({ onText: () => {}, onToolStart: () => {}, onImage: () => {} }) as unknown as AgentStreamHandlers;

describe('trackVisibleOutput', () => {
  it('calls onFirst once, at the first output that counts', () => {
    const onFirst = vi.fn();
    const out = trackVisibleOutput(sink(), onFirst);
    out.handlers.onText('  \n');
    expect(onFirst).not.toHaveBeenCalled();
    expect(out.sawOutput()).toBe(false);
    out.handlers.onText('hi');
    out.handlers.onToolStart({} as Parameters<AgentStreamHandlers['onToolStart']>[0]);
    out.handlers.onText('more');
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(out.sawOutput()).toBe(true);
  });

  it('counts a tool bubble or an image as the first output too', () => {
    const tool = vi.fn();
    trackVisibleOutput(sink(), tool).handlers.onToolStart({} as Parameters<AgentStreamHandlers['onToolStart']>[0]);
    expect(tool).toHaveBeenCalledTimes(1);
    const image = vi.fn();
    trackVisibleOutput(sink(), image).handlers.onImage?.({} as Parameters<NonNullable<AgentStreamHandlers['onImage']>>[0]);
    expect(image).toHaveBeenCalledTimes(1);
  });
});
