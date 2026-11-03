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
  settingKeyOf,
  settingLocation,
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
      'idle',
      'scope',
      'stream',
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
      screen: true,
    });
    const screen = view.screen;
    expect(screen?.level).toBe('list');
    if (screen?.level !== 'list') throw new Error('no list screen');

    expect(screen.rows.map((r) => [r.label, r.target, r.value, r.group])).toEqual([
      ['Default agent', undefined, 'cc · claude', 'Agent defaults'],
      ['Default model', 'cc', '(harness default)', 'Agent defaults'],
      ['Default model', 'oc', 'opencode/big-pickle', 'Agent defaults'],
      ['Default model', 'own', '(harness default)', 'Agent defaults'],
      ['Idle reclaim', undefined, '1h', 'Conversation'],
      ['Conversation scope', undefined, 'per_thread', 'Conversation'],
      ['Live streaming', undefined, 'off', 'Replies'],
      ['⏰ Scheduled tasks · 2 active', undefined, undefined, 'More'],
    ]);
    // The screen and the buttons are two views of one list: a tap must post the id the button
    // would have posted.
    expect(screen.rows.map((r) => r.buttonId)).toEqual(view.buttons.map((b) => b.id));
    expect(screen.rows[1]!.effectLabel).toBe('next session');
    expect(screen.rows[5]!.effectLabel).toBe('after restart');
    // The whole value, which the chat label truncates at 40 characters.
    expect(screen.rows[2]!.value).toBe('opencode/big-pickle');
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
      screen: true,
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
    const view = buildSettingValueMenu({ reqId: 'r3', row: r, options, page: 0, screen: true });
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
    // Last, so every row above them keeps its menu index whether or not the feature is on.
    expect(rows.slice(-2)).toMatchObject([
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
