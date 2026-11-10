import { describe, expect, it } from 'vitest';
import { buildHarnessEnv } from './agent-common.js';

describe('buildHarnessEnv', () => {
  it('strips nested Claude session markers but keeps the configured CLI executable', () => {
    const previous = {
      claudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE,
      claudeCodeEntrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
      claudeCode: process.env.CLAUDECODE,
    };
    process.env.CLAUDE_CODE_EXECUTABLE = '/usr/bin/claude';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    process.env.CLAUDECODE = '1';

    try {
      const env = buildHarnessEnv({ id: 'cc', harness: 'claude', args: [], env: {}, permissions: 'auto', options: {} });

      expect(env.CLAUDE_CODE_EXECUTABLE).toBe('/usr/bin/claude');
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(env.CLAUDECODE).toBeUndefined();
    } finally {
      if (previous.claudeCodeExecutable === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE;
      else process.env.CLAUDE_CODE_EXECUTABLE = previous.claudeCodeExecutable;
      if (previous.claudeCodeEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = previous.claudeCodeEntrypoint;
      if (previous.claudeCode === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = previous.claudeCode;
    }
  });
});
