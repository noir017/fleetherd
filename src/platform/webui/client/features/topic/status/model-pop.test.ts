import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '../../../i18n/index.js';
import {
  findSessionOption,
  matchesFilter,
  renderModelOptionsHtml,
  renderSessionOptionsHtml,
  shouldShowFilter,
} from './model-pop.js';
import type { ModelListResponse, OptionListResponse } from './types.js';

describe('features/topic/status/model-pop', () => {
  beforeEach(() => {
    setLocale('en');
  });

  it('matches filter queries case-insensitively with whitespace trimming', () => {
    expect(matchesFilter('', 'claude-opus')).toBe(true);
    expect(matchesFilter('   ', 'claude-opus')).toBe(true);
    expect(matchesFilter(' OPUS ', 'claude-opus-4')).toBe(true);
    expect(matchesFilter('sonnet', 'claude-opus-4')).toBe(false);
  });

  it('shows the filter input only when more than 8 options are available', () => {
    const makeModels = (count: number): ModelListResponse => ({
      ok: true,
      options: Array.from({ length: count }, (_, i) => ({ value: `m-${i}` })),
    });
    expect(shouldShowFilter(null, null)).toBe(false);
    expect(shouldShowFilter({ ok: false }, null)).toBe(false);
    expect(shouldShowFilter(makeModels(8), null)).toBe(false);
    expect(shouldShowFilter(makeModels(9), null)).toBe(true);

    const optResp: OptionListResponse = {
      ok: true,
      options: [
        {
          id: 'acct',
          name: 'Account',
          options: Array.from({ length: 9 }, (_, i) => ({ value: `a${i}`, name: `Acct ${i}` })),
        },
      ],
    };
    expect(shouldShowFilter(optResp, 'acct')).toBe(true);
    expect(shouldShowFilter(optResp, 'missing')).toBe(false);
    expect(findSessionOption(optResp, 'acct')?.name).toBe('Account');
  });

  it('renders model options with active check, distinct name, and default badge', () => {
    const html = renderModelOptionsHtml(
      {
        ok: true,
        current: 'opus-4',
        configured: 'sonnet-4',
        options: [
          { value: 'opus-4', name: 'Opus 4' },
          { value: 'sonnet-4', name: 'sonnet-4' },
        ],
      },
      '<svg/>',
    );
    expect(html).toContain('class="mp-opt on"');
    expect(html).toContain('aria-selected="true" data-v="opus-4"');
    expect(html).toContain('<span class="mp-n">Opus 4</span>');
    expect(html).toContain('<svg/>');
    expect(html).toContain('data-v="sonnet-4"');
    expect(html).toContain('class="mp-tag"');
    expect(html).not.toContain('<span class="mp-n">sonnet-4</span>');
  });

  it('renders custom session options for missing, fixed, and selectable states', () => {
    expect(renderSessionOptionsHtml(null, '<svg/>')).toContain('no longer offers this setting');

    const fixedHtml = renderSessionOptionsHtml(
      {
        id: 'acct',
        name: 'Account',
        current: 'work',
        options: [{ value: 'work', name: 'Work', description: 'Quota ok' }],
      },
      '<svg/>',
    );
    expect(fixedHtml).toContain('Fixed for this conversation');
    expect(fixedHtml).toContain(' disabled>');
    expect(fixedHtml).toContain('Quota ok');

    const multiHtml = renderSessionOptionsHtml(
      {
        id: 'acct',
        name: 'Account',
        current: 'personal',
        options: [
          { value: 'work', name: 'Work' },
          { value: 'personal', name: 'Personal', description: '80% left' },
        ],
      },
      '<svg/>',
    );
    expect(multiHtml).not.toContain('Fixed for this conversation');
    expect(multiHtml).not.toContain(' disabled>');
    expect(multiHtml).toContain('class="mp-opt on" role="option" aria-selected="true" data-v="personal"');
  });
});
