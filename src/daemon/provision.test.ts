import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config/schema.js';
import { agyPluginProvision } from './agy-plugin.js';
import { instructionsProvision } from './instructions.js';
import { managedSkillsProvision } from './managed-skills.js';
import { type AgentProvision, provisionsFor } from './provision.js';
import { bundledSkillProvision } from './skill-link.js';

const provision = (name: string, skills?: true): AgentProvision => ({
  name,
  ...(skills ? { skills } : {}),
  local: () => undefined,
  remote: () => Promise.resolve(undefined),
});

describe('provisionsFor', () => {
  const all = [provision('bundled-skill', true), provision('agy-plugin'), provision('instructions'), provision('managed-skills', true)];
  const cfg = parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude' },
      { id: 'secret', harness: 'agy', private: true, env: { HOME: '/home/u/private' } },
    ],
    routing: { default: 'cc' },
  });

  it('gives every agent everything, and a private agent nothing that carries skills', () => {
    expect(provisionsFor(cfg.agents[0]!, all).map((p) => p.name)).toEqual(['bundled-skill', 'agy-plugin', 'instructions', 'managed-skills']);
    expect(provisionsFor(cfg.agents[1]!, all).map((p) => p.name)).toEqual(['agy-plugin', 'instructions']);
  });

  it('marks the two provisions start.ts hands every agent that carry skills, and only those', () => {
    const real = [bundledSkillProvision, agyPluginProvision, instructionsProvision, managedSkillsProvision];
    expect(real.filter((p) => p.skills).map((p) => p.name)).toEqual(['bundled-skill', 'managed-skills']);
  });
});
