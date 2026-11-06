import { describe, expect, it } from 'vitest';
import { SkillIndex, skillBody, skillTerms } from './skill-index.js';

const skills = [
  { name: 'server-ops', description: 'Use when operating or troubleshooting a fleet server, router or NAS — SSH, EasyTier, backups.', category: '运维', body: '# Servers\n\nTeleport grants, systemd units, container deploys.' },
  { name: 'newapi-ops', description: 'Use when operating a new-api LLM gateway — models, channels, pricing.', category: '运维', body: 'Channels and routing.' },
  { name: 'email-reader', description: '需要接收邮件、提取验证码或激活链接时使用', category: '自动化', body: '读取邮箱里的验证码。' },
  { name: 'deploy-check', description: '部署完成后检查服务是否正常时使用', body: '依次检查健康接口、日志和告警。' },
];

describe('skillTerms', () => {
  it('splits Han runs into bigrams and the rest into lowercased words', () => {
    expect(skillTerms('检查部署 EasyTier-mesh')).toEqual(['检查', '查部', '部署', 'easytier', 'mesh']);
  });
});

describe('SkillIndex', () => {
  const index = new SkillIndex(skills);

  it('finds a skill by what it is for, best first', () => {
    expect(index.search('troubleshoot an SSH connection to a server')[0]!.name).toBe('server-ops');
    expect(index.search('LLM gateway pricing')[0]!.name).toBe('newapi-ops');
  });

  it('finds Chinese by shared two-character words, in either order', () => {
    expect(index.search('收验证码')[0]!.name).toBe('email-reader');
    expect(index.search('检查一下刚才的部署')[0]!.name).toBe('deploy-check');
  });

  it('puts a skill named exactly first', () => {
    expect(index.search('newapi ops')[0]!.name).toBe('newapi-ops');
    expect(index.search('server-ops', 1)).toEqual([expect.objectContaining({ name: 'server-ops' })]);
  });

  it('returns nothing for a query that shares no term, and caps the list', () => {
    expect(index.search('quantum chromodynamics')).toEqual([]);
    expect(index.search('')).toEqual([]);
    expect(index.search('Use when', 2)).toHaveLength(2);
  });

  it('drops the tail that only shares a word or two with the query', () => {
    // email-reader is the one; server-ops shares nothing, and nothing else comes close.
    expect(index.search('收验证码').map((h) => h.name)).toEqual(['email-reader']);
  });

  it('weighs the description above a passing mention in a body', () => {
    const two = new SkillIndex([
      { name: 'a-skill', description: 'Use when writing release notes', body: 'x' },
      { name: 'b-skill', description: 'Use when filing taxes', body: 'release notes are mentioned here once' },
    ]);
    expect(two.search('release notes').map((h) => h.name)).toEqual(['a-skill', 'b-skill']);
  });
});

describe('skillBody', () => {
  it('drops the frontmatter', () => {
    expect(skillBody('---\nname: x\ndescription: y\n---\n\n# Body\n')).toBe('\n# Body\n');
  });
});
