import { describe, expect, it } from 'vitest';

import { harnessSources } from './harness/index.js';
import {
  IMPORT_TEXT_EXTENSIONS,
  agyReferences,
  agyRuleNote,
  claudeReferences,
  codebuddyReferences,
  globBase,
  globRegex,
  opencodeInstructions,
  resolveAgyReference,
  resolveClaudeReference,
  scannableText,
} from './instruction-imports.js';

const at = (real: string): { path: string; real: string } => ({ path: real, real });

describe('claudeReferences', () => {
  it('finds a reference on its own line, in a list, mid-sentence, and with an escaped space', () => {
    const text = ['@~/.claude/rules.md', '- @./local.md', 'Also read @notes/team.md please.', '@my\\ notes.md'].join('\n');
    expect(claudeReferences(text)).toEqual(['~/.claude/rules.md', './local.md', 'notes/team.md', 'my notes.md']);
  });

  it('needs whitespace or a line start before the @, so an address is not a reference', () => {
    expect(claudeReferences('mail me at someone@example.com, or (@x.md)')).toEqual([]);
  });

  it('cuts a #fragment, keeps one copy of a repeat, and refuses what Claude Code refuses — a quoted path among them', () => {
    const text = '@a.md#section @a.md @/ @@scoped @#tag @*glob @/etc/abs.md @_under.md @"quoted.md"';
    expect(claudeReferences(text)).toEqual(['a.md', '/etc/abs.md', '_under.md']);
  });

  it('skips fenced code, code spans and HTML comments, but not the text around them', () => {
    const text = [
      'before @one.md',
      '```',
      '@fenced.md',
      '```',
      '~~~md',
      '@tilde.md',
      '~~~',
      'inline `@span.md` and ``@double.md`` here, then @two.md',
      '<!-- @hidden.md',
      'still hidden @hidden2.md -->',
      'after @three.md',
    ].join('\n');
    expect(claudeReferences(text)).toEqual(['one.md', 'two.md', 'three.md']);
  });

  it('keeps reading after a fence that a longer one closes, and treats an unclosed fence as code to the end', () => {
    expect(claudeReferences('````\n```\n@in.md\n````\n@out.md')).toEqual(['out.md']);
    expect(claudeReferences('@before.md\n```\n@never.md')).toEqual(['before.md']);
  });

  it('reads CRLF text the same as LF', () => {
    expect(claudeReferences('@a.md\r\n```\r\n@b.md\r\n```\r\n@c.md\r\n')).toEqual(['a.md', 'c.md']);
  });

  it('leaves an unmatched backtick as text', () => {
    expect(scannableText('a ` @x.md')).toContain('@x.md');
  });
});

describe('resolveClaudeReference', () => {
  it('resolves ~/ against the home, a relative path against the real file’s directory, and keeps an absolute one', () => {
    const copy = at('/h/.fleetherd/instructions/claude.md');
    expect(resolveClaudeReference('~/.claude/r.md', copy, '/h')).toBe('/h/.claude/r.md');
    expect(resolveClaudeReference('local.md', copy, '/h')).toBe('/h/.fleetherd/instructions/local.md');
    expect(resolveClaudeReference('./a/../b.md', at('/d/x.md'), '/h')).toBe('/d/b.md');
    expect(resolveClaudeReference('/srv/x.md', at('/d/x.md'), '/h')).toBe('/srv/x.md');
  });

  it('refuses a non-text extension and a device or process file, as Claude Code does', () => {
    expect(resolveClaudeReference('logo.png', at('/d/x.md'), '/h')).toBeUndefined();
    expect(resolveClaudeReference('/dev/stdin', at('/d/x.md'), '/h')).toBeUndefined();
    expect(resolveClaudeReference('/proc/self/environ', at('/d/x.md'), '/h')).toBeUndefined();
    // No extension at all is read, like a Makefile or a dotfile.
    expect(resolveClaudeReference('NOTES', at('/d/x.md'), '/h')).toBe('/d/NOTES');
    expect(IMPORT_TEXT_EXTENSIONS.has('.md')).toBe(true);
  });
});

describe('codebuddyReferences', () => {
  it('reads @path like Claude Code but ends a path at the first whitespace, with no escape', () => {
    expect(codebuddyReferences('@a.md and @my\\ notes.md\n`@span.md`\n```\n@code.md\n```\nx@mail.com')).toEqual(['a.md', 'my\\']);
  });
});

describe('agy includes', () => {
  it('reads @[label](path) anywhere — inside code too — with the path as written', () => {
    const text = 'See @[home](~/refs/home.md).\n```\n@[code](in-code.md)\n```\n`@[span](/abs/s p.md)` @plain.md [x](y.md)';
    expect(agyReferences(text)).toEqual(['~/refs/home.md', 'in-code.md', '/abs/s p.md']);
  });

  it('resolves a relative include in the two standalone config files against ~/.gemini, and others against the file', () => {
    expect(resolveAgyReference('r.md', { path: '/h/.gemini/config/AGENTS.md', real: '/h/.fleetherd/instructions/agy.md' }, '/h')).toBe('/h/.gemini/r.md');
    expect(resolveAgyReference('r.md', at('/h/.gemini/config/GEMINI.md'), '/h')).toBe('/h/.gemini/r.md');
    expect(resolveAgyReference('r.md', at('/h/.gemini/config/rules/a.md'), '/h')).toBe('/h/.gemini/config/rules/r.md');
    expect(resolveAgyReference('r.md', at('/h/.gemini/GEMINI.md'), '/h')).toBe('/h/.gemini/r.md');
    expect(resolveAgyReference('~/x.md', at('/h/.gemini/config/AGENTS.md'), '/h')).toBe('/h/x.md');
  });

  it('says which rules are not read at start', () => {
    expect(agyRuleNote('---\ntrigger: always_on\n---\nbody')).toBeUndefined();
    expect(agyRuleNote('---\ntrigger: "always_on"\n---\n')).toBeUndefined();
    expect(agyRuleNote('---\ntrigger: model_decision\n---\n')).toMatch(/always_on/);
    expect(agyRuleNote('no frontmatter')).toMatch(/always_on/);
  });
});

describe('opencode instructions', () => {
  it('reads the array out of JSONC, comments and trailing commas included, and strings left alone', () => {
    const text = '{\n  // mine\n  "instructions": ["~/rules/a.md", /* x */ "docs/*.md", "https://e.com/i.md", "a//b.md",],\n}';
    expect(opencodeInstructions(text)).toEqual(['~/rules/a.md', 'docs/*.md', 'https://e.com/i.md', 'a//b.md']);
    expect(opencodeInstructions('not json')).toEqual([]);
    expect(opencodeInstructions('{"instructions": "one"}')).toEqual([]);
  });

  it('matches a glob the way the expansion uses it', () => {
    expect(globBase('/h/rules/**/*.md')).toBe('/h/rules');
    const re = globRegex('/h/rules/**/*.md');
    expect(re.test('/h/rules/a.md')).toBe(true);
    expect(re.test('/h/rules/x/y/b.md')).toBe(true);
    expect(re.test('/h/rules/a.txt')).toBe(false);
    expect(globRegex('/h/{a,b}.md').test('/h/b.md')).toBe(true);
    expect(globRegex('/h/?.md').test('/h/ab.md')).toBe(false);
  });
});

describe('harnessSources', () => {
  it('dispatches each harness to what it reads, under the home given', () => {
    const claude = harnessSources({ id: 'cc', harness: 'claude' }, '/h')!;
    expect(claude).toMatchObject({ delivered: '/h/.claude/CLAUDE.md', ruleDirs: ['/h/.claude/rules'], files: [] });
    expect(claude.syntax?.hops).toBe(4);
    const cb = harnessSources({ id: 'cb', harness: 'custom', command: '/usr/bin/codebuddy' }, '/h')!;
    expect(cb).toMatchObject({ delivered: '/h/.codebuddy/CODEBUDDY.md', ruleDirs: ['/h/.codebuddy/rules'] });
    expect(cb.syntax?.hops).toBe(4);
    const agy = harnessSources({ id: 'ag', harness: 'agy' }, '/h')!;
    expect(agy.files.map((f) => f.path)).toEqual(['/h/.gemini/AGENTS.md', '/h/.gemini/GEMINI.md', '/h/.gemini/config/GEMINI.md']);
    expect(agy.ruleDirs).toEqual(['/h/.gemini/config/rules']);
    expect(agy.syntax?.hops).toBe(1);
    const oc = harnessSources({ id: 'oc', harness: 'opencode' }, '/h')!;
    expect(oc.syntax).toBeUndefined();
    expect(oc.lists?.configs).toEqual(['/h/.config/opencode/opencode.json', '/h/.config/opencode/opencode.jsonc']);
    const cx = harnessSources({ id: 'cx', harness: 'codex' }, '/h')!;
    expect(cx.syntax).toBeUndefined();
    expect(cx.files).toEqual([{ path: '/h/.codex/AGENTS.override.md', note: expect.stringContaining('instead of AGENTS.md') }]);
  });

  it('knows nothing for atomcode, gemini, dsh or another command', () => {
    expect(harnessSources({ id: 'ac', harness: 'custom', command: 'atomcode' }, '/h')).toBeUndefined();
    expect(harnessSources({ id: 'x', harness: 'custom', command: 'other' }, '/h')).toBeUndefined();
    for (const harness of ['gemini', 'dsh'] as const) expect(harnessSources({ id: 'x', harness }, '/h')).toBeUndefined();
  });

  it('follows a configured instruction file, and knows no own files for a harness it cannot name', () => {
    const over = harnessSources({ id: 'cc', harness: 'claude', instructions: { file: '~/.claude/MINE.md' } }, '/h')!;
    expect(over.delivered).toBe('/h/.claude/MINE.md');
    // The summary names the file this agent really reads, not the harness's default one.
    expect(over.summary).toBe('`@` references in `~/.claude/MINE.md`, and `~/.claude/rules`');
    const cb = harnessSources(
      { id: 'cb', harness: 'custom', command: 'codebuddy', instructions: { file: '~/.codebuddy/MINE.md' } },
      '/h'
    )!;
    expect(cb.summary).toBe('`@` references in `~/.codebuddy/MINE.md`, and `~/.codebuddy/rules`');
    expect(
      harnessSources(
        { id: 'mh', harness: 'custom', command: 'my-harness', instructions: { file: '~/.my-harness/AGENTS.md' } },
        '/h'
      )
    ).toBeUndefined();
  });
});
