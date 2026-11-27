import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config/schema.js';
import type { WorkbenchHost } from '../platform/workbench.js';
import { attachWorkbench, type WorkbenchWiringDeps } from './workbench-wiring.js';

function makeWorkbench() {
  const wb = {
    useWorkdirLookup: vi.fn(),
    useLivenessLookup: vi.fn(),
    useGitPanel: vi.fn(),
    useScheduleLookup: vi.fn(),
    useSchedulePanel: vi.fn(),
    useSkillsPanel: vi.fn(),
    useReviewPanel: vi.fn(),
    useHistoryPanel: vi.fn(),
    useFilesPanel: vi.fn(),
    useInstructionsPanel: vi.fn(),
    useIdleReclaim: vi.fn(),
    useTopicKill: vi.fn(),
    useAgentCatalog: vi.fn(),
    useTopicSetup: vi.fn(),
    useWorkdirBrowser: vi.fn(),
    useModelPicker: vi.fn(),
    useOptionPicker: vi.fn(),
    useTurnChanges: vi.fn(),
    useVoiceTranscriber: vi.fn(),
    attachTurnChanges: vi.fn(),
  } satisfies WorkbenchHost;
  return wb;
}

function makeDeps(instance: string, rawConfig: Record<string, unknown>): WorkbenchWiringDeps {
  const cfg = parseConfig(rawConfig);
  return {
    instance,
    config: () => cfg,
    registry: {} as WorkbenchWiringDeps['registry'],
    schedules: undefined,
    history: undefined,
    reviews: undefined,
    reviewState: undefined,
    skillsRepo: { write: vi.fn() } as unknown as WorkbenchWiringDeps['skillsRepo'],
    voice: { isConfigured: () => false, transcribeBuffer: vi.fn() } as unknown as WorkbenchWiringDeps['voice'],
    killTopicTree: vi.fn(() => []),
    notifySkillArchived: vi.fn(),
  };
}

describe('attachWorkbench — opt-in write panels (security invariants 9 & 10)', () => {
  it('does not wire files or instructions panels when disabled by default', () => {
    const wb = makeWorkbench();
    attachWorkbench(
      wb,
      makeDeps('web', {
        platforms: { web: { type: 'webui', token: 'secret-token-for-test' } },
        agents: [{ id: 'cc', harness: 'claude' }],
        routing: { default: 'cc' },
      })
    );
    expect(wb.useFilesPanel).not.toHaveBeenCalled();
    expect(wb.useInstructionsPanel).not.toHaveBeenCalled();
    expect(wb.useGitPanel).toHaveBeenCalledTimes(1);
    expect(wb.useSkillsPanel).toHaveBeenCalledTimes(1);
  });

  it('wires only files panel when files.enabled is true and instructions.enabled is false', () => {
    const wb = makeWorkbench();
    attachWorkbench(
      wb,
      makeDeps('web', {
        platforms: { web: { type: 'webui', token: 'secret-token-for-test', files: { enabled: true } } },
        agents: [{ id: 'cc', harness: 'claude' }],
        routing: { default: 'cc' },
      })
    );
    expect(wb.useFilesPanel).toHaveBeenCalledTimes(1);
    expect(wb.useInstructionsPanel).not.toHaveBeenCalled();
  });

  it('wires only instructions panel when instructions.enabled is true and files.enabled is false', () => {
    const wb = makeWorkbench();
    attachWorkbench(
      wb,
      makeDeps('web', {
        platforms: { web: { type: 'webui', token: 'secret-token-for-test', instructions: { enabled: true } } },
        agents: [{ id: 'cc', harness: 'claude' }],
        routing: { default: 'cc' },
      })
    );
    expect(wb.useFilesPanel).not.toHaveBeenCalled();
    expect(wb.useInstructionsPanel).toHaveBeenCalledTimes(1);
  });

  it('wires both write panels when files.enabled and instructions.enabled are true', () => {
    const wb = makeWorkbench();
    attachWorkbench(
      wb,
      makeDeps('web', {
        platforms: {
          web: {
            type: 'webui',
            token: 'secret-token-for-test',
            files: { enabled: true },
            instructions: { enabled: true },
          },
        },
        agents: [{ id: 'cc', harness: 'claude' }],
        routing: { default: 'cc' },
      })
    );
    expect(wb.useFilesPanel).toHaveBeenCalledTimes(1);
    expect(wb.useInstructionsPanel).toHaveBeenCalledTimes(1);
  });

  it('does not wire write panels when the platform type is not webui', () => {
    const wb = makeWorkbench();
    attachWorkbench(
      wb,
      makeDeps('discord', {
        platforms: { discord: { type: 'discord', token: 't' } },
        agents: [{ id: 'cc', harness: 'claude' }],
        routing: { default: 'cc' },
      })
    );
    expect(wb.useFilesPanel).not.toHaveBeenCalled();
    expect(wb.useInstructionsPanel).not.toHaveBeenCalled();
  });
});
