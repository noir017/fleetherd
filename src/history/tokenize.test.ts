import { describe, expect, it } from 'vitest';
import { excerpt, ftsQuery, hanTerms, indexText, queryTerms } from './tokenize.js';

describe('indexText', () => {
  it('splits a run of Han characters into overlapping two-character words', () => {
    expect(indexText('跨会话查询')).toBe('跨会 会话 话查 查询');
  });

  it('leaves Latin words and digits for unicode61', () => {
    expect(indexText('git status 2>&1')).toBe('git status 2>&1');
  });

  it('separates Han bigrams from adjacent Latin words', () => {
    expect(indexText('用git提交')).toBe('用 git 提交');
  });

  it('indexes a lone Han character as itself', () => {
    expect(indexText('查')).toBe('查');
  });

  it('handles several Han runs around punctuation', () => {
    expect(indexText('查一下：跨会话')).toBe('查一 一下 ： 跨会 会话');
  });
});

describe('hanTerms', () => {
  it('yields one term for two characters', () => {
    expect(hanTerms('查询')).toEqual(['查询']);
  });

  it('yields the overlapping bigrams of a longer run', () => {
    expect(hanTerms('跨会话查询')).toEqual(['跨会', '会话', '话查', '查询']);
  });

  it('yields the character itself for a one-character run', () => {
    expect(hanTerms('查')).toEqual(['查']);
  });
});

describe('queryTerms', () => {
  it('splits a Chinese query the way the index was built', () => {
    expect(queryTerms('跨会话查询')).toEqual({ fts: ['跨会', '会话', '话查', '查询'], single: [] });
  });

  it('finds a two-character Chinese word', () => {
    expect(queryTerms('查询')).toEqual({ fts: ['查询'], single: [] });
  });

  it('reports a single character for LIKE', () => {
    expect(queryTerms('查')).toEqual({ fts: [], single: ['查'] });
  });

  it('keeps English words whole and case as typed', () => {
    expect(queryTerms('git status')).toEqual({ fts: ['git', 'status'], single: [] });
  });

  it('mixes English and Chinese', () => {
    expect(queryTerms('git 提交')).toEqual({ fts: ['提交', 'git'], single: [] });
  });

  it('drops punctuation and duplicate terms', () => {
    expect(queryTerms('查询，查询！')).toEqual({ fts: ['查询'], single: [] });
  });

  it('has nothing for a query of punctuation alone', () => {
    expect(queryTerms('，。！')).toEqual({ fts: [], single: [] });
  });
});

describe('ftsQuery', () => {
  it('quotes and ANDs every term', () => {
    expect(ftsQuery(['跨会', '会话'])).toBe('"跨会" AND "会话"');
  });

  it('escapes a quote inside a term', () => {
    expect(ftsQuery(['a"b'])).toBe('"a""b"');
  });

  it('is undefined with no terms', () => {
    expect(ftsQuery([])).toBeUndefined();
  });
});

describe('excerpt', () => {
  it('returns short text whole', () => {
    expect(excerpt('a short line', ['short'])).toBe('a short line');
  });

  it('centres a hit in a long text', () => {
    const text = `${'x'.repeat(200)} needle ${'y'.repeat(200)}`;
    const out = excerpt(text, ['needle'], 60);
    expect(out).toContain('needle');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back to the head when no term is literally present', () => {
    const out = excerpt(`${'x'.repeat(200)}`, ['nothing'], 50);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(51);
  });
});
