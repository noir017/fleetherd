import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConversationStore,
  migrateLegacySessions,
  parseLegacyKey,
} from './conversation-store.js';

/**
 * The persistence layer behind the project's central rule: the agent owns its context, and this
 * gateway is only a chat client in front of it. Concretely that means a user switching agents in a
 * topic and switching back must RESUME the first agent's thread, not restart their task — so the
 * store keys agent sessions by (conversation, agent) rather than holding one id per conversation.
 *
 * Real files in a temp dir: the write-through behavior and the reload path are the point, and a
 * mocked fs would test the mock.
 */

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-store-'));
  file = path.join(dir, 'conversations.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ConversationStore: agent binding', () => {
  it('records and reads back the bound agent', () => {
    const s = new ConversationStore(file);
    expect(s.boundAgent('tg#c1#')).toBeUndefined();
    s.bind('tg#c1#', 'oc');
    expect(s.boundAgent('tg#c1#')).toBe('oc');
  });

  it('survives a reload, so a restart does not silently move the conversation to routing.default', () => {
    new ConversationStore(file).bind('tg#c1#7353', 'oc');
    expect(new ConversationStore(file).boundAgent('tg#c1#7353')).toBe('oc');
  });

  it('keeps two topics of one chat independent', () => {
    const s = new ConversationStore(file);
    s.bind('tg#c1#7353', 'oc');
    s.bind('tg#c1#7364', 'cc');
    expect(s.boundAgent('tg#c1#7353')).toBe('oc');
    expect(s.boundAgent('tg#c1#7364')).toBe('cc');
  });
});

describe('ConversationStore: per-agent sessions (the agent owns its context)', () => {
  it('switching away and back resumes the first agent\'s own session', () => {
    const s = new ConversationStore(file);
    const key = 'tg#c1#7353';

    s.bind(key, 'oc');
    s.setAgentSession(key, 'oc', 'oc-sess-1'); // opencode starts a long task here

    s.bind(key, 'cc'); // user asks claude a quick question
    s.setAgentSession(key, 'cc', 'cc-sess-1');

    s.bind(key, 'oc'); // back to opencode
    // THE invariant: its original session id is still here, so the task resumes rather than
    // starting over. A single id per conversation would have been overwritten by cc.
    expect(s.agentSession(key, 'oc')).toBe('oc-sess-1');
    expect(s.agentSession(key, 'cc')).toBe('cc-sess-1');
  });

  it('never hands one agent another agent\'s session id', () => {
    const s = new ConversationStore(file);
    s.setAgentSession('tg#c1#', 'oc', 'oc-sess-1');
    // Loading opencode's ACP session into claude would either fail or resume a stranger's thread.
    expect(s.agentSession('tg#c1#', 'cc')).toBeUndefined();
  });

  it('survives a reload with every agent session intact', () => {
    const a = new ConversationStore(file);
    a.bind('tg#c1#', 'oc');
    a.setAgentSession('tg#c1#', 'oc', 'oc-1');
    a.setAgentSession('tg#c1#', 'cc', 'cc-1');

    const b = new ConversationStore(file);
    expect(b.boundAgent('tg#c1#')).toBe('oc');
    expect(b.agentSession('tg#c1#', 'oc')).toBe('oc-1');
    expect(b.agentSession('tg#c1#', 'cc')).toBe('cc-1');
  });

  it('the same conversation id in different conversations stays separate', () => {
    const s = new ConversationStore(file);
    s.setAgentSession('tg#c1#7353', 'oc', 'topic-a');
    s.setAgentSession('tg#c1#7364', 'oc', 'topic-b');
    expect(s.agentSession('tg#c1#7353', 'oc')).toBe('topic-a');
    expect(s.agentSession('tg#c1#7364', 'oc')).toBe('topic-b');
  });
});

describe('ConversationStore: clear (/new)', () => {
  it('forgets EVERY agent session for that conversation, not just the bound one', () => {
    const s = new ConversationStore(file);
    s.bind('tg#c1#', 'oc');
    s.setAgentSession('tg#c1#', 'oc', 'oc-1');
    s.setAgentSession('tg#c1#', 'cc', 'cc-1');

    s.clear('tg#c1#');

    // "Start fresh here" that let another agent's history resurface on the next /cc would be a
    // surprise, not a reset — the topic IS the conversation.
    expect(s.agentSession('tg#c1#', 'oc')).toBeUndefined();
    expect(s.agentSession('tg#c1#', 'cc')).toBeUndefined();
  });

  it('leaves other conversations untouched', () => {
    const s = new ConversationStore(file);
    s.setAgentSession('tg#c1#7353', 'oc', 'a');
    s.setAgentSession('tg#c1#7364', 'oc', 'b');
    s.clear('tg#c1#7353');
    expect(s.agentSession('tg#c1#7364', 'oc')).toBe('b');
  });
});

describe('ConversationStore: working directory (/cd)', () => {
  it('records the directory and survives a reload', () => {
    const s = new ConversationStore(file);
    expect(s.conversationCwd('tg#c1#')).toBeUndefined();
    s.setConversationCwd('tg#c1#', 'cc', '/home/u/workspace/quantlab');
    expect(new ConversationStore(file).conversationCwd('tg#c1#')).toBe('/home/u/workspace/quantlab');
  });

  it('clears the field when the choice goes back to the agent default', () => {
    const s = new ConversationStore(file);
    s.setConversationCwd('tg#c1#', 'cc', '/home/u/workspace/quantlab');
    s.setConversationCwd('tg#c1#', 'cc', undefined);
    expect(s.conversationCwd('tg#c1#')).toBeUndefined();
    // Pinned as absent, not as a literal — a later edit to agents[].cwd must still move it.
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))['tg#c1#'].cwd).toBeUndefined();
  });

  it('outlives the binding it was recorded alongside: a rebind keeps the directory', () => {
    const s = new ConversationStore(file);
    s.bind('tg#c1#', 'cc');
    s.setConversationCwd('tg#c1#', 'cc', '/home/u/workspace/quantlab');
    s.bind('tg#c1#', 'oc');
    // Asking a different agent about the same project is the point of asking it.
    expect(s.conversationCwd('tg#c1#')).toBe('/home/u/workspace/quantlab');
  });

  it('clearAgentSessions drops every session id while keeping the binding and the directory', () => {
    const s = new ConversationStore(file);
    s.bind('tg#c1#', 'cc');
    s.setAgentSession('tg#c1#', 'cc', 'cc-1');
    s.setAgentSession('tg#c1#', 'oc', 'oc-1');
    s.setConversationCwd('tg#c1#', 'cc', '/home/u/workspace/quantlab');

    s.clearAgentSessions('tg#c1#');

    // Every agent's, not just the bound one's: a session is pinned to the directory it started in,
    // so a later /oc must not resume opencode's thread from the old project.
    expect(s.agentSession('tg#c1#', 'cc')).toBeUndefined();
    expect(s.agentSession('tg#c1#', 'oc')).toBeUndefined();
    expect(s.boundAgent('tg#c1#')).toBe('cc');
    expect(s.conversationCwd('tg#c1#')).toBe('/home/u/workspace/quantlab');
  });

  it('counts the generations a conversation has discarded, and survives a reload', () => {
    const s = new ConversationStore(file);
    s.bind('tg#c1#', 'cc');
    expect(s.conversationGeneration('tg#c1#')).toBe(0);
    expect(s.bumpGeneration('tg#c1#')).toBe(1);
    expect(s.bumpGeneration('tg#c1#')).toBe(2);
    // /new clears the record first; the caller reads the old number and writes the next one back.
    s.clear('tg#c1#');
    s.bind('tg#c1#', 'cc');
    s.setGeneration('tg#c1#', 'cc', 3);

    const reloaded = new ConversationStore(file);
    expect(reloaded.conversationGeneration('tg#c1#')).toBe(3);
  });

  it('drops a malformed cwd rather than the whole record', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ 'tg#c1#': { agent: 'cc', agentSessions: { cc: 'cc-1' }, cwd: 42 } })
    );
    const s = new ConversationStore(file);
    // Losing the session id over a bad field would restart the user's task.
    expect(s.agentSession('tg#c1#', 'cc')).toBe('cc-1');
    expect(s.conversationCwd('tg#c1#')).toBeUndefined();
  });
});

describe('ConversationStore: model and effort the person chose (/model, /effort)', () => {
  it('records both for the bound agent and survives a reload, as a restart needs', () => {
    const s = new ConversationStore(file);
    s.bind('tg#c1#', 'oc');
    s.setConversationChoice('tg#c1#', 'oc', 'model', 'newapi/kimi-k3');
    s.setConversationChoice('tg#c1#', 'oc', 'effort', 'low');
    const reloaded = new ConversationStore(file);
    expect(reloaded.conversationChoice('tg#c1#', 'oc', 'model')).toBe('newapi/kimi-k3');
    expect(reloaded.conversationChoice('tg#c1#', 'oc', 'effort')).toBe('low');
  });

  it('never answers for another agent, and a rebind drops what belonged to the old one', () => {
    const s = new ConversationStore(file);
    s.bind('tg#c1#', 'oc');
    s.setConversationChoice('tg#c1#', 'oc', 'model', 'newapi/kimi-k3');
    // A value from opencode's list is not something claude could be handed.
    expect(s.conversationChoice('tg#c1#', 'cc', 'model')).toBeUndefined();
    s.bind('tg#c1#', 'cc');
    s.bind('tg#c1#', 'oc');
    expect(s.conversationChoice('tg#c1#', 'oc', 'model')).toBeUndefined();
  });

  it('writes nothing for an agent that is not the bound one', () => {
    const s = new ConversationStore(file);
    s.bind('tg#c1#', 'oc');
    s.setConversationChoice('tg#c1#', 'cc', 'model', 'opus');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))['tg#c1#'].model).toBeUndefined();
  });

  it('is kept by /cd (clearAgentSessions) and forgotten by undefined', () => {
    const s = new ConversationStore(file);
    s.bind('tg#c1#', 'oc');
    s.setAgentSession('tg#c1#', 'oc', 'oc-1');
    s.setConversationChoice('tg#c1#', 'oc', 'model', 'newapi/kimi-k3');
    s.clearAgentSessions('tg#c1#');
    expect(s.conversationChoice('tg#c1#', 'oc', 'model')).toBe('newapi/kimi-k3');
    s.setConversationChoice('tg#c1#', 'oc', 'model', undefined);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))['tg#c1#'].model).toBeUndefined();
  });

  it('drops a malformed value rather than the whole record', () => {
    fs.writeFileSync(file, JSON.stringify({ 'tg#c1#': { agent: 'oc', agentSessions: { oc: 'oc-1' }, model: 7, effort: '' } }));
    const s = new ConversationStore(file);
    expect(s.agentSession('tg#c1#', 'oc')).toBe('oc-1');
    expect(s.conversationChoice('tg#c1#', 'oc', 'model')).toBeUndefined();
    expect(s.conversationChoice('tg#c1#', 'oc', 'effort')).toBeUndefined();
  });
});

describe('ConversationStore: lane and last use (what `channels` lists)', () => {
  it('records where and when a turn ran, and survives a reload', () => {
    const s = new ConversationStore(file);
    s.recordLane('tg#586#8068', 'cc', 'tg', { channel: '586', thread: '8068' }, 1_000);
    const again = new ConversationStore(file);
    expect(again.entries()).toEqual([
      ['tg#586#8068', expect.objectContaining({ agent: 'cc', lane: { platform: 'tg', channel: '586', thread: '8068' }, lastAt: 1_000 })],
    ]);
  });

  it('keeps the binding and session ids of a record it updates', () => {
    const s = new ConversationStore(file);
    s.bind('k', 'oc');
    s.setAgentSession('k', 'oc', 'ses_1');
    s.recordLane('k', 'oc', 'web', { channel: 'main', thread: 't' }, 2);
    expect(s.boundAgent('k')).toBe('oc');
    expect(s.agentSession('k', 'oc')).toBe('ses_1');
  });

  it('drops a malformed lane on load without losing the record around it', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ k: { agent: 'cc', agentSessions: { cc: 's' }, lane: { platform: 'tg' }, lastAt: 'soon' } })
    );
    const s = new ConversationStore(file);
    expect(s.agentSession('k', 'cc')).toBe('s');
    const [, rec] = s.entries()[0]!;
    expect(rec.lane).toBeUndefined();
    expect(rec.lastAt).toBeUndefined();
  });
});

describe('ConversationStore: durability', () => {  it('a missing file starts empty rather than throwing', () => {
    expect(() => new ConversationStore(path.join(dir, 'nope', 'x.json'))).not.toThrow();
  });

  it('a corrupt file degrades to empty (bindings lost, agent histories untouched)', () => {
    fs.writeFileSync(file, '{ not json');
    const s = new ConversationStore(file);
    expect(s.boundAgent('tg#c1#')).toBeUndefined();
    // Still usable afterwards.
    s.bind('tg#c1#', 'oc');
    expect(new ConversationStore(file).boundAgent('tg#c1#')).toBe('oc');
  });

  it('drops malformed entries instead of trusting them', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        good: { agent: 'oc', agentSessions: { oc: 's1' } },
        noAgent: { agentSessions: { oc: 's2' } },
        notAnObject: 'oc',
        badSessionValue: { agent: 'cc', agentSessions: { cc: 42 } },
      })
    );
    const s = new ConversationStore(file);
    expect(s.agentSession('good', 'oc')).toBe('s1');
    expect(s.boundAgent('noAgent')).toBeUndefined();
    expect(s.boundAgent('notAnObject')).toBeUndefined();
    expect(s.boundAgent('badSessionValue')).toBe('cc'); // the record survives…
    expect(s.agentSession('badSessionValue', 'cc')).toBeUndefined(); // …minus the bad value
  });
});

describe('parseLegacyKey', () => {
  it('splits the old <agent>:<platform>:<marker>:<rest> shape', () => {
    expect(parseLegacyKey('cc:telegram:c:5865716608')).toEqual({
      agentId: 'cc',
      platform: 'telegram',
      marker: 'c',
      rest: '5865716608',
    });
  });

  it('keeps a composite Telegram tail whole (the retired <chat>:<topic> form)', () => {
    expect(parseLegacyKey('oc:telegram:c:5865716608:7353')?.rest).toBe('5865716608:7353');
  });

  it('recognizes the shared key', () => {
    expect(parseLegacyKey('cc:shared')).toMatchObject({ agentId: 'cc', marker: 'shared' });
  });

  it('returns null for anything that is not a legacy key', () => {
    expect(parseLegacyKey('tg#c1#7353')).toBeNull(); // a NEW key must never be reinterpreted
    expect(parseLegacyKey('nonsense')).toBeNull();
    expect(parseLegacyKey('cc:telegram:x:1')).toBeNull(); // unknown scope marker
  });
});

describe('migrateLegacySessions', () => {
  /** Rebuild a new-style key the way start.ts does, under per_thread scope. */
  const keyFor = ({ platform, marker, rest }: { platform: string; marker: string; rest: string }) => {
    if (marker === 'shared') return 'shared';
    if (marker === 'u') return `${platform}#u#${rest}`;
    const sep = rest.indexOf(':');
    const channel = sep < 0 ? rest : rest.slice(0, sep);
    const thread = sep < 0 ? '' : rest.slice(sep + 1);
    return `${platform}#${channel}#${thread}`;
  };

  it('carries agent bindings and sessions over, splitting a composite Telegram tail', () => {
    const legacy = path.join(dir, 'sessions.json');
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        'oc:telegram:c:5865716608:7353': 'oc-acp-1',
        'cc:discord:c:112233': 'cc-acp-1',
      })
    );
    const store = new ConversationStore(file);
    const n = migrateLegacySessions(legacy, store, keyFor);

    expect(n).toBe(2);
    // The topic became a real lane rather than part of the channel id.
    expect(store.boundAgent('telegram#5865716608#7353')).toBe('oc');
    expect(store.agentSession('telegram#5865716608#7353', 'oc')).toBe('oc-acp-1');
    expect(store.agentSession('discord#112233#', 'cc')).toBe('cc-acp-1');
  });

  it('merges two agents that answered in the same place into one conversation', () => {
    const legacy = path.join(dir, 'sessions.json');
    // The old scheme's defining artifact: one channel, two keys, two conversations.
    fs.writeFileSync(
      legacy,
      JSON.stringify({ 'oc:telegram:c:c1': 'oc-1', 'cc:telegram:c:c1': 'cc-1' })
    );
    const store = new ConversationStore(file);
    migrateLegacySessions(legacy, store, keyFor);

    // Now one conversation holding both agents' histories — neither task is lost.
    expect(store.agentSession('telegram#c1#', 'oc')).toBe('oc-1');
    expect(store.agentSession('telegram#c1#', 'cc')).toBe('cc-1');
  });

  it('is a no-op when there is no legacy file (the normal case)', () => {
    const store = new ConversationStore(file);
    expect(migrateLegacySessions(path.join(dir, 'absent.json'), store, keyFor)).toBe(0);
  });

  it('skips unparseable entries rather than aborting the whole migration', () => {
    const legacy = path.join(dir, 'sessions.json');
    fs.writeFileSync(
      legacy,
      JSON.stringify({ garbage: 'x', 'cc:discord:c:c9': 'cc-9', 'oc:discord:c:c8': 42 })
    );
    const store = new ConversationStore(file);
    expect(migrateLegacySessions(legacy, store, keyFor)).toBe(1);
    expect(store.agentSession('discord#c9#', 'cc')).toBe('cc-9');
  });
});
