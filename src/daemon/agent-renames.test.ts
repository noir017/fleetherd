import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../config/load.js';
import { ConversationStore } from './conversation-store.js';
import { ScheduleStore } from './schedule-store.js';
import { backUpForRenames, checkRenames, readAgentRenames, renameAgentsInConfig, setRenamesAside, RENAMES_FILE } from './agent-renames.js';

/**
 * Renaming agents at startup (agent-renames.json): config.yaml, every conversation's binding and
 * sessions, and the scheduled tasks move together, so a renamed agent's topics resume where they
 * were instead of falling back to the default agent with a new session.
 */

let dir: string;
const saved = process.env.TALKCODE_CONFIG_FILE;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-renames-'));
  process.env.TALKCODE_CONFIG_FILE = path.join(dir, 'config.yaml');
});
afterEach(() => {
  if (saved === undefined) delete process.env.TALKCODE_CONFIG_FILE;
  else process.env.TALKCODE_CONFIG_FILE = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

const CONFIG = `# the operator's comment
platforms:
  tg: { type: telegram, token: t }
hosts:
  box: { ssh: u@box }
agents:
  - id: cc   # main
    harness: claude
  - id: oc2
    harness: opencode
    host: box
routing:
  default: cc
  pipeline:
    - when: { command: oc2 }
      use: { agent: oc2 }
`;

describe('checkRenames', () => {
  it.each([
    [[], /expected an object/],
    [{}, /empty/],
    [{ a: '' }, /different, non-empty/],
    [{ a: 'a' }, /different, non-empty/],
    [{ a: 'x', b: 'x' }, /both become "x"/],
    [{ a: 'b', b: 'c' }, /both renamed and a new name/],
  ])('refuses %j', (raw, why) => {
    expect(checkRenames(raw)).toMatch(why);
  });

  it('accepts a plain map', () => {
    expect(checkRenames({ cc: 'cc@box', oc2: 'oc@box' })).toBeUndefined();
  });
});

describe('a rename', () => {
  it('changes config.yaml ids and routing, keeping comments, into a config that loads', () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), CONFIG);
    const map = new Map([
      ['cc', 'cc@box'],
      ['oc2', 'oc@box'],
    ]);
    expect(renameAgentsInConfig(map)).toBe(4);
    const text = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
    expect(text).toContain("# the operator's comment");
    expect(text).toMatch(/- id: cc@box +# main/);
    const { config } = readConfig();
    expect(config.agents.map((a) => a.id)).toEqual(['cc@box', 'oc@box']);
    expect(config.routing.default).toBe('cc@box');
    expect(config.routing.pipeline[0]?.use.agent).toBe('oc@box');
    expect(config.routing.pipeline[0]?.when.command).toBe('oc2');
  });

  it('moves review.agent with the reviewer, so the renamed config still loads', () => {
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `platforms:
  tg: { type: telegram, token: t }
agents:
  - id: ag
    harness: agy
routing:
  default: ag
review:
  agent: ag
  model: gemini-3.8-pro
`
    );
    // agents[].id, routing.default and review.agent — the model belongs to the review, not the id.
    expect(renameAgentsInConfig(new Map([['ag', 'ag2']]))).toBe(3);
    const { config } = readConfig();
    expect(config.agents.map((a) => a.id)).toEqual(['ag2']);
    expect(config.review?.agent).toBe('ag2');
    expect(config.review?.model).toBe('gemini-3.8-pro');
  });

  it('moves each conversation’s binding and session ids with the agent', () => {
    const file = path.join(dir, 'conversations.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        a: { agent: 'oc2', agentSessions: { oc2: 's1', cc: 's2' } },
        b: { agent: 'cx', agentSessions: { cx: 's3' } },
      })
    );
    const store = new ConversationStore(file);
    expect(store.renameAgents(new Map([['oc2', 'oc@box'], ['cc', 'cc@box']]))).toBe(1);
    const reread = new ConversationStore(file);
    expect(reread.boundAgent('a')).toBe('oc@box');
    expect(reread.agentSession('a', 'oc@box')).toBe('s1');
    expect(reread.agentSession('a', 'cc@box')).toBe('s2');
    expect(reread.agentSession('a', 'oc2')).toBeUndefined();
    expect(reread.boundAgent('b')).toBe('cx');
  });

  it('changes the agent a scheduled task runs, and leaves bash tasks alone', () => {
    const file = path.join(dir, 'schedules.json');
    const base = {
      name: 't',
      when: { cron: '0 7 * * *', tz: 'UTC' },
      target: { platform: 'tg', channel: 'c' },
      state: 'active',
      createdAt: 1,
      createdBy: { conversation: 'a', platform: 'tg' },
      runs: 0,
    };
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tasks: [
          { id: 'aaaaaa', ...base, run: { kind: 'agent', agent: 'oc2', prompt: 'p', session: 'new' } },
          { id: 'bbbbbb', ...base, run: { kind: 'bash', command: 'true', timeoutMs: 1000 } },
        ],
      })
    );
    const store = new ScheduleStore(file);
    expect(store.list()).toHaveLength(2);
    expect(store.renameAgents(new Map([['oc2', 'oc@box']]))).toBe(1);
    const run = new ScheduleStore(file).get('aaaaaa')?.run;
    expect(run).toMatchObject({ kind: 'agent', agent: 'oc@box' });
  });

  it('reads the file once: backed up, then set aside', () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), CONFIG);
    fs.writeFileSync(path.join(dir, RENAMES_FILE), JSON.stringify({ oc2: 'oc@box' }));
    expect(readAgentRenames(dir)).toEqual(new Map([['oc2', 'oc@box']]));
    backUpForRenames(dir, 'T');
    setRenamesAside(dir, 'T');
    expect(fs.existsSync(path.join(dir, 'config.yaml.bak-renames-T'))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${RENAMES_FILE}.applied-T`))).toBe(true);
    expect(readAgentRenames(dir)).toBeUndefined();
  });

  it('leaves a wrong file in place and renames nothing', () => {
    fs.writeFileSync(path.join(dir, RENAMES_FILE), JSON.stringify({ a: 'x', b: 'x' }));
    expect(readAgentRenames(dir)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, RENAMES_FILE))).toBe(true);
  });
});
