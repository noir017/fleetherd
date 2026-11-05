import { describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../config/schema.js';
import { SessionScope } from '../config/schema.js';
import {
  buildSettingValueMenu,
  buildSettingsMenu,
  formatIdle,
  parseSettingButtonId,
  parseSettingValue,
  readSettingValue,
  resolveSettingKey,
  settingAckText,
  settingBackButtonId,
  settingDetailText,
  settingDescription,
  settingKeyOf,
  settingLocation,
  modelSource,
  settingNotice,
  settingOptions,
  settingPageButtonId,
  settingRowButtonId,
  settingTypedOnlyHint,
  settingUnknownKeyText,
  settingValueButtonId,
  settingValuePage,
  settingsListText,
  settingsMenuSurface,
  settingsRows,
  type SettingRow,
  type SettingsContext,
} from './settings.js';

/**
 * The `/setting` table: what is editable, what each field accepts, and what both surfaces say.
 *
 * Two things are worth guarding here beyond the happy paths.
 *
 * The first is the REFUSALS. `access.allowFrom`, credentials and the frozen EXPERIENCE knobs are
 * not merely missing from the table — typing them gets a named answer that points at the file. A
 * settings command whose response to a real config key is "no setting called that" teaches the user
 * that the key does not exist, which is worse than saying no.
 *
 * The second is that a value read out can be typed back in: `formatIdle` and `parseIdleValue` share
 * one vocabulary on purpose, so the number a menu shows is one the text form accepts.
 */

const cfg: Config = parseConfig({
  platforms: { tg: { type: 'telegram', token: 't' } },
  agents: [
    { id: 'cc', harness: 'claude' },
    { id: 'oc', harness: 'opencode', model: 'opencode/big-pickle' },
    { id: 'own', harness: 'custom', command: '/bin/agent' },
  ],
  routing: { default: 'cc' },
});

const MODELS = [
  { value: 'opencode/big-pickle', name: 'Big Pickle' },
  { value: 'opencode/glm-5', name: 'GLM-5' },
  { value: 'opencode/glm-5.1', name: 'GLM-5.1' },
  { value: 'newapi/claude-opus-5', name: 'Claude Opus 5' },
  { value: 'newapi/claude-sonnet-5', name: 'Claude Sonnet 5' },
  { value: 'newapi/deepseek-v4', name: 'DeepSeek V4' },
  { value: 'newapi/kimi-k3', name: 'Kimi K3' },
  { value: 'newapi/qwen-4', name: 'Qwen 4' },
  { value: 'newapi/llama-5', name: 'Llama 5' },
  { value: 'newapi/mistral-3', name: 'Mistral 3' },
  { value: 'newapi/gemma-4', name: 'Gemma 4' },
  { value: 'newapi/phi-6', name: 'Phi 6' },
  { value: 'newapi/yi-3', name: 'Yi 3' },
];

/** Context as it looks with `oc` answering and its model list reported. */
const ctx: SettingsContext = { boundAgent: 'oc', models: MODELS };
/** Context before any agent has replied: no list to offer. */
const bare: SettingsContext = { boundAgent: 'oc', models: [] };

const row = (key: string, c: SettingsContext = ctx): SettingRow => {
  const resolved = resolveSettingKey(key, cfg, c);
  if (resolved.kind !== 'row') throw new Error(`${key} did not resolve to a row: ${resolved.kind}`);
  return resolved.row;
};

describe('the settings screen', () => {
  it('lists one row per global setting plus one model row per configured agent', () => {
    const rows = settingsRows(cfg);
    expect(rows.map(settingKeyOf)).toEqual([
      'agent',
      'model.cc',
      'model.oc',
      'model.own',
      'delegation',
      'idle',
      'scope',
      'stream',
      'review.agent',
      'review.model',
    ]);
  });

  it('shows the current value of each, formatted for a reader', () => {
    const values = new Map(settingsRows(cfg).map((r) => [settingKeyOf(r), r.value]));
    // The harness, not just the id: `cc` is an operator's shorthand and says nothing to a reader.
    expect(values.get('agent')).toBe('cc · claude');
    // A custom harness has no name worth showing, so the id stands alone.
    expect(values.get('model.own')).toBe('(harness default)');
    expect(values.get('model.oc')).toBe('opencode/big-pickle');
    expect(values.get('model.cc')).toBe('(harness default)');
    expect(values.get('idle')).toBe('1h');
    expect(values.get('scope')).toBe('per_thread');
    // A boolean reads as the same word the parser takes back, so a value can be typed as shown.
    expect(values.get('stream')).toBe('off');
    // Auto review is off until a reviewer is named, and its model says whose it would follow.
    expect(values.get('review.agent')).toBe('off');
    expect(values.get('review.model')).toBe('off');
  });

  it('names the key to type next to every row, and it resolves back', () => {
    const text = settingsListText(cfg);
    for (const r of settingsRows(cfg)) {
      expect(text).toContain(`\`${settingKeyOf(r)}\``);
      expect(resolveSettingKey(settingKeyOf(r), cfg, ctx).kind).toBe('row');
    }
  });

  it('needs both button capabilities to offer a menu (a menu that cannot be edited cannot be retired)', () => {
    expect(settingsMenuSurface({ buttons: true, editButtons: true })).toBe('menu');
    expect(settingsMenuSurface({ buttons: true, editButtons: false })).toBe('text');
    expect(settingsMenuSurface({ buttons: false, editButtons: true })).toBe('text');
    expect(settingsMenuSurface({})).toBe('text'); // a capability object that omits the field
  });

  it('draws the list as grouped rows with the label and the whole value apart', () => {
    const rows = settingsRows(cfg);
    const view = buildSettingsMenu({
      reqId: 'r1',
      rows,
      extra: { id: 'sco:r1:0', label: '⏰ Scheduled tasks · 2 active' },
      screen: { cfg, options: (r) => settingOptions(r, cfg, ctx), here: 'oc' },
    });
    const screen = view.screen;
    expect(screen?.level).toBe('list');
    if (screen?.level !== 'list') throw new Error('no list screen');

    // The model rows are named by their agent under one heading, not ten rows all titled
    // "Default model"; sub-agent confirmation is not filed among them.
    expect(screen.rows.map((r) => [r.label, r.target, r.value, r.group])).toEqual([
      ['Default agent', undefined, 'cc · claude', 'Agents'],
      ['cc', 'cc', 'harness default', 'Default model'],
      ['oc', 'oc', 'opencode/big-pickle', 'Default model'],
      ['own', 'own', 'harness default', 'Default model'],
      ['Confirm sub-agent starts', undefined, 'on', 'Sub-agents'],
      ['Idle reclaim', undefined, '1h', 'Conversations'],
      ['Conversation scope', undefined, 'per_thread', 'Conversations'],
      ['Live streaming', undefined, 'off', 'Replies'],
      ['Auto review', undefined, 'off', 'Reviews'],
      ['Review model', undefined, 'off', 'Reviews'],
      ['⏰ Scheduled tasks · 2 active', undefined, undefined, 'More'],
    ]);
    expect(screen.groups.map((g) => g.name)).toEqual([
      'Agents',
      'Default model',
      'Sub-agents',
      'Conversations',
      'Replies',
      'Reviews',
      'More',
    ]);
    // "Next session" is said once, for the group, rather than on every model row.
    expect(screen.groups[1]!.note).toContain('next session');
    expect(screen.rows[1]!.effectLabel).toBeUndefined();
    expect(screen.rows[6]!.effectLabel).toBe('after restart');
    expect(screen.rows[6]!.effectDetail).toContain('daemon restarts');
    // The screen and the buttons are two views of one list: a tap must post the id the button
    // would have posted.
    expect(screen.rows.map((r) => r.buttonId)).toEqual(view.buttons.map((b) => b.id));
    // The whole value, which the chat label truncates at 40 characters.
    expect(screen.rows[2]!.value).toBe('opencode/big-pickle');
    // Unset is a placeholder, and says which agent answers here.
    expect(screen.rows[1]).toMatchObject({ unset: true, targetKind: 'Claude Code' });
    expect(screen.rows[1]!.here).toBeUndefined();
    expect(screen.rows[2]).toMatchObject({ here: true, targetKind: 'OpenCode' });
    expect(screen.rows[3]!.targetKind).toBe('agent'); // a custom harness: its command's name
  });

  it('gives every row a control, and the ids a switch or a choice posts name the value they write', () => {
    const rows = settingsRows(cfg);
    const view = buildSettingsMenu({
      reqId: 'r1',
      rows,
      extra: { id: 'sco:r1:0', label: '⏰ Scheduled tasks' },
      screen: { cfg, options: (r) => settingOptions(r, cfg, ctx) },
    });
    if (view.screen?.level !== 'list') throw new Error('no list screen');
    const byLabel = new Map(view.screen.rows.map((r) => [r.label, r]));
    const choices = view.choices ?? [];
    const writes = (id: string): { row: string; raw: string } => {
      const n = Number(id.split(':').at(-1));
      const c = choices[n]!;
      return { row: settingKeyOf(rows[c.row]!), raw: c.raw };
    };

    // On/off is a switch whose one id writes the other side.
    const delegation = byLabel.get('Confirm sub-agent starts')!.control;
    expect(delegation).toMatchObject({ kind: 'switch', on: true });
    if (delegation.kind !== 'switch') throw new Error('not a switch');
    expect(writes(delegation.set)).toEqual({ row: 'delegation', raw: 'off' });
    const stream = byLabel.get('Live streaming')!.control;
    if (stream.kind !== 'switch') throw new Error('not a switch');
    expect(stream.on).toBe(false);
    expect(writes(stream.set)).toEqual({ row: 'stream', raw: 'on' });

    // A closed list is a choice, every option writable from the row, the current one marked.
    const idle = byLabel.get('Idle reclaim')!.control;
    if (idle.kind !== 'choice') throw new Error('not a choice');
    expect(idle.options.map((o) => [o.label, o.current])).toEqual([
      ['off', false],
      ['15m', false],
      ['1h', true],
      ['4h', false],
      ['12h', false],
    ]);
    expect(idle.options.map((o) => writes(o.buttonId))).toEqual(
      ['off', '15m', '1h', '4h', '12h'].map((raw) => ({ row: 'idle', raw }))
    );
    const agent = byLabel.get('Default agent')!.control;
    if (agent.kind !== 'choice') throw new Error('not a choice');
    expect(agent.options.find((o) => o.current)?.label).toBe('cc · claude');

    // A model keeps its own screen; the scheduled tasks are a way somewhere else.
    expect(byLabel.get('oc')!.control).toEqual({ kind: 'list' });
    expect(byLabel.get('⏰ Scheduled tasks')!.control).toEqual({ kind: 'link' });
    // Every set id is distinct and resolves.
    const ids = view.screen.rows.flatMap((r) =>
      r.control.kind === 'switch' ? [r.control.set] : r.control.kind === 'choice' ? r.control.options.map((o) => o.buttonId) : []
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(parseSettingButtonId(id)).toMatchObject({ kind: 'set', reqId: 'r1' });
  });

  it('lists every row on a screen, past the chat menu’s button cap', () => {
    const many = parseConfig({
      platforms: { tg: { type: 'telegram', token: 't' } },
      agents: Array.from({ length: 24 }, (_, i) => ({ id: `a${i}`, harness: 'claude' })),
      routing: { default: 'a0' },
    });
    const view = buildSettingsMenu({
      reqId: 'r9',
      rows: settingsRows(many),
      screen: { cfg: many, options: (r) => settingOptions(r, many, bare) },
    });
    if (view.screen?.level !== 'list') throw new Error('no list screen');
    expect(view.buttons.filter((b) => b.id.startsWith('stg:'))).toHaveLength(20);
    expect(view.screen.rows).toHaveLength(settingsRows(many).length);
    expect(view.screen.rows.at(-1)?.buttonId).toBe(`stg:r9:${settingsRows(many).length - 1}`);
  });

  it('carries the outcome of the last tap as a banner with its tone', () => {
    const r = row('idle');
    const view = buildSettingsMenu({
      reqId: 'r1',
      rows: settingsRows(cfg),
      screen: {
        cfg,
        options: (x) => settingOptions(x, cfg, ctx),
        notice: settingNotice({ kind: 'saved', row: r, display: '4h' }),
      },
    });
    if (view.screen?.level !== 'list') throw new Error('no list screen');
    expect(view.screen.notice).toEqual({ tone: 'ok', text: expect.stringContaining('Idle reclaim → 4h') });
    expect(settingNotice({ kind: 'unchanged', row: r }).tone).toBe('info');
    expect(settingNotice({ kind: 'invalid', row: r, reason: 'no' }).tone).toBe('error');
    expect(settingNotice({ kind: 'failed', row: r, reason: 'disk' })).toEqual({
      tone: 'error',
      text: 'Could not save Idle reclaim: disk',
    });
  });

  it('builds no screen unless the platform asks for one', () => {
    // The whole point of the capability: a chat app's view is unchanged, down to the object it gets.
    expect(buildSettingsMenu({ reqId: 'r1', rows: settingsRows(cfg) }).screen).toBeUndefined();
    expect(
      buildSettingValueMenu({ reqId: 'r2', row: row('idle'), options: settingOptions(row('idle'), cfg, ctx), page: 0 })
        .screen
    ).toBeUndefined();
  });

  it('marks the current value and keeps the value ids absolute across pages', () => {
    const r = row('idle');
    const view = buildSettingValueMenu({
      reqId: 'r2',
      row: r,
      options: settingOptions(r, cfg, ctx),
      page: 1,
      pageSize: 2,
      screen: { cfg },
    });
    const screen = view.screen;
    expect(screen?.level).toBe('values');
    if (screen?.level !== 'values') throw new Error('no value screen');

    expect(screen.options).toEqual([
      { buttonId: 'stv:r2:2', label: '1h', current: true },
      { buttonId: 'stv:r2:3', label: '4h', current: false },
    ]);
    expect(screen.nav).toEqual({
      page: 2,
      pageCount: 3,
      prev: 'stp:r2:0',
      next: 'stp:r2:2',
      back: 'stb:r2:0',
    });
    // The head says which setting this is and what it holds, so the screen need not parse the text.
    expect(screen.head).toMatchObject({ label: 'Idle reclaim', value: '1h', effect: 'Takes effect at once.' });
    expect(screen.head?.description).toContain('quiet');
    // The screen's nav row carries the page number; the text would otherwise say it twice.
    expect(view.text).not.toContain('page 2/3');
    expect(
      buildSettingValueMenu({
        reqId: 'r2',
        row: r,
        options: settingOptions(r, cfg, ctx),
        page: 1,
        pageSize: 2,
      }).text
    ).toContain('page 2/3');
  });

  it('splits a value from the clause that explains it, leaving the chat label whole', () => {
    const r = row('scope');
    const options = settingOptions(r, cfg, ctx);
    expect(options[0]!.label).toBe('per_thread — a topic / thread is its own conversation');
    const view = buildSettingValueMenu({ reqId: 'r3', row: r, options, page: 0, screen: { cfg } });
    const screen = view.screen;
    if (screen?.level !== 'values') throw new Error('no value screen');
    expect(screen.options[0]).toEqual({
      buttonId: 'stv:r3:0',
      label: 'per_thread',
      detail: 'a topic / thread is its own conversation',
      current: true,
    });
  });
});

describe("a pod agent's model row", () => {
  const podCfg: Config = {
    ...parseConfig({
      platforms: { tg: { type: 'telegram', token: 't' } },
      hosts: { box: { ssh: 'u@box' } },
      agents: [
        { id: 'cc', harness: 'claude', model: 'opus' },
        { id: 'oc@box', harness: 'opencode', host: 'box', model: 'opencode/glm-5' },
        { id: 'ag@box', harness: 'agy', host: 'box' },
      ],
      routing: { default: 'cc' },
      podModels: { 'oc@box': 'opencode/glm-5' },
    }),
  };
  const pods = new Map<string, string | undefined>([
    ['oc@box', 'opencode/big-pickle'],
    ['ag@box', undefined],
  ]);
  const podRow = (id: string) => settingsRows(podCfg, pods).find((r) => r.target === id)!;

  it('knows which agents are a pod’s, and what each pod said', () => {
    expect(podRow('oc@box').pod).toEqual({ model: 'opencode/big-pickle' });
    expect(podRow('ag@box').pod).toEqual({});
    expect(podRow('cc').pod).toBeUndefined();
  });

  it('writes a pod agent to podModels and config.yaml’s own to agents[].model — never both', () => {
    expect(settingLocation(podRow('oc@box'))).toEqual({ kind: 'path', path: ['podModels', 'oc@box'] });
    expect(settingLocation(podRow('cc'))).toEqual({ kind: 'agent', agentId: 'cc', key: 'model' });
    // What is "already set" for a pod's agent is the gateway's entry, not the merged model.
    expect(readSettingValue(podRow('oc@box'), podCfg)).toBe('opencode/glm-5');
    expect(readSettingValue(podRow('ag@box'), podCfg)).toBeUndefined();
  });

  it('says where each value comes from', () => {
    expect(modelSource(podRow('oc@box'), podCfg)).toBe('gateway');
    expect(modelSource(podRow('ag@box'), podCfg)).toBe('unset');
    expect(modelSource(podRow('cc'), podCfg)).toBe('config');
    const noOverride = { ...podCfg, podModels: undefined } as Config;
    expect(modelSource(podRow('oc@box'), noOverride)).toBe('pod');
  });

  it('offers clearing back to the pod’s value, named as the pod’s', () => {
    const c: SettingsContext = { boundAgent: 'cc', models: [], pods };
    const options = settingOptions(podRow('oc@box'), podCfg, c);
    expect(options.at(-1)).toEqual({ raw: '-', label: 'opencode/big-pickle (pod.yaml)' });
    expect(parseSettingValue(podRow('oc@box'), '-', podCfg, c)).toEqual({
      kind: 'value',
      value: undefined,
      display: 'opencode/big-pickle (pod.yaml)',
    });
    // Nothing set here: nothing to clear.
    expect(settingOptions(podRow('ag@box'), podCfg, c)).toEqual([]);
  });

  it('resolves a typed key to the row that knows it is a pod’s', () => {
    const c: SettingsContext = { boundAgent: 'cc', models: [], pods };
    const r = resolveSettingKey('model.oc@box', podCfg, c);
    expect(r.kind === 'row' && r.row.pod).toEqual({ model: 'opencode/big-pickle' });
  });
});

describe('a model row’s list, for any agent', () => {
  const lists = (answer: SettingsContext['lists']): SettingsContext => ({ boundAgent: 'cc', models: [], lists: answer });

  it('offers what the gateway learned of an agent that is not answering here', () => {
    const c = lists(() => ({ kind: 'list', options: MODELS }));
    const options = settingOptions(row('model.oc', c), cfg, c);
    expect(options[0]).toEqual({ raw: 'opencode/big-pickle', label: 'Big Pickle', title: 'opencode/big-pickle', detail: 'Big Pickle' });
    expect(settingTypedOnlyHint(row('model.oc', c), cfg, c)).toBeUndefined();
    // And a typed fragment resolves against it, as it does for the agent answering here.
    expect(parseSettingValue(row('model.oc', c), 'kimi', cfg, c)).toMatchObject({ value: 'newapi/kimi-k3' });
  });

  it('says what it is waiting for, what the harness lacks, and what failed — each in its own words', () => {
    expect(settingTypedOnlyHint(row('model.oc', lists(() => ({ kind: 'loading' }))), cfg, lists(() => ({ kind: 'loading' })))).toContain(
      'Asking oc for its models'
    );
    const none = lists(() => ({ kind: 'none' }));
    expect(settingTypedOnlyHint(row('model.oc', none), cfg, none)).toContain('oc does not offer a model list');
    const err = lists(() => ({ kind: 'error', reason: 'ssh: no route' }));
    expect(settingTypedOnlyHint(row('model.oc', err), cfg, err)).toContain('did not start, so it could not be asked for its models (ssh: no route)');
    // Every one of them says what to type instead.
    expect(settingTypedOnlyHint(row('model.oc', err), cfg, err)).toContain('`/setting model.oc <name>`');
  });
});

describe('resolving what the user typed', () => {
  it('takes the short key and the full config path for the same setting', () => {
    expect(settingKeyOf(row('agent'))).toBe('agent');
    expect(settingKeyOf(row('routing.default'))).toBe('agent');
    expect(settingKeyOf(row('scope'))).toBe('scope');
    expect(settingKeyOf(row('session.scope'))).toBe('scope');
    expect(settingKeyOf(row('idle'))).toBe('idle');
    expect(settingKeyOf(row('session.idleTimeoutMs'))).toBe('idle');
    expect(settingKeyOf(row('stream'))).toBe('stream');
    expect(settingKeyOf(row('streaming'))).toBe('stream');
    expect(settingKeyOf(row('stream.enabled'))).toBe('stream');
  });

  it('points a bare per-agent key at the agent answering HERE', () => {
    expect(settingKeyOf(row('model'))).toBe('model.oc');
    expect(settingKeyOf(row('model', { boundAgent: 'cc', models: [] }))).toBe('model.cc');
  });

  it('takes an explicit target either way round', () => {
    expect(settingKeyOf(row('model.cc'))).toBe('model.cc');
    expect(settingKeyOf(row('agents.cc.model'))).toBe('model.cc');
    expect(settingKeyOf(row('MODEL.CC'))).toBe('model.cc'); // ids matched case-insensitively
  });

  it('says which agents exist when the target names none', () => {
    const resolved = resolveSettingKey('model.nope', cfg, ctx);
    expect(resolved.kind).toBe('refused');
    if (resolved.kind === 'refused') expect(resolved.text).toContain('cc, oc, own');
  });

  it('refuses the authorization allowlist BY NAME, saying why', () => {
    for (const key of ['access', 'access.allowFrom', 'allowFrom']) {
      const resolved = resolveSettingKey(key, cfg, ctx);
      expect(resolved.kind).toBe('refused');
      if (resolved.kind === 'refused') {
        expect(resolved.text).toContain('locks you out');
        expect(resolved.text).toContain('config.yaml');
      }
    }
  });

  it('refuses a pre-launch hook BY NAME: it is a shell command', () => {
    for (const key of ['hooks', 'hooks.preLaunch', 'preLaunch']) {
      const resolved = resolveSettingKey(key, cfg, ctx);
      expect(resolved.kind).toBe('refused');
      if (resolved.kind === 'refused') expect(resolved.text).toContain('shell command');
    }
  });

  it('refuses credentials without echoing anything about them', () => {
    const resolved = resolveSettingKey('platforms.tg.token', cfg, ctx);
    expect(resolved.kind).toBe('refused');
    if (resolved.kind === 'refused') {
      expect(resolved.text).toContain('chat log');
      expect(resolved.text).not.toContain('t'.repeat(2)); // no credential value in the answer
    }
  });

  it('refuses a frozen EXPERIENCE knob by explaining it is not in the file at all', () => {
    const resolved = resolveSettingKey('tools.mode', cfg, ctx);
    expect(resolved.kind).toBe('refused');
    if (resolved.kind === 'refused') expect(resolved.text).toContain('frozen in the code');
  });

  it('refuses the fields left off the table without pretending they do not exist', () => {
    for (const key of ['display.footer.enabled', 'chat.requireMention', 'routing.pipeline']) {
      expect(resolveSettingKey(key, cfg, ctx).kind).toBe('refused');
    }
  });

  it('calls an unrecognized name unknown, and points at the list', () => {
    const resolved = resolveSettingKey('banana', cfg, ctx);
    expect(resolved.kind).toBe('unknown');
    expect(settingUnknownKeyText('banana')).toContain('/setting');
  });
});

describe('the default agent', () => {
  it('offers every configured agent, marking none as impossible', () => {
    expect(settingOptions(row('agent'), cfg, ctx).map((o) => o.raw)).toEqual(['cc', 'oc', 'own']);
  });

  it('takes an id and reports it with its harness', () => {
    const parsed = parseSettingValue(row('agent'), 'oc', cfg, ctx);
    expect(parsed).toMatchObject({ kind: 'value', value: 'oc', display: 'oc · opencode' });
  });

  it('refuses an id that is not configured, listing the ones that are', () => {
    const parsed = parseSettingValue(row('agent'), 'nope', cfg, ctx);
    expect(parsed.kind).toBe('invalid');
    if (parsed.kind === 'invalid') expect(parsed.reason).toContain('cc, oc, own');
  });

  it('writes to routing.default', () => {
    expect(settingLocation(row('agent'))).toEqual({ kind: 'path', path: ['routing', 'default'] });
  });
});

describe("an agent's default model", () => {
  it('offers the live list of the agent answering here, plus a way back to the harness default', () => {
    const options = settingOptions(row('model.oc'), cfg, ctx).map((o) => o.raw);
    expect(options).toEqual([...MODELS.map((m) => m.value), '-']);
  });

  it('offers no list for another agent, and says why instead of showing an empty menu', () => {
    expect(settingOptions(row('model.cc'), cfg, ctx)).toEqual([]);
    expect(settingTypedOnlyHint(row('model.cc'), cfg, ctx)).toContain(
      'not answering this conversation'
    );
  });

  it('still says "type a name" when the only button left is "clear"', () => {
    // The case a first version got wrong: `oc` has a model set, so with no live list its value
    // screen offers exactly one option — clear it — which looks like a complete list and is not.
    expect(settingOptions(row('model.oc', bare), cfg, bare).map((o) => o.raw)).toEqual(['-']);
    expect(settingTypedOnlyHint(row('model.oc', bare), cfg, bare)).toContain('No model list from oc yet');
  });

  it('distinguishes "no list yet" from "not available here"', () => {
    // Same emptiness, different cause: before the first reply the list is merely late.
    const late = settingTypedOnlyHint(row('model.oc', bare), cfg, bare);
    const elsewhere = settingTypedOnlyHint(row('model.cc'), cfg, ctx);
    expect(late).not.toEqual(elsewhere);
    expect(late).toContain('arrives with the agent');
  });

  it('resolves a substring against the live list, as /model does', () => {
    expect(parseSettingValue(row('model.oc'), 'kimi', cfg, ctx)).toMatchObject({
      value: 'newapi/kimi-k3',
    });
  });

  it('prefers an exact id over a substring of a longer one', () => {
    // `opencode/glm-5` is a substring of `opencode/glm-5.1`, so a perfectly spelled id must win.
    expect(parseSettingValue(row('model.oc'), 'opencode/glm-5', cfg, ctx)).toMatchObject({
      value: 'opencode/glm-5',
    });
  });

  it('refuses an ambiguous query rather than guessing which model to run', () => {
    const parsed = parseSettingValue(row('model.oc'), 'claude', cfg, ctx);
    expect(parsed.kind).toBe('invalid');
    if (parsed.kind === 'invalid') {
      expect(parsed.reason).toContain('newapi/claude-opus-5');
      expect(parsed.reason).toContain('newapi/claude-sonnet-5');
    }
  });

  it('accepts a name the harness never advertised, and says so', () => {
    // The selector is not the set of names a harness accepts — claude documents aliases (`opusplan`,
    // `best`) that the ACP config option never lists, and `agents[].model` is a free string for
    // exactly that reason. Refusing here would block a legitimate value.
    const parsed = parseSettingValue(row('model.oc'), 'opusplan', cfg, ctx);
    expect(parsed).toMatchObject({ kind: 'value', value: 'opusplan' });
    if (parsed.kind === 'value') expect(parsed.note).toContain('does not advertise');
  });

  it('takes any name verbatim when there is no list to check against', () => {
    const parsed = parseSettingValue(row('model.cc'), 'claude-opus-5', cfg, ctx);
    expect(parsed).toMatchObject({ kind: 'value', value: 'claude-opus-5' });
    if (parsed.kind === 'value') expect(parsed.note).toBeUndefined();
  });

  it('clears back to the harness default, which means DELETING the key', () => {
    // Not null: `agents[].model` is z.string().optional(), so a null would fail the next load.
    for (const token of ['-', 'default', 'unset', 'clear']) {
      expect(parseSettingValue(row('model.oc'), token, cfg, ctx)).toEqual({
        kind: 'value',
        value: undefined,
        display: '(harness default)',
      });
    }
  });

  it('writes to the agent named by id, never by array position', () => {
    expect(settingLocation(row('model.oc'))).toEqual({
      kind: 'agent',
      agentId: 'oc',
      key: 'model',
    });
  });
});

describe('the idle reclaim window', () => {
  it('reads out in the vocabulary the parser takes back', () => {
    expect(formatIdle(0)).toBe('off');
    expect(formatIdle(900_000)).toBe('15m');
    expect(formatIdle(3_600_000)).toBe('1h');
    expect(formatIdle(14_400_000)).toBe('4h');
    expect(formatIdle(5_400_000)).toBe('90m'); // not a whole number of hours
    for (const shown of ['off', '15m', '1h', '4h', '90m']) {
      expect(parseSettingValue(row('idle'), shown, cfg, ctx).kind).toBe('value');
    }
  });

  it('takes minutes and hours', () => {
    expect(parseSettingValue(row('idle'), '15m', cfg, ctx)).toMatchObject({ value: 900_000 });
    expect(parseSettingValue(row('idle'), '4h', cfg, ctx)).toMatchObject({ value: 14_400_000 });
    expect(parseSettingValue(row('idle'), '90 minutes', cfg, ctx)).toMatchObject({ value: 5_400_000 });
  });

  it('turns reclaim off', () => {
    for (const token of ['off', 'never', '0']) {
      expect(parseSettingValue(row('idle'), token, cfg, ctx)).toMatchObject({ value: 0, display: 'off' });
    }
  });

  it('refuses a bare number instead of guessing a unit', () => {
    // The field is milliseconds and nobody means milliseconds; reading `30` as minutes would set a
    // window 60000× off what was typed, and reading it literally would reclaim instantly.
    const parsed = parseSettingValue(row('idle'), '30', cfg, ctx);
    expect(parsed.kind).toBe('invalid');
    if (parsed.kind === 'invalid') expect(parsed.reason).toContain('15m');
  });

  it('refuses a window past a month, which is a typo rather than a policy', () => {
    expect(parseSettingValue(row('idle'), '999h', cfg, ctx).kind).toBe('invalid');
    expect(parseSettingValue(row('idle'), '720h', cfg, ctx).kind).toBe('value');
  });
});

describe('the conversation scope', () => {
  it('offers every scope the schema accepts', () => {
    // satisfies-backed in the source; asserted here so a new SessionScope cannot ship unofferable.
    const offered = settingOptions(row('scope'), cfg, ctx).map((o) => o.raw);
    expect(offered.sort()).toEqual([...SessionScope.options].sort());
  });

  it('takes a scope and refuses a near-miss spelling', () => {
    expect(parseSettingValue(row('scope'), 'per_user', cfg, ctx)).toMatchObject({ value: 'per_user' });
    const parsed = parseSettingValue(row('scope'), 'per-user', cfg, ctx);
    expect(parsed.kind).toBe('invalid');
    if (parsed.kind === 'invalid') expect(parsed.reason).toContain('per_thread');
  });
});

describe('the live-streaming switch', () => {
  it('offers exactly on and off, each labelled with what it does', () => {
    const offered = settingOptions(row('stream'), cfg, ctx);
    expect(offered.map((o) => o.raw)).toEqual(['off', 'on']);
    // Off is listed first because it is the default; the labels say the consequence, not the word.
    expect(offered[0]!.label).toContain('whole message');
    expect(offered[1]!.label).toContain('editing one message');
  });

  it('takes the spellings a person actually types for a toggle', () => {
    for (const yes of ['on', 'On', 'true', 'yes', 'y', '1', 'enable', 'enabled']) {
      expect(parseSettingValue(row('stream'), yes, cfg, ctx)).toMatchObject({ value: true, display: 'on' });
    }
    for (const no of ['off', 'OFF', 'false', 'no', 'n', '0', 'disable', 'disabled']) {
      expect(parseSettingValue(row('stream'), no, cfg, ctx)).toMatchObject({ value: false, display: 'off' });
    }
  });

  it('refuses an unrecognized word instead of reading it as off', () => {
    // Coercing would flip a switch the user believes they just turned on.
    const parsed = parseSettingValue(row('stream'), 'sure', cfg, ctx);
    expect(parsed.kind).toBe('invalid');
    if (parsed.kind === 'invalid') expect(parsed.reason).toContain('on or off');
  });

  it('is no longer refused by name — it is a real config field now', () => {
    expect(resolveSettingKey('stream.enabled', cfg, ctx).kind).toBe('row');
    // The rest of that config section stays refused.
    expect(resolveSettingKey('tools.mode', cfg, ctx).kind).toBe('refused');
  });
});

describe('reading the stored value back', () => {
  it('returns the patch-shaped value, not the display string', () => {
    expect(readSettingValue(row('agent'), cfg)).toBe('cc'); // not `cc · claude`
    expect(readSettingValue(row('model.oc'), cfg)).toBe('opencode/big-pickle');
    expect(readSettingValue(row('model.cc'), cfg)).toBeUndefined(); // unset, not '(harness default)'
    expect(readSettingValue(row('idle'), cfg)).toBe(3_600_000); // not '1h'
    expect(readSettingValue(row('scope'), cfg)).toBe('per_thread');
    expect(readSettingValue(row('stream'), cfg)).toBe(false); // the boolean, not 'off'
  });
});

describe('what the ack says', () => {
  const saved = (key: string, display: string, extra: Record<string, unknown> = {}): string =>
    settingAckText({ kind: 'saved', row: row(key), display, ...extra });

  it('promises immediate effect only where the runtime re-reads the value', () => {
    expect(saved('agent', 'oc · opencode')).toContain('in effect now');
    expect(saved('idle', '4h')).toContain('in effect now');
  });

  it('says a model lands on the next agent session, and how to start one', () => {
    const ack = saved('model.oc', 'newapi/kimi-k3');
    expect(ack).toContain('next agent session');
    expect(ack).toContain('/new');
  });

  it('says a scope change waits for a restart, and that conversations keep their identity', () => {
    const ack = saved('scope', 'per_channel');
    expect(ack).toContain('restarts');
    expect(ack).toContain('current identity');
  });

  it('warns when a /model override is shadowing the default just written', () => {
    expect(saved('model.oc', 'newapi/kimi-k3', { overridden: true })).toContain('`/model` override');
  });

  it('carries the "not advertised" note through to the user', () => {
    expect(saved('model.oc', 'opusplan', { note: 'oc does not advertise that name' })).toContain(
      'does not advertise'
    );
  });

  it('reports an unchanged value without claiming a write', () => {
    const ack = settingAckText({ kind: 'unchanged', row: row('scope') });
    expect(ack).toContain('already');
    expect(ack).not.toContain('Saved');
  });

  it('passes a refusal through verbatim, and names the setting on a failure', () => {
    expect(settingAckText({ kind: 'invalid', row: row('idle'), reason: 'nope' })).toBe('nope');
    expect(settingAckText({ kind: 'failed', row: row('idle'), reason: 'EACCES' })).toContain('EACCES');
  });
});

describe('the detail screen', () => {
  it('shows the value, the options as typeable commands, and when a change lands', () => {
    const text = settingDetailText(row('scope'), cfg, ctx);
    expect(text).toContain('per_thread');
    expect(text).toContain('/setting scope per_channel');
    expect(text).toContain('restarts');
  });

  it('caps a long option list rather than printing 90 lines onto a phone', () => {
    const text = settingDetailText(row('model.oc'), cfg, ctx);
    expect(text).toContain('…and 2 more'); // 14 options (13 models + clear) against a cap of 12
    expect(settingDetailText(row('agent'), cfg, ctx)).not.toContain('…and');
  });
});

describe('button ids', () => {
  it('round-trip through the shared grammar', () => {
    expect(parseSettingButtonId(settingRowButtonId('abc', 3))).toEqual({
      kind: 'open',
      reqId: 'abc',
      index: 3,
    });
    expect(parseSettingButtonId(settingValueButtonId('abc', 12))).toEqual({
      kind: 'choose',
      reqId: 'abc',
      index: 12,
    });
    expect(parseSettingButtonId(settingPageButtonId('abc', 2))).toEqual({
      kind: 'page',
      reqId: 'abc',
      page: 2,
    });
    expect(parseSettingButtonId(settingBackButtonId('abc'))).toEqual({ kind: 'back', reqId: 'abc' });
  });

  it('ignore another menu\'s ids and malformed ones', () => {
    expect(parseSettingButtonId('mdl:abc:1')).toBeNull();
    expect(parseSettingButtonId('cmd:abc:1')).toBeNull();
    expect(parseSettingButtonId('ask:abc:1')).toBeNull();
    expect(parseSettingButtonId('stg:abc')).toBeNull();
    expect(parseSettingButtonId('stg::1')).toBeNull();
  });

  it('stay short enough for Telegram\'s 64-byte callback_data cap', () => {
    // Over the cap the profile hashes it lossily and the button comes back unresolvable.
    expect(settingValueButtonId('abcd1234', 999).length).toBeLessThan(64);
  });
});

describe('opening a value menu', () => {
  it('lands on the page holding the current value rather than always the first', () => {
    const options = settingOptions(row('model.oc'), cfg, ctx);
    // `opencode/big-pickle` is index 0 of 14 → page 0; a later current value pages forward.
    expect(settingValuePage(row('model.oc'), options)).toBe(0);
    const late: SettingRow = { ...row('model.oc'), value: 'newapi/kimi-k3' }; // index 6
    expect(settingValuePage(late, options)).toBe(1);
    expect(settingValuePage({ ...row('model.oc'), value: 'newapi/yi-3' }, options)).toBe(2); // index 12
  });

  it('falls back to the first page when the current value is not in the list', () => {
    const options = settingOptions(row('model.oc'), cfg, ctx);
    expect(settingValuePage({ ...row('model.oc'), value: 'opusplan' }, options)).toBe(0);
  });
});

describe('the sub-agent confirmation switch', () => {
  it('is on by default, live, and resolves from `delegation` and `delegation.confirm`', () => {
    const r = resolveSettingKey('delegation', cfg, ctx);
    expect(r.kind).toBe('row');
    if (r.kind !== 'row') throw new Error('expected a row');
    expect(r.row).toMatchObject({
      id: 'delegation',
      label: 'Confirm sub-agent starts',
      value: 'on',
      effect: 'live',
    });
    expect(settingLocation(r.row)).toEqual({ kind: 'path', path: ['delegation', 'confirm'] });
    expect(resolveSettingKey('delegation.confirm', cfg, ctx).kind).toBe('row');
  });

  it('takes on/off like every toggle, and reads back the boolean', () => {
    const r = row('delegation');
    expect(parseSettingValue(r, 'off', cfg, ctx)).toMatchObject({ value: false, display: 'off' });
    expect(parseSettingValue(r, 'on', cfg, ctx)).toMatchObject({ value: true, display: 'on' });
    expect(settingOptions(r, cfg, ctx).map((o) => o.raw)).toEqual(['on', 'off']);
    expect(readSettingValue(r, cfg)).toBe(true);
  });

  it('says what off means: each starts at once, and a card still shows what started', () => {
    const text = settingDescription(row('delegation'));
    expect(text).toContain('starts each one at once');
    expect(text).toContain('posts a card showing what started');
    expect(text).toContain('Only you can change this');
  });
});

describe('the voice-confirmation switch', () => {
  const withVoice: Config = parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc' },
    voice: { transcriber: { baseUrl: 'http://gw/v1beta', apiKey: 'k', model: 'gemini-3-flash' } },
  });
  const voiceCtx: SettingsContext = { boundAgent: 'cc', models: [] };

  it('is a row only where transcription is configured — a switch for a feature that is off does nothing', () => {
    expect(settingsRows(cfg).some((r) => r.id === 'voice')).toBe(false);
    expect(settingsRows(cfg).some((r) => r.id === 'cleanup')).toBe(false);
    const rows = settingsRows(withVoice);
    // After the always-present rows, so every row above them keeps its menu index whether or not
    // the feature is on (the two review rows follow, last of all).
    expect(rows.slice(-4, -2)).toMatchObject([
      { id: 'voice', value: 'on', effect: 'live' },
      { id: 'cleanup', value: 'on', effect: 'live' },
    ]);
  });

  it('resolves `cleanup` and `voice.cleanup`, and writes voice.cleanup', () => {
    for (const key of ['cleanup', 'voice.cleanup', 'voice-cleanup']) {
      const r = resolveSettingKey(key, withVoice, voiceCtx);
      expect(r.kind).toBe('row');
      if (r.kind === 'row') expect(settingLocation(r.row)).toEqual({ kind: 'path', path: ['voice', 'cleanup'] });
    }
    const r = resolveSettingKey('cleanup', withVoice, voiceCtx);
    if (r.kind !== 'row') throw new Error('expected a row');
    expect(parseSettingValue(r.row, 'off', withVoice, voiceCtx)).toMatchObject({ value: false, display: 'off' });
    expect(readSettingValue(r.row, withVoice)).toBe(true);
  });

  it('resolves `voice` and `voice.confirm`, and writes voice.confirm', () => {
    for (const key of ['voice', 'voice.confirm']) {
      const r = resolveSettingKey(key, withVoice, voiceCtx);
      expect(r.kind).toBe('row');
      if (r.kind === 'row') expect(settingLocation(r.row)).toEqual({ kind: 'path', path: ['voice', 'confirm'] });
    }
  });

  it('takes on/off like every toggle, and reads back the boolean', () => {
    const r = resolveSettingKey('voice', withVoice, voiceCtx);
    if (r.kind !== 'row') throw new Error('expected a row');
    expect(parseSettingValue(r.row, 'off', withVoice, voiceCtx)).toMatchObject({ value: false, display: 'off' });
    expect(settingOptions(r.row, withVoice, voiceCtx).map((o) => o.raw)).toEqual(['on', 'off']);
    expect(readSettingValue(r.row, withVoice)).toBe(true);
  });

  it('refuses the transcriber, and the switch itself where there is no voice: block, by name', () => {
    const transcriber = resolveSettingKey('voice.transcriber.model', withVoice, voiceCtx);
    expect(transcriber.kind).toBe('refused');
    if (transcriber.kind === 'refused') expect(transcriber.text).toContain('endpoint and a key');
    expect(resolveSettingKey('voice.vocabulary', withVoice, voiceCtx).kind).toBe('refused');
    expect(resolveSettingKey('voice', cfg, ctx).kind).toBe('refused');
    expect(resolveSettingKey('cleanup', cfg, ctx).kind).toBe('refused');
  });
});

describe('auto review', () => {
  const reviewCfg: Config = parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude' },
      { id: 'ag', harness: 'agy' },
      { id: 'ag2', harness: 'agy', model: 'gemini-2.5-pro' },
    ],
    routing: { default: 'cc' },
    review: { agent: 'ag' },
  });
  const AGY_MODELS = [
    { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash High' },
    { value: 'gemini-3.8-pro', name: 'Gemini 3.8 Pro' },
  ];
  const reviewCtx: SettingsContext = {
    boundAgent: 'cc',
    models: [],
    lists: (id) => (id === 'ag' ? { kind: 'list', options: AGY_MODELS } : undefined),
  };
  const reviewRow = (key: string, cfg: Config = reviewCfg, ctx: SettingsContext = reviewCtx): SettingRow => {
    const resolved = resolveSettingKey(key, cfg, ctx);
    if (resolved.kind !== 'row') throw new Error(`${key} did not resolve to a row: ${resolved.kind}`);
    return resolved.row;
  };

  it('offers off and the agy agents only — a non-agy agent cannot review', () => {
    const r = reviewRow('review.agent');
    expect(settingOptions(r, reviewCfg, reviewCtx).map((o) => [o.raw, o.title])).toEqual([
      ['off', 'off'],
      ['ag', undefined],
      ['ag2', undefined],
    ]);
    const refused = parseSettingValue(r, 'cc', reviewCfg, reviewCtx);
    expect(refused.kind).toBe('invalid');
    if (refused.kind === 'invalid') {
      expect(refused.reason).toContain('claude');
      expect(refused.reason).toContain('agy -p');
    }
    // An unknown id names the agy agents there are, rather than the whole roster.
    const unknown = parseSettingValue(r, 'nope', reviewCfg, reviewCtx);
    if (unknown.kind !== 'invalid') throw new Error('expected a refusal');
    expect(unknown.reason).toContain('ag, ag2');
    expect(unknown.reason).not.toContain('cc');
  });

  it('turns off by deleting the whole block, and says the model goes with it', () => {
    const withModel = parseConfig({
      platforms: { tg: { type: 'telegram', token: 't' } },
      agents: [{ id: 'ag', harness: 'agy' }],
      routing: { default: 'ag' },
      review: { agent: 'ag', model: 'gemini-3.8-pro' },
    });
    const r = reviewRow('review.agent', withModel);
    expect(parseSettingValue(r, 'off', withModel, reviewCtx)).toMatchObject({
      kind: 'value',
      value: undefined,
      display: 'off',
      note: expect.stringContaining('review model'),
    });
    expect(settingLocation(r)).toEqual({ kind: 'path', path: ['review', 'agent'] });
  });

  it('names the reviewer by id and harness, and follows its own model until one is set', () => {
    const values = new Map(settingsRows(reviewCfg).map((r) => [settingKeyOf(r), r]));
    expect(values.get('review.agent')?.value).toBe('ag · agy');
    expect(values.get('review.model')?.value).toBe("agent's own");
    expect(values.get('review.agent')?.effect).toBe('live');
    expect(values.get('review.model')?.effect).toBe('live');
    expect(settingLocation(values.get('review.model')!)).toEqual({
      kind: 'path',
      path: ['review', 'model'],
    });
  });

  it('takes a model from the reviewer list, refuses an ambiguous one, and clears back to the agent', () => {
    const r = reviewRow('review.model');
    expect(settingOptions(r, reviewCfg, reviewCtx).map((o) => o.raw)).toEqual(AGY_MODELS.map((m) => m.value));
    expect(parseSettingValue(r, 'flash-high', reviewCfg, reviewCtx)).toMatchObject({
      kind: 'value',
      value: 'gemini-3.8-flash-high',
    });
    expect(parseSettingValue(r, 'gemini', reviewCfg, reviewCtx).kind).toBe('invalid');
    const cleared = parseSettingValue(r, '-', reviewCfg, reviewCtx);
    expect(cleared).toMatchObject({ kind: 'value', value: undefined, display: 'follow ag (its own model)' });
  });

  it('refuses a model while review is off, and says how to turn it on', () => {
    const offCfg: Config = parseConfig({
      platforms: { tg: { type: 'telegram', token: 't' } },
      agents: [{ id: 'cc', harness: 'claude' }, { id: 'ag', harness: 'agy' }],
      routing: { default: 'cc' },
    });
    const r = reviewRow('review.model', offCfg);
    expect(settingOptions(r, offCfg, reviewCtx)).toEqual([]);
    const parsed = parseSettingValue(r, 'gemini-3.8-pro', offCfg, reviewCtx);
    expect(parsed.kind).toBe('invalid');
    if (parsed.kind === 'invalid') expect(parsed.reason).toContain('/setting review.agent');
    expect(settingTypedOnlyHint(r, offCfg, reviewCtx)).toContain('/setting review.agent');
    // And it reads as off, not as a model nobody chose.
    expect(settingsRows(offCfg).find((x) => x.id === 'review.model')?.value).toBe('off');
  });

  it('accepts a typed name when the reviewer offers no list, saying it was not advertised', () => {
    const r = reviewRow('review.model');
    const noList: SettingsContext = { boundAgent: 'cc', models: [] };
    const parsed = parseSettingValue(r, 'some-model', reviewCfg, noList);
    expect(parsed).toMatchObject({ kind: 'value', value: 'some-model' });
    if (parsed.kind === 'value') expect(parsed.note).toContain('did not offer its model list');
  });

  it('resolves `review` to the reviewer and both dotted keys to their rows', () => {
    expect(settingKeyOf(reviewRow('review'))).toBe('review.agent');
    expect(settingKeyOf(reviewRow('reviewer'))).toBe('review.agent');
    expect(settingKeyOf(reviewRow('review.model'))).toBe('review.model');
  });
});
