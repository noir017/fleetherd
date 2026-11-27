import { describe, expect, it } from 'vitest';
import { PERMISSION_LEVELS } from '../config/schema.js';
import type { Harness } from '../types.js';
import {
  FORBIDDEN_SELF_ANSWERING_MODES,
  FULL_ACCESS_MODES,
  HARNESS_FACTS,
  PERMISSION_LEVEL_MODES,
} from './harness-facts.js';

const ALL_HARNESSES: readonly Harness[] = ['claude', 'gemini', 'codex', 'opencode', 'dsh', 'agy', 'custom'];

describe('HARNESS_FACTS', () => {
  it('exhaustively covers every Harness with unique command names and aliases', () => {
    expect(Object.keys(HARNESS_FACTS).sort()).toEqual([...ALL_HARNESSES].sort());

    const seenSpellings = new Set<string>();
    for (const harness of ALL_HARNESSES) {
      const facts = HARNESS_FACTS[harness];
      if (facts.command) {
        for (const spelling of [facts.command.name, ...facts.command.aliases]) {
          expect(seenSpellings.has(spelling)).toBe(false);
          seenSpellings.add(spelling);
        }
      }
    }
  });

  it('gives every preset harness a displayName and command, and leaves custom dynamic', () => {
    for (const harness of ALL_HARNESSES) {
      const facts = HARNESS_FACTS[harness];
      if (harness === 'custom') {
        expect(facts.displayName).toBeNull();
        expect(facts.command).toBeNull();
        expect(facts.passthroughCommands).toBe(true);
      } else {
        expect(facts.displayName).toBeTruthy();
        expect(facts.command).not.toBeNull();
        expect(facts.passthroughCommands).toBe(false);
      }
    }
  });

  it('marks agy as ignoring session modes and carrying CLI-answered slash commands', () => {
    expect(HARNESS_FACTS.agy.ignoresSessionModes).toBe(true);
    expect(HARNESS_FACTS.agy.withoutModeKind).toBe('agy');
    expect(HARNESS_FACTS.agy.cliAnsweredCommands).toContain('usage');
    expect(HARNESS_FACTS.agy.cliAnsweredCommands).toContain('plugin');

    for (const harness of ALL_HARNESSES) {
      if (harness === 'agy') continue;
      expect(HARNESS_FACTS[harness].ignoresSessionModes).toBe(false);
      expect(HARNESS_FACTS[harness].withoutModeKind).toBe('none');
      expect(HARNESS_FACTS[harness].cliAnsweredCommands).toEqual([]);
    }
  });

  it('keeps nativeCommands and localCommands disjoint per harness', () => {
    for (const harness of ALL_HARNESSES) {
      const facts = HARNESS_FACTS[harness];
      for (const localCmd of facts.localCommands) {
        expect(Object.hasOwn(facts.nativeCommands, localCmd)).toBe(false);
      }
    }
  });
});

describe('permission mode mappings (Security invariant 1)', () => {
  it('never maps any permission level to a self-answering harness mode (claude auto, codex agent, dontAsk)', () => {
    for (const level of PERMISSION_LEVELS) {
      for (const forbidden of FORBIDDEN_SELF_ANSWERING_MODES) {
        expect(PERMISSION_LEVEL_MODES[level]).not.toContain(forbidden);
      }
    }

    for (const harness of ALL_HARNESSES) {
      const modes = Object.values(HARNESS_FACTS[harness].permissionModes);
      for (const forbidden of FORBIDDEN_SELF_ANSWERING_MODES) {
        expect(modes).not.toContain(forbidden);
      }
    }

    for (const forbidden of FORBIDDEN_SELF_ANSWERING_MODES) {
      expect(FULL_ACCESS_MODES).not.toContain(forbidden);
    }
  });

  it('keeps per-harness permissionModes consistent with PERMISSION_LEVEL_MODES', () => {
    for (const harness of ALL_HARNESSES) {
      for (const [level, mode] of Object.entries(HARNESS_FACTS[harness].permissionModes)) {
        const candidates = PERMISSION_LEVEL_MODES[level as keyof typeof PERMISSION_LEVEL_MODES];
        expect(candidates).toContain(mode);
      }
    }
  });
});
