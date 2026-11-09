import { describe, expect, it } from 'vitest';
import { quotable, rankFiles, relatedSkillNames, reviewQuery } from './review-related.js';

const skills = [
  { name: 'antigravity-config', description: '配置或维护 Antigravity CLI (agy) 的网关与额度' },
  { name: 'sbox', description: '通过 sbox 命令行操作 Simular Box 云端桌面', category: '自动化' },
  { name: 'deploy-check', description: '部署前检查' },
];

describe('reviewQuery', () => {
  it('is the title and what the person wrote, never the agent', () => {
    const q = reviewQuery('AGY 压缩', [
      { role: 'user', text: '256k 怎么解决' },
      { role: 'agent', text: '部署前检查的长篇回答' },
    ]);
    expect(q).toBe('AGY 压缩\n256k 怎么解决');
  });

  it('leaves out the agent a library title leads with', () => {
    expect(reviewQuery('[cbc@uniagent] AGY 压缩', [])).toBe('AGY 压缩');
  });
});

describe('relatedSkillNames', () => {
  it('finds skills by name, description or category, leaving out the excluded', () => {
    expect(relatedSkillNames('agy 上下文 256k', skills, new Set())).toEqual(['antigravity-config']);
    expect(relatedSkillNames('Simular Box 截屏', skills, new Set())).toEqual(['sbox']);
    expect(relatedSkillNames('Simular Box 截屏', skills, new Set(['sbox']))).toEqual([]);
  });

  it('answers nothing for a conversation no description speaks to', () => {
    expect(relatedSkillNames('今天天气', skills, new Set())).toEqual([]);
  });
});

describe('rankFiles', () => {
  it('puts the file about the question first and drops the ones that share nothing', () => {
    const files = [
      { key: 'antigravity-config/references/account.md', content: 'OAuth 凭据与切号' },
      { key: 'antigravity-config/references/context-budget.md', content: 'agy 自动压缩预算 256k' },
    ];
    expect(rankFiles('agy 256k 压缩', files)).toEqual(['antigravity-config/references/context-budget.md']);
    expect(rankFiles('anything', [])).toEqual([]);
  });
});

describe('quotable', () => {
  it('quotes prose under references/ only', () => {
    expect(quotable('references/a.md')).toBe(true);
    expect(quotable('references/notes.txt')).toBe(true);
    expect(quotable('references/servers.tsv')).toBe(false);
    expect(quotable('scripts/run.sh')).toBe(false);
    expect(quotable('templates/x.md')).toBe(false);
  });
});
