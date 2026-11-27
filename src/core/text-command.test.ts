import { describe, expect, it } from 'vitest';
import { looksLikeCommand, parseTextCommand } from './text-command.js';

describe('parseTextCommand', () => {
  it('parses name + rest; rest is trimmed and empty for a bare command', () => {
    expect(parseTextCommand('/codex what model are you')).toEqual({ name: 'codex', rest: 'what model are you' });
    expect(parseTextCommand('/codex')).toEqual({ name: 'codex', rest: '' });
    expect(parseTextCommand('  /mcp:server:cmd  args here ')).toEqual({ name: 'mcp:server:cmd', rest: 'args here' });
    expect(parseTextCommand('hello /codex')).toBeNull();
    expect(parseTextCommand('/')).toBeNull();
  });
});

describe('looksLikeCommand', () => {
  it('matches text starting with /name (with args, mcp colon, leading whitespace)', () => {
    expect(looksLikeCommand('/new')).toBe(true);
    expect(looksLikeCommand('/review the PR')).toBe(true);
    expect(looksLikeCommand('/mcp:server:cmd args')).toBe(true);
    expect(looksLikeCommand('  /clear')).toBe(true);
  });

  it('does not match: non-slash start / slash only / path-like still treated cautiously', () => {
    expect(looksLikeCommand('hello /new')).toBe(false);
    expect(looksLikeCommand('/')).toBe(false);
    expect(looksLikeCommand('/ space')).toBe(false);
    expect(looksLikeCommand('please take a look for me')).toBe(false);
  });
});
