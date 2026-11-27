import { describe, expect, it } from 'vitest';
import { formatLaneTitle, subjectOf } from './lane-title.js';

describe('formatLaneTitle', () => {
  it('prefixes the agent tag and collapses whitespace', () => {
    expect(formatLaneTitle('cc', '  fix   auth\nbug  ')).toBe('[cc] fix auth bug');
  });

  it('replaces one or more leading bracketed tags instead of stacking them', () => {
    expect(formatLaneTitle('codex', '[cc] fix auth')).toBe('[codex] fix auth');
    expect(formatLaneTitle('codex', '[a] [b] fix auth')).toBe('[codex] fix auth');
  });

  it('keeps the original text when input is only brackets', () => {
    expect(formatLaneTitle('cc', '[only]')).toBe('[cc] [only]');
  });

  it('stops stripping on an unclosed leading bracket', () => {
    expect(formatLaneTitle('cc', '[unclosed title')).toBe('[cc] [unclosed title');
  });
});

describe('subjectOf', () => {
  it('strips the leading lane tag and any remaining square brackets', () => {
    expect(subjectOf('[cc] fix [WIP] auth')).toBe('fix WIP auth');
  });

  it('is the inverse of formatLaneTitle for plain subjects', () => {
    expect(subjectOf(formatLaneTitle('cc', 'refactor daemon'))).toBe('refactor daemon');
  });
});
