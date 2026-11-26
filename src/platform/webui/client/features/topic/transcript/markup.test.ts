import { describe, expect, it } from 'vitest';
import {
  allToggle,
  clock,
  failedActions,
  foldLines,
  labelWidth,
  lineOpen,
  navLabel,
  reactionMark,
  renderMenu,
  renderMsgMarkup,
  stuck,
  turnChangeRow,
  workdirPicker,
  workdirPickerHtml,
} from './markup.js';
import type { TranscriptIcons, TranscriptMessage } from './types.js';

const ICONS: TranscriptIcons = {
  icon: {
    chevronLeft: '<L>',
    chevronRight: '<R>',
    diff: '<D>',
    folder: '<F>',
    home: '<H>',
    arrowUp: '<U>',
    check: '<C>',
    search: '<S>',
  },
  mark: { '●': '<DOT>', '☑': '<CHK>' },
  reaction: { '👀': '<EYE>' },
};

describe('markup helpers', () => {
  it('computes CJK-aware labelWidth and formats navLabel / reactionMark', () => {
    expect(labelWidth('abc')).toBe(3);
    expect(labelWidth('中文a')).toBe(5);
    expect(navLabel('◀ Back', ICONS)).toBe('<L> Back');
    expect(navLabel('Next ▶', ICONS)).toBe('Next <R>');
    expect(navLabel('Plain', ICONS)).toBe('Plain');
    expect(reactionMark('👀️', ICONS)).toBe('<EYE>');
    expect(reactionMark('🎉', ICONS)).toBe('🎉');
    expect(clock(new Date(2026, 0, 1, 9, 5).getTime())).toBe('09:05');
  });

  it('handles tool line folding and allToggle', () => {
    const opened = { '1:t1': { all: false, lines: { '1': true } } };
    expect(lineOpen(undefined, 0)).toBe(false);
    expect(lineOpen(opened['1:t1'], 0)).toBe(false);
    expect(lineOpen(opened['1:t1'], 1)).toBe(true);
    const folded = foldLines('1:t1', '<div class="tl">a</div><div class="tl">b</div>', opened);
    expect(folded).toBe('<div class="tl" data-i="0">a</div><div class="tl open" data-i="1">b</div>');
    expect(allToggle('1:t1', opened)).toContain('data-tl-all="1:t1"');
  });

  it('renders menu grid with nav separation and column width cap', () => {
    const msg: TranscriptMessage = {
      id: 'm1',
      html: '',
      at: 0,
      buttons: [
        { id: 'b1', label: '● Current' },
        { id: 'b2', label: 'a'.repeat(60) },
        { id: 'b3', label: '◀ Back' },
      ],
    };
    const html = renderMenu(msg, ICONS);
    expect(html).toContain('--cw:40ch;--mk:1');
    expect(html).toContain('class="on"><span class="mk"><DOT></span> Current');
    expect(html).toContain('<div class="nav"><button type="button" data-msg="m1" data-btn="b3"><L> Back</button></div>');
  });

  it('renders turnChangeRow only when git window is available', () => {
    const msg: TranscriptMessage = {
      id: 'm1',
      html: '<p>done</p>',
      at: 0,
      turnChanges: { turn: 3, files: 2, additions: 10, deletions: 4, truncated: true },
    };
    expect(turnChangeRow(msg, ICONS, false)).toBe('');
    const html = turnChangeRow(msg, ICONS, true);
    expect(html).toContain('data-turns="3"');
    expect(html).toContain('+10');
    expect(html).toContain('-4+');
  });

  it('renders workdirPicker with filter when >= 6 entries', () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({
      name: `dir-${i}`,
      path: `/ws/dir-${i}`,
      enterId: `e${i}`,
      pickId: `p${i}`,
      current: i === 0,
    }));
    const msg: TranscriptMessage = {
      id: 'm2',
      html: '',
      at: 0,
      workdir: {
        agentId: 'claude',
        host: 'devbox',
        browsing: '/ws',
        breadcrumbs: [
          { name: '/', path: '/', buttonId: 'c0' },
          { name: 'ws', path: '/ws', buttonId: 'c1' },
        ],
        parent: { path: '/', buttonId: 'up' },
        home: { path: '/ws', buttonId: 'home' },
        selectCurrent: { path: '/ws', buttonId: 'cur', current: true, root: true },
        entries,
        truncated: 2,
      },
    };
    const html = workdirPicker(msg, ICONS);
    expect(html).toContain('class="wd-picker"');
    expect(html).not.toContain('wd-cur');
    expect(html).not.toContain('wd-pick-cur');
    expect(html).toContain('class="wd-choose wd-pick-bar on" data-msg="m2" data-btn="cur"');
    expect(html).toContain('class="wd-q"');
    expect(html).toContain('class="wd-more"');
    expect(html).toContain('devbox');

    const launchOpen = workdirPickerHtml(
      { ...msg.workdir!, selectCurrent: { path: '/home/me/projects', buttonId: 'wdr:0', current: false, root: false } },
      ICONS,
      { kind: 'launch' },
    );
    expect(launchOpen).not.toContain('wd-cur');
    expect(launchOpen).toContain('class="wd-choose wd-pick-bar" data-wd-pick="/home/me/projects"');
    expect(launchOpen).toContain('data-launch-unfold="workdir" hidden');

    const launchFolded = workdirPickerHtml(
      { ...msg.workdir!, selectCurrent: { path: '/home/me/projects', buttonId: 'wdr:0', current: true, root: false } },
      ICONS,
      { kind: 'launch', folded: true, selectedPath: '/home/me/projects' },
    );
    expect(launchFolded).toContain('class="wd-picker folded"');
    expect(launchFolded).toContain('class="wd-body" hidden');
    expect(launchFolded).toContain('class="wd-hint" hidden');
    expect(launchFolded).toContain('<div class="wd-selected"><code class="wd-path" title="/home/me/projects">/home/me/projects</code></div>');
    expect(launchFolded).toContain('data-launch-unfold="workdir">');
  });

  it('renders stuck failedActions and drops buttons/view links on history messages', () => {
    const failed: TranscriptMessage = {
      id: 'p:n1',
      own: true,
      html: '<div class="raw">hi</div>',
      at: 0,
      _local: true,
      _state: 'failed',
      _nonce: 'n1',
    };
    expect(stuck(failed)).toBe(true);
    expect(failedActions(failed, true)).toContain('data-retry="n1"');
    expect(failedActions(failed, false)).not.toContain('data-retry=');

    const fileMsg: TranscriptMessage = {
      id: 'm3',
      html: '<p>log</p>',
      at: 0,
      file: { name: 'a.png', url: '/f/a.png', image: true, view: '/v/a.png' },
      buttons: [{ id: 'ok', label: 'OK' }],
    };
    const live = renderMsgMarkup('1:m3', fileMsg, false, {
      icons: ICONS,
      opened: {},
      canOpenGit: false,
      hasOutbox: () => false,
      isBtwHeld: () => false,
      btwLineMarkup: () => ({ cls: '', h: '' }),
    });
    expect(live.h).toContain('data-view="/v/a.png"');
    expect(live.h).toContain('data-btn="ok"');

    const hist = renderMsgMarkup('1:m3', fileMsg, true, {
      icons: ICONS,
      opened: {},
      canOpenGit: false,
      hasOutbox: () => false,
      isBtwHeld: () => false,
      btwLineMarkup: () => ({ cls: '', h: '' }),
    });
    expect(hist.cls).toContain('hist');
    expect(hist.h).not.toContain('data-view=');
    expect(hist.h).not.toContain('data-btn=');
  });
});
