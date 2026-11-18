import { describe, expect, it } from 'vitest';
import type { SettingsScreenRow } from '../types.js';
import { parseConfig, type Config } from '../config/schema.js';
import {
  buildSettingsMenu,
  settingOptions,
  settingRowButtonId,
  settingSetButtonId,
  settingsRows,
  type SettingsContext,
} from './settings.js';

/**
 * The Agents group of the settings screen: one row per agent, every per-agent setting a field
 * inside it.
 *
 * The merge is presentation, but two things it must not move are not: the `stg:` id a field
 * carries (a tap opens the value screen that row opened before) and the `sts:` ids its options
 * carry (a click resolves against the list the daemon froze). Both are asserted here against the
 * ids the rows themselves generate, not against literals, so a change to either side fails.
 */

const cfg: Config = parseConfig({
  platforms: { tg: { type: 'telegram', token: 't' } },
  hosts: { uniagent: { ssh: 'u@uniagent' } },
  agents: [
    { id: 'cc', harness: 'claude' },
    { id: 'oc', harness: 'opencode', model: 'opencode/big-pickle' },
    { id: 'cbc@uniagent', harness: 'opencode', host: 'uniagent' },
  ],
  routing: { default: 'cc' },
});

/** claude's modes: every level has one, so a permission field is a full choice. */
const MODES = [
  { value: 'default', name: 'Default' },
  { value: 'acceptEdits', name: 'Accept edits' },
  { value: 'plan', name: 'Plan' },
  { value: 'bypassPermissions', name: 'Bypass permissions' },
];

const ctx: SettingsContext = {
  boundAgent: 'cc',
  models: [],
  modes: () => ({ kind: 'list', options: MODES }),
};

const screenOf = (rows = settingsRows(cfg), c: Config = cfg) => {
  const view = buildSettingsMenu({
    reqId: 'r1',
    rows,
    screen: { cfg: c, options: (r) => settingOptions(r, c, ctx), here: ctx.boundAgent },
  });
  if (view.screen?.level !== 'list') throw new Error('no list screen');
  return { rows, view, screen: view.screen };
};

const fieldsOf = (row: SettingsScreenRow) => {
  if (row.control.kind !== 'agent') throw new Error(`${row.label} is not an agent row`);
  return row.control.fields;
};

describe('the Agents group', () => {
  it('puts the default agent first, then one row per agent, each with its settings as fields', () => {
    const { screen } = screenOf();
    expect(screen.rows.map((r) => [r.label, r.target, r.group])).toEqual([
      ['Default agent', undefined, 'Agents'],
      ['cc', 'cc', 'Agents'],
      ['oc', 'oc', 'Agents'],
      ['cbc@uniagent', 'cbc@uniagent', 'Agents'],
      ['Confirm sub-agent starts', undefined, 'Sub-agents'],
      ['Idle reclaim', undefined, 'Conversations'],
      ['Conversation scope', undefined, 'Conversations'],
      ['Live streaming', undefined, 'Replies'],
      ['Auto review', undefined, 'Reviews'],
      ['Review model', undefined, 'Reviews'],
    ]);
    // The model rows' order, which is config order, is the agent rows' order too.
    expect(screen.rows.slice(1, 4).map((r) => r.target)).toEqual(['cc', 'oc', 'cbc@uniagent']);

    const cc = screen.rows[1]!;
    expect(fieldsOf(cc).map((f) => [f.label, f.value])).toEqual([
      ['Model', 'harness default'],
      ['Permissions', 'auto'],
    ]);
    // The row posts the first field's id, so tapping the row opens the model's values.
    expect(cc.buttonId).toBe(fieldsOf(cc)[0]!.buttonId);
    expect(cc).toMatchObject({ targetKind: 'Claude Code', here: true });
  });

  it('keeps each field’s stg: id the one its own row had', () => {
    const { screen, rows } = screenOf();
    for (const target of ['cc', 'oc', 'cbc@uniagent']) {
      const [model, permissions] = fieldsOf(screen.rows.find((r) => r.target === target)!);
      expect(model!.buttonId).toBe(
        settingRowButtonId('r1', rows.findIndex((r) => r.id === 'model' && r.target === target))
      );
      expect(permissions!.buttonId).toBe(
        settingRowButtonId('r1', rows.findIndex((r) => r.id === 'permissions' && r.target === target))
      );
    }
  });

  it('numbers the permission choices as the row-by-row screen did, and they write the same level', () => {
    const { screen, rows, view } = screenOf();
    const choices = view.choices ?? [];
    const permissions = fieldsOf(screen.rows.find((r) => r.target === 'cc')!).find(
      (f) => f.label === 'Permissions'
    )!;
    if (permissions.control.kind !== 'choice') throw new Error('permissions is not a choice');
    expect(permissions.control.options.map((o) => o.label)).toEqual(['plan', 'ask', 'edits', 'auto', 'full']);
    // The default agent's three choices are numbered first, so the first level is still `sts:r1:3`
    // — merging must not renumber the list the daemon froze with the menu.
    expect(permissions.control.options[0]!.buttonId).toBe(settingSetButtonId('r1', 3));
    const permissionsRow = rows.findIndex((r) => r.id === 'permissions' && r.target === 'cc');
    expect(
      permissions.control.options.map((o) => choices[Number(o.buttonId.split(':').at(-1))])
    ).toEqual([
      { row: permissionsRow, raw: 'plan' },
      { row: permissionsRow, raw: 'ask' },
      { row: permissionsRow, raw: 'edits' },
      { row: permissionsRow, raw: 'auto' },
      { row: permissionsRow, raw: 'full' },
    ]);
  });

  it('draws one field when only one of the settings is in the list', () => {
    const withoutPermissions = settingsRows(cfg).filter((r) => r.id !== 'permissions');
    const { screen: onlyModel } = screenOf(withoutPermissions);
    const oc = onlyModel.rows.find((r) => r.target === 'oc')!;
    expect(fieldsOf(oc).map((f) => f.label)).toEqual(['Model']);
    expect(oc.buttonId).toBe(fieldsOf(oc)[0]!.buttonId);

    const withoutModel = settingsRows(cfg).filter((r) => r.id !== 'model');
    const { screen: onlyPermissions } = screenOf(withoutModel);
    const cc = onlyPermissions.rows.find((r) => r.target === 'cc')!;
    expect(fieldsOf(cc).map((f) => f.label)).toEqual(['Permissions']);
    expect(cc.buttonId).toBe(fieldsOf(cc)[0]!.buttonId);
  });

  it('merges a pod agent’s rows under its own id, keeping where its model comes from', () => {
    const podCfg: Config = parseConfig({
      platforms: { tg: { type: 'telegram', token: 't' } },
      hosts: { uniagent: { ssh: 'u@uniagent' } },
      agents: [
        { id: 'cc', harness: 'claude' },
        { id: 'cbc@uniagent', harness: 'opencode', host: 'uniagent', model: 'claude-opus-4-5' },
      ],
      routing: { default: 'cc' },
    });
    const pods = new Map<string, string | undefined>([['cbc@uniagent', 'claude-opus-4-5']]);
    const { screen } = screenOf(settingsRows(podCfg, pods), podCfg);
    const row = screen.rows.find((r) => r.target === 'cbc@uniagent')!;
    expect(row.label).toBe('cbc@uniagent');
    expect(row.targetKind).toBe('OpenCode');
    expect(fieldsOf(row).map((f) => f.label)).toEqual(['Model', 'Permissions']);
    expect(fieldsOf(row)[0]).toMatchObject({
      value: 'claude-opus-4-5',
      valueNote: 'pod.yaml',
    });
  });

  it('says what the agent rows are and when a change lands, in two sentences', () => {
    const { screen } = screenOf();
    expect(screen.groups[0]).toEqual({ name: 'Agents', note: expect.any(String) });
    const note = screen.groups[0]!.note!;
    expect(note).toContain('next session');
    expect(note).toContain('/model');
    expect(note).toContain('applies at once');
    // The group note is read on a phone; the levels and what each asks belong to the value screen.
    expect(note.split('. ')).toHaveLength(2);
    for (const level of ['plan', 'ask', 'edits', 'auto', 'full']) expect(note).not.toContain(level);
  });

  it('leaves the chat menu’s text and buttons exactly as they were', () => {
    const rows = settingsRows(cfg);
    const plain = buildSettingsMenu({ reqId: 'r1', rows });
    const { view } = screenOf(rows);
    expect(view.text).toBe(plain.text);
    expect(view.buttons).toEqual(plain.buttons);
  });
});
