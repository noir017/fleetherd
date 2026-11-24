// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  createBannersController,
  forkNoteMarkup,
  forkNoteSignature,
  launchHtml,
  offWhen,
} from './banners.js';
import type { LaunchChoice, TranscriptIcons, TranscriptMessage, TranscriptTopicLike } from './types.js';

const ICONS: TranscriptIcons = {
  icon: { offline: '<OFF>', fork: '<FORK>' },
  mark: {},
  reaction: {},
};

describe('banners pure helpers', () => {
  it('formats offWhen using clock for recent outages and localeString for older ones', () => {
    const now = 1_700_000_000_000;
    expect(offWhen(now - 3600_000, () => '10:00', now)).toBe('10:00');
    const old = now - 25 * 3600_000;
    expect(offWhen(old, () => '10:00', now)).toBe(new Date(old).toLocaleString());
  });

  it('renders launchHtml hiding host heading for single online group and showing it when offline or multi-group', () => {
    const single: LaunchChoice = {
      current: 'claude',
      groups: [
        {
          name: 'local',
          agents: [{ id: 'claude', harness: 'claude', kind: 'Claude Code', model: 'sonnet' }],
        },
      ],
    };
    const onlineHtml = launchHtml(single, ICONS, {
      offSince: () => 0,
      offWhen: () => '',
      offTitle: () => '',
    });
    expect(onlineHtml).not.toContain('launch-host');
    expect(onlineHtml).toContain('agent-card def');
    expect(onlineHtml).toContain('sonnet');

    const offlineHtml = launchHtml(single, ICONS, {
      offSince: () => 12345,
      offWhen: () => '09:00',
      offTitle: () => 'local offline',
    });
    expect(offlineHtml).toContain('launch-host');
    expect(offlineHtml).toContain('<OFF>');
    expect(offlineHtml).toContain('launch-group off');
  });

  it('builds forkNoteSignature and forkNoteMarkup', () => {
    const src: TranscriptTopicLike = { id: 't1', title: 'Main' };
    const cur: TranscriptTopicLike = { id: 't2', forkOf: 't1', forkTurn: 4 };
    expect(forkNoteSignature(cur, src)).toBe('t1|4|Main');
    expect(forkNoteSignature(cur, null)).toBe('');
    const html = forkNoteMarkup(src, 4, ICONS);
    expect(html).toContain('<FORK>');
    expect(html).toContain('Main');
    expect(html).toContain('4');
  });
});

describe('createBannersController', () => {
  it('manages skeleton, launch, empty note, offline machine note, fork note, divider, and syncing', () => {
    const log = document.createElement('div');
    const machineNoteEl = document.createElement('div');
    machineNoteEl.hidden = true;
    const forkNote = document.createElement('button');
    forkNote.hidden = true;

    const topics: TranscriptTopicLike[] = [
      { id: 't1', title: 'Parent', dir: { host: 'box1' } },
      { id: 't2', title: 'Child', forkOf: 't1', forkTurn: 2, dir: { host: 'box1' } },
    ];
    let curTopic = 't2';
    let stale = true;
    let synced = false;
    let launch: LaunchChoice | null = {
      current: 'claude',
      groups: [{ name: 'box1', agents: [{ id: 'claude', harness: 'claude', kind: 'Claude' }] }],
    };
    const data: Record<string, TranscriptMessage | undefined> = {};
    const els: Record<string, HTMLElement | undefined> = {};
    const paintTopics = vi.fn();
    const paintStatus = vi.fn();
    const switchTopic = vi.fn();

    const banners = createBannersController({
      log,
      machineNoteEl,
      forkNote,
      getTopic: () => curTopic,
      getTopics: () => topics,
      topicById: (id) => topics.find((t) => t.id === id),
      getData: () => data,
      getEls: () => els,
      isSynced: () => synced,
      isStale: () => stale,
      getLaunch: () => launch,
      isHistory: (m) => Boolean(m && m._g === 1),
      getIcons: () => ICONS,
      formatStatusClock: () => '11:30',
      paintTopics,
      paintStatus,
      switchTopic,
      isNarrow: () => false,
      setSidebar: () => {},
    });

    banners.showSkeleton();
    expect(log.querySelectorAll('.sk').length).toBe(4);

    // Launch replaces skeleton and suppresses stale empty note & machineNoteEl.
    banners.setMachines([{ name: 'box1', since: Date.now() }]);
    banners.syncEmptyNote();
    expect(banners.hasLaunch()).toBe(true);
    expect(log.querySelector('.launch')).not.toBeNull();
    expect(log.querySelector('.empty')).toBeNull();
    expect(machineNoteEl.hidden).toBe(true);

    // Clearing launch on a stale empty topic shows .empty and machineNoteEl.
    launch = null;
    banners.syncEmptyNote();
    expect(banners.hasLaunch()).toBe(false);
    expect(log.querySelector('.empty')).not.toBeNull();
    expect(machineNoteEl.hidden).toBe(false);
    expect(machineNoteEl.innerHTML).toContain('box1');

    // Fork note renders and clicks through to parent topic.
    banners.attachForkNoteClick();
    banners.paintForkNote(topics[1]);
    expect(forkNote.hidden).toBe(false);
    expect(forkNote.getAttribute('data-src')).toBe('t1');
    forkNote.click();
    expect(switchTopic).toHaveBeenCalledWith('t1');

    // Divider placed after history message; syncing placed at end while unsynced.
    const hEl = document.createElement('div');
    hEl.setAttribute('data-k', '1:m1');
    data['1:m1'] = { id: 'm1', html: '<p>old</p>', at: 1, _g: 1 };
    els['1:m1'] = hEl;
    log.appendChild(hEl);
    banners.placeDivider();
    expect(hEl.nextSibling && (hEl.nextSibling as Element).className).toBe('divider');

    banners.showSyncing();
    expect(log.querySelector('.syncing')).not.toBeNull();
    banners.clearSyncing();
    expect(log.querySelector('.syncing')).toBeNull();

    curTopic = 't1';
    stale = false;
    synced = true;
    banners.dispose();
  });
});
