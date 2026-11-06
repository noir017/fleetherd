import { describe, expect, it } from 'vitest';
import {
  buildEffortMenu,
  effortAmbiguousText,
  effortChoiceText,
  effortMenuSurface,
  effortNoMatchText,
  effortNoSelectorText,
  effortPickButtonId,
  effortSummaryText,
  matchEfforts,
  parseEffortButtonId,
  type EffortChoiceResult,
  type EffortOption,
} from './effort-menu.js';
import { parseModelButtonId } from './model-menu.js';

/**
 * The level lists are the real ones, probed 2026-09-23 over ACP. They differ per harness and per
 * model, which is most of what this file is about: the menu cannot assume `default` exists (codex
 * has none), that `max` is the top (codex adds `ultra`), or that `minimal` is not a level
 * (opencode on muse-spark has it).
 */
const opt = (value: string): EffortOption => ({ value, name: value.charAt(0).toUpperCase() + value.slice(1) });
const CLAUDE = ['default', 'low', 'medium', 'high', 'xhigh', 'max'].map(opt);
const CODEX = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(opt);
const OPENCODE_MUSE = ['minimal', 'low', 'medium', 'high', 'xhigh', 'default'].map(opt);

describe('button ids', () => {
  it('round-trips a pick', () => {
    expect(parseEffortButtonId(effortPickButtonId('ab12cd34', 3))).toEqual({ reqId: 'ab12cd34', index: 3 });
  });

  it('never claims another menu’s id, and no other menu claims its', () => {
    // The daemon dispatches on prefix; a collision would send a model pick to the effort handler.
    expect(parseEffortButtonId('mdl:ab12cd34:3')).toBeNull();
    expect(parseEffortButtonId('ask:ab12cd34:3')).toBeNull();
    expect(parseModelButtonId(effortPickButtonId('ab12cd34', 3))).toBeNull();
  });

  it('rejects a malformed index', () => {
    expect(parseEffortButtonId('eff:ab12cd34:x')).toBeNull();
    expect(parseEffortButtonId('eff::3')).toBeNull();
  });
});

describe('effortMenuSurface', () => {
  const full = { buttons: true, editButtons: true, menuPageSize: 12 };

  it('is a menu where buttons can be posted AND edited', () => {
    expect(effortMenuSurface(full, CLAUDE.length)).toBe('menu');
  });

  it('is text where buttons can never be retired (LINE, QQ) or do not exist', () => {
    expect(effortMenuSurface({ ...full, editButtons: false }, CLAUDE.length)).toBe('text');
    expect(effortMenuSurface({ ...full, buttons: false }, CLAUDE.length)).toBe('text');
    expect(effortMenuSurface({}, CLAUDE.length)).toBe('text');
  });

  it('is text for a single level — a tap that changes nothing is not a menu', () => {
    expect(effortMenuSurface(full, 1)).toBe('text');
  });

  it('fits claude’s six levels on a platform that declares no page size (Lark)', () => {
    // Lark leaves menuPageSize undeclared, i.e. core's conservative six — exactly claude's list.
    expect(effortMenuSurface({ buttons: true, editButtons: true }, 6)).toBe('menu');
  });

  it('falls back to text rather than drawing past one page, since it has no pages', () => {
    expect(effortMenuSurface({ buttons: true, editButtons: true }, 7)).toBe('text');
    expect(effortMenuSurface(full, 7)).toBe('menu');
  });
});

describe('buildEffortMenu', () => {
  it('draws one button per level, the current one marked, labelled by value', () => {
    const view = buildEffortMenu({ reqId: 'r1', options: CLAUDE, current: 'high' });
    expect(view.buttons.map((b) => b.label)).toEqual(['default', 'low', 'medium', '● high', 'xhigh', 'max']);
    expect(view.buttons.map((b) => b.id)).toEqual(CLAUDE.map((_, i) => `eff:r1:${i}`));
    expect(view.text).toContain('Effort: high');
  });

  it('marks `default` when that is where the session is — it is a choice, not an absence', () => {
    const view = buildEffortMenu({ reqId: 'r1', options: OPENCODE_MUSE, current: 'default' });
    expect(view.buttons.at(-1)!.label).toBe('● default');
  });

  it('marks nothing and says so when the current level is unknown', () => {
    const view = buildEffortMenu({ reqId: 'r1', options: CODEX });
    expect(view.buttons.some((b) => b.label.startsWith('●'))).toBe(false);
    expect(view.text).toContain('unknown');
  });
});

describe('matchEfforts', () => {
  it('takes an exact value, case-insensitively', () => {
    expect(matchEfforts(CLAUDE, 'HIGH')).toEqual({ kind: 'one', option: opt('high') });
  });

  it('prefers the exact `high` over the `xhigh` that contains it', () => {
    // The reason matching is by prefix and not substring.
    expect(matchEfforts(CLAUDE, 'high')).toEqual({ kind: 'one', option: opt('high') });
  });

  it('resolves a unique prefix', () => {
    expect(matchEfforts(CLAUDE, 'x')).toEqual({ kind: 'one', option: opt('xhigh') });
    expect(matchEfforts(CLAUDE, 'med')).toEqual({ kind: 'one', option: opt('medium') });
    expect(matchEfforts(CODEX, 'u')).toEqual({ kind: 'one', option: opt('ultra') });
  });

  it('never guesses between two ends of the scale', () => {
    const m = matchEfforts(CLAUDE, 'm');
    expect(m.kind).toBe('many');
    expect(m.kind === 'many' && m.matches.map((o) => o.value)).toEqual(['medium', 'max']);
  });

  it('matches nothing a model does not offer', () => {
    // `default` is claude's and opencode's, not codex's.
    expect(matchEfforts(CODEX, 'default')).toEqual({ kind: 'none' });
    expect(matchEfforts(CLAUDE, 'igh')).toEqual({ kind: 'none' });
  });
});

describe('the text answers', () => {
  it('the summary names the current level and every choice', () => {
    const text = effortSummaryText({ current: 'high', options: CODEX });
    expect(text).toContain('Effort: high');
    for (const o of CODEX) expect(text).toContain(`\`${o.value}\``);
  });

  it('no match lists the choices, since the list is short enough to', () => {
    expect(effortNoMatchText('turbo', CLAUDE)).toContain('`xhigh`');
    expect(effortAmbiguousText('m', [opt('medium'), opt('max')])).toContain('`medium` · `max`');
  });

  it('explains a missing list per harness, naming the model', () => {
    const codex = effortNoSelectorText('codex', 'gpt-6-luna');
    expect(codex).toContain('`gpt-6-luna`');
    // The two ways out that were verified: a newer codex-cli, or its config file meanwhile.
    expect(codex).toContain('newer codex-cli');
    expect(codex).toContain('model_reasoning_effort');
    expect(effortNoSelectorText('opencode', 'opencode/mimo-v2.6-flash-free')).toContain('reasoning variants');
    expect(effortNoSelectorText('agy', 'GPT-OSS 120B (Medium)')).toContain('only for its Gemini models');
    expect(effortNoSelectorText('claude', undefined)).toContain('the current model');
  });

  it('gives every choice outcome its own sentence', () => {
    const outcomes: EffortChoiceResult[] = [
      { kind: 'applied', effort: 'xhigh' },
      { kind: 'unavailable' },
      { kind: 'missing', value: 'max' },
      { kind: 'rebound', agent: 'claude' },
      { kind: 'gone' },
      { kind: 'failed', reason: 'Invalid params' },
    ];
    const texts = outcomes.map(effortChoiceText);
    expect(new Set(texts).size).toBe(outcomes.length);
    expect(texts[0]).toContain('`xhigh`');
    expect(texts[2]).toContain('`max`');
    expect(texts[3]).toContain('claude');
    expect(texts[5]).toContain('Invalid params');
  });
});
