import { describe, expect, it, vi } from 'vitest';
import type { OpenEditorOptions } from '../../../plugins/api.js';
import { openTurnDiffSideBySide, type TurnDiffEditorInput } from './turn-diff.js';

describe('transcript/turn-diff', () => {
  it('opens a single-file turn change in a right-hand split diff editor', async () => {
    const fetchStatus = vi.fn(async () => ({
      ok: true,
      files: [{ path: 'src/app.ts', status: 'modified' }],
    }));
    const opened: Array<{ input: TurnDiffEditorInput; opts?: OpenEditorOptions }> = [];

    const count = await openTurnDiffSideBySide({
      topicId: 't-1',
      turn: 3,
      panelId: 'topic-panel-1',
      fetchStatus,
      openDiffEditor: (input, opts) => {
        opened.push({ input, opts });
      },
    });

    expect(count).toBe(1);
    expect(fetchStatus).toHaveBeenCalledWith('/api/turn-changes/status?t=t-1&turn=3');
    expect(opened).toEqual([
      {
        input: {
          topicId: 't-1',
          path: 'src/app.ts',
          ref: 'turn 3',
          source: {
            title: 'Turn 3 changes',
            fileUrl: '/api/turn-changes/file?t=t-1&turn=3',
          },
        },
        opts: {
          position: { referencePanel: 'topic-panel-1', direction: 'right' },
          preview: false,
        },
      },
    ]);
  });

  it('opens multi-file turn changes with first file split right and subsequent files as tabs in that group', async () => {
    const fetchStatus = vi.fn(async () => ({
      ok: true,
      files: [
        { path: 'src/a.ts' },
        { path: 'src/b.ts' },
        { path: 'src/c.ts' },
      ],
    }));
    const opened: Array<{ input: TurnDiffEditorInput; opts?: OpenEditorOptions }> = [];

    const count = await openTurnDiffSideBySide({
      topicId: 't-multi',
      turn: 2,
      fetchStatus,
      openDiffEditor: (input, opts) => {
        opened.push({ input, opts });
      },
      maxFiles: 2,
    });

    expect(count).toBe(2);
    expect(opened[0]?.input.path).toBe('src/a.ts');
    expect(opened[0]?.opts).toEqual({
      position: { group: 'main', direction: 'right' },
      preview: false,
    });
    expect(opened[1]?.input.path).toBe('src/b.ts');
    expect(opened[1]?.opts).toEqual({ preview: false });
  });

  it('falls back to fallbackCommand when openDiffEditor throws and returns 0 on empty/error status', async () => {
    const fallbackCommand = vi.fn();
    const count = await openTurnDiffSideBySide({
      topicId: 't-fb',
      turn: 1,
      fetchStatus: async () => ({ ok: true, files: [{ path: 'README.md' }] }),
      openDiffEditor: () => {
        throw new Error('diff editor not registered');
      },
      fallbackCommand,
    });
    expect(count).toBe(1);
    expect(fallbackCommand).toHaveBeenCalledTimes(1);

    const empty = await openTurnDiffSideBySide({
      topicId: 't-empty',
      turn: 1,
      fetchStatus: async () => ({ ok: false, files: [] }),
      openDiffEditor: vi.fn(),
    });
    expect(empty).toBe(0);
  });
});
