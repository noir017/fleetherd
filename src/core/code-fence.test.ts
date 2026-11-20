import { describe, expect, it } from 'vitest';
import { closeFence, continueFence, fenceAfter, type OpenFence } from './code-fence.js';

const TICKS: OpenFence = { marker: '```', info: '' };

describe('fenceAfter', () => {
  it('is undefined when every block is closed, and names the one left open', () => {
    expect(fenceAfter('a\n```\nx\n```\nb')).toBeUndefined();
    expect(fenceAfter('a\n```sh\nx\n')).toEqual({ marker: '```', info: 'sh' });
  });

  it('closes only with the same character, at least as many, and nothing else on the line', () => {
    const open = { marker: '````', info: 'md' };
    expect(fenceAfter('````md\n```\n~~~~\n```` x')).toEqual(open);
    expect(fenceAfter('````md\n`````')).toBeUndefined();
    expect(fenceAfter('~~~\n```\n~~~')).toBeUndefined();
  });

  it('reads an indented fence, as the command under a list item is written', () => {
    expect(fenceAfter('1. pull:\n\n  ```\n  podman pull x\n')).toEqual(TICKS);
    expect(fenceAfter('1. pull:\n\n  ```\n  podman pull x\n  ```')).toBeUndefined();
  });

  it('does not take a backtick line with a backtick after it for a fence', () => {
    expect(fenceAfter('```a``` is inline')).toBeUndefined();
    expect(fenceAfter('~~~ a`b')).toEqual({ marker: '~~~', info: 'a`b' });
  });

  it('starts inside the fence it is given', () => {
    expect(fenceAfter('more code\n', TICKS)).toEqual(TICKS);
    expect(fenceAfter('```\n\ntext', TICKS)).toBeUndefined();
    expect(fenceAfter('```\ntext\n```js\n', TICKS)).toEqual({ marker: '```', info: 'js' });
  });
});

describe('closeFence', () => {
  it('appends the opener on a line of its own when a block is left open', () => {
    expect(closeFence('run:\n```sh\nls\n')).toBe('run:\n```sh\nls\n```');
    expect(closeFence('run:\n~~~~\nls')).toBe('run:\n~~~~\nls\n~~~~');
  });

  it('leaves closed text, and empty text, as they are', () => {
    expect(closeFence('a\n```\nx\n```')).toBe('a\n```\nx\n```');
    expect(closeFence('')).toBe('');
  });
});

describe('continueFence', () => {
  it('passes the text through when nothing was left open', () => {
    expect(continueFence('```\nx', undefined, false)).toBe('```\nx');
  });

  it('drops the closing line the text starts with, and the blank lines around it', () => {
    // The 2026-11-20 reply: the step landed just before the last block's closing fence.
    const after = '```\n\n[build #4](https://example.com) passed.';
    expect(continueFence(after, TICKS, true)).toBe('[build #4](https://example.com) passed.');
    expect(continueFence('\n  ```\ntext', TICKS, true)).toBe('text');
  });

  it('reopens the block, with its info string, when the text goes on inside it', () => {
    const open = { marker: '```', info: 'yaml' };
    expect(continueFence('  - b\n```\ndone', open, true)).toBe('```yaml\n  - b\n```\ndone');
  });

  it('shows nothing while the first line could still be the closer, and nothing for a closer alone', () => {
    expect(continueFence('', TICKS, false)).toBe('');
    expect(continueFence('\n\n', TICKS, false)).toBe('');
    expect(continueFence('``', TICKS, false)).toBe('');
    expect(continueFence('```', TICKS, false)).toBe('');
    expect(continueFence('```\n', TICKS, false)).toBe('');
    expect(continueFence('```\n\n  ', TICKS, false)).toBe('');
    expect(continueFence('```', TICKS, true)).toBe('');
  });

  it('decides on the first whole line, and only grows after that', () => {
    const steps = ['`', '``', '```', '```\n', '```\n\n', '```\n\nDo', '```\n\nDone.'];
    const shown = steps.map((s) => continueFence(s, TICKS, false));
    for (let i = 1; i < shown.length; i++) expect(shown[i]!.startsWith(shown[i - 1]!)).toBe(true);
    expect(shown.at(-1)).toBe('Done.');

    const code = ['`', '`x', '`x`\n', '`x`\ny'].map((s) => continueFence(s, TICKS, false));
    expect(code).toEqual(['', '```\n`x', '```\n`x`\n', '```\n`x`\ny']);
  });

  it('takes an unfinished last line as it stands once the text is final', () => {
    expect(continueFence('``', TICKS, true)).toBe('```\n``');
  });

  it('is not closed by a shorter run or a run of the other character', () => {
    const open = { marker: '````', info: '' };
    expect(continueFence('```\nx', open, true)).toBe('````\n```\nx');
    expect(continueFence('~~~~\nx', open, true)).toBe('````\n~~~~\nx');
  });
});
