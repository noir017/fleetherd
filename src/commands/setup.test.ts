import { describe, expect, it } from 'vitest';
import {
  buildPlatformEntry,
  resolveExistingPlatforms,
  resolveExistingEntry,
  runSetup,
} from './setup.js';

describe('commands/setup', () => {
  it('exports runSetup as an async function', () => {
    expect(typeof runSetup).toBe('function');
  });

  it('safely resolves existing platforms', () => {
    expect(resolveExistingPlatforms(undefined)).toEqual({});
    expect(resolveExistingPlatforms({} as Record<string, unknown>)).toEqual({});
    expect(
      resolveExistingPlatforms({
        platforms: { discord: { token: 'abc' } },
      } as Record<string, unknown>)
    ).toEqual({ discord: { token: 'abc' } });
  });

  it('safely resolves existing platform entry', () => {
    const platforms = { discord: { token: 'abc' } };
    expect(resolveExistingEntry(platforms, 'discord')).toEqual({ token: 'abc' });
    expect(resolveExistingEntry(platforms, 'slack')).toEqual({});
  });

  it('builds platform entry with channels and preserves existing fields', () => {
    const entry = buildPlatformEntry(
      'discord',
      { token: 'secret' },
      ['123', '456'],
      { customField: 'preserved' }
    );
    expect(entry).toEqual({
      type: 'discord',
      customField: 'preserved',
      token: 'secret',
      chat: {
        channels: ['123', '456'],
      },
    });
  });

  it('builds platform entry with empty channels when none provided', () => {
    const entry = buildPlatformEntry(
      'telegram',
      { token: 'tg-token' },
      [],
      {}
    );
    expect(entry).toEqual({
      type: 'telegram',
      token: 'tg-token',
    });
  });
});
