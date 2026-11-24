import { describe, expect, it } from 'vitest';

import type { SettingsScreen, SettingsScreenOption } from '../../../../../types.js';
import {
  AG_HUES,
  agHue,
  inlineCodeHtml,
  renderSettingsScreen,
  settingsChoiceHtml,
  settingsLabelHtml,
  settingsNoticeHtml,
  type SettingsRenderContext,
} from './render.js';
import type { SettingsWebMessage } from './types.js';

function baseCtx(overrides: Partial<SettingsRenderContext> = {}): SettingsRenderContext {
  return {
    topicTitle: 'Demo Topic',
    errorNote: null,
    openAgentId: null,
    renderOrphans: () => '',
    renderAgentInstructions: () => '',
    ...overrides,
  };
}

function webMsg(id: string, settings?: SettingsScreen): SettingsWebMessage {
  return { id, own: false, html: '', at: 0, buttons: [], reactions: [], settings };
}

describe('features/settings/render', () => {
  it('hashes built-in harness names onto distinct deterministic hues', () => {
    const harnesses = ['Claude Code', 'Codex', 'OpenCode', 'Antigravity', 'Gemini CLI', 'DeepSeek Harness'];
    const hues = harnesses.map((h) => agHue(h));
    expect(new Set(hues).size).toBe(harnesses.length);
    for (const h of hues) {
      expect(AG_HUES).toContain(h);
    }
    expect(agHue('Claude Code')).toBe(agHue('Claude Code'));
    expect(agHue(undefined)).toBe(AG_HUES[0]);
  });

  it('escapes HTML before rendering inline code spans', () => {
    expect(inlineCodeHtml('Run `<script>alert(1)</script>` now')).toBe(
      'Run <code>&lt;script&gt;alert(1)&lt;/script&gt;</code> now',
    );
    expect(inlineCodeHtml(null)).toBe('');
  });

  it('replaces leading clock emoji with inline SVG icon in labels', () => {
    const html = settingsLabelHtml('⏰ Scheduled tasks');
    expect(html).toContain('<svg');
    expect(html).toContain('Scheduled tasks');
    expect(html).not.toContain('⏰');
    expect(settingsLabelHtml('Idle <reclaim>')).toBe('<span>Idle &lt;reclaim&gt;</span>');
  });

  it('renders notices with appropriate ARIA role and tone fallback', () => {
    expect(settingsNoticeHtml(null)).toBe('');
    expect(settingsNoticeHtml({ tone: 'ok', text: 'Saved `config.yaml`' })).toContain('role="status"');
    expect(settingsNoticeHtml({ tone: 'error', text: 'Failed' })).toContain('role="alert"');
  });

  it('renders segmented radio controls for <= 5 short options and <select> otherwise', () => {
    const shortOpts: SettingsScreenOption[] = [
      { buttonId: 'b1', label: 'auto', current: true, detail: 'Approve all' },
      { buttonId: 'b2', label: 'ask', current: false, detail: 'Ask each time' },
    ];
    const seg = settingsChoiceHtml('Permissions', shortOpts, 'r0f1', 'auto');
    expect(seg).toContain('role="radiogroup"');
    expect(seg).toContain('role="radio"');
    expect(seg).toContain('aria-checked="true"');
    expect(seg).toContain('data-fk="r0f1o0"');

    const longOpts: SettingsScreenOption[] = [
      { buttonId: 'b1', label: 'per_channel', current: false },
      { buttonId: 'b2', label: 'per_thread', current: false },
    ];
    const sel = settingsChoiceHtml('Scope', longOpts, 'r1', 'custom-90m');
    expect(sel).toContain('<select class="set-select"');
    expect(sel).toContain('<option value="" selected disabled>custom-90m</option>');
  });

  it('renders list screen with groups, plain controls, agent cards by place, and orphan instructions', () => {
    const screen: SettingsScreen = {
      level: 'list',
      about: 'Saved to `config.yaml`.',
      groups: [{ name: 'Agents', note: 'Applies to `next session`.' }],
      rows: [
        {
          group: 'General',
          label: 'Auto-approve',
          buttonId: 'sw:1',
          control: { kind: 'switch', on: true, set: 'sts:1:0' },
        },
        {
          group: 'Agents',
          label: 'cc',
          target: 'cc',
          targetKind: 'Claude Code',
          place: 'local',
          here: true,
          defaultAgent: true,
          buttonId: 'stg:cc',
          control: {
            kind: 'agent',
            fields: [
              { label: 'Model', buttonId: 'stg:cc:m', value: 'sonnet', control: { kind: 'list' } },
              {
                label: 'Permissions',
                buttonId: 'stg:cc:p',
                value: 'auto',
                control: {
                  kind: 'choice',
                  options: [{ buttonId: 'sts:p:0', label: 'auto', current: true, detail: 'Always allow' }],
                },
              },
            ],
          },
        },
        {
          group: 'Agents',
          label: 'cx@box',
          target: 'cx@box',
          targetKind: 'Codex',
          place: 'box',
          buttonId: 'stg:cx',
          control: { kind: 'agent', fields: [] },
        },
      ],
    };
    const msg: SettingsWebMessage = webMsg('m1', screen);
    const html = renderSettingsScreen(
      msg,
      baseCtx({
        openAgentId: 'cc',
        renderOrphans: () => '<div class="orphan-marker"></div>',
        renderAgentInstructions: (row) => `<div class="instr-marker">${row.label}</div>`,
      }),
    );

    expect(html).toContain('Saved to <code>config.yaml</code>.');
    expect(html).toContain('role="switch" aria-checked="true"');
    expect(html).toContain('<h4 class="ag-place"><span>local</span><span class="ag-count">1</span></h4>');
    expect(html).toContain('<h4 class="ag-place"><span>box</span><span class="ag-count">1</span></h4>');
    expect(html).toContain('ag-card open');
    expect(html).toContain('ag-fixed');
    expect(html).toContain('<div class="instr-marker">cc</div>');
    expect(html).toContain('<div class="orphan-marker"></div>');
  });

  it('renders values screen with typed filter input, loading hint, options, and pagination', () => {
    const options: SettingsScreenOption[] = Array.from({ length: 9 }, (_, i) => ({
      buttonId: `opt:${i}`,
      label: `model-${i}`,
      detail: `Model ${i} detail`,
      current: i === 1,
    }));
    const screen: SettingsScreen = {
      level: 'values',
      loading: true,
      head: {
        label: 'Model',
        target: 'cc',
        targetKind: 'Claude Code',
        value: 'model-1',
        description: 'Pick a `model`.',
        effect: 'Takes effect next session.',
      },
      typed: { buttonId: 'typed:1', placeholder: 'Type model id' },
      options,
      nav: { page: 2, pageCount: 3, prev: 'nav:prev', next: 'nav:next', back: 'nav:back' },
    };
    const html = renderSettingsScreen(webMsg('m2', screen), baseCtx({ errorNote: 'Oops' }));
    expect(html).toContain('class="set-back"');
    expect(html).toContain('role="alert">Oops</div>');
    expect(html).toContain('class="set-type"');
    expect(html).toContain('class="set-hintbox loading"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('2 / 3');
    expect(html).toContain('data-btn="nav:prev"');
    expect(html).toContain('data-btn="nav:next"');
  });
});
