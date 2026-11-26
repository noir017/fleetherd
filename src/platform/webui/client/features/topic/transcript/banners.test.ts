// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  createBannersController,
  forkNoteMarkup,
  forkNoteSignature,
  launchHtml,
  offWhen,
} from './banners.js';
import { attachLogEvents } from './events.js';
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

  it('renders agent cards without flat directory grid buttons', () => {
    const html = launchHtml(
      {
        current: 'cc',
        groups: [
          {
            name: 'local',
            agents: [
              { id: 'cc', harness: 'claude', kind: 'Claude Code' },
              { id: 'oc', harness: 'opencode', kind: 'OpenCode' },
            ],
          },
        ],
      },
      ICONS,
      { offSince: () => 0, offWhen: () => '', offTitle: () => '' },
      '/work/proj',
    );
    expect(html).toContain('data-agent="cc"');
    expect(html).toContain('data-agent="oc"');
    expect(html).toContain('class="launch-choice-agent">cc<');
    expect(html).toContain('data-launch-unfold="agents"');
    expect(html).toContain('class="launch-choice" hidden');
    expect(html).toContain('class="launch-wd"');
    expect(html).not.toContain('launch-dirs');
    expect(html).not.toContain('launch-dir-grid');
    expect(html).not.toContain('data-cwd');
  });

  it('dispatches launch agent, folder browse, and folder pick callbacks from inline launcher', () => {
    const log = document.createElement('div');
    log.innerHTML = launchHtml(
      {
        current: 'cc',
        groups: [{ name: 'local', agents: [{ id: 'cc', harness: 'claude', kind: 'Claude Code' }, { id: 'oc', harness: 'opencode', kind: 'OpenCode' }] }],
      },
      ICONS,
      { offSince: () => 0, offWhen: () => '', offTitle: () => '' },
    );
    const sendCommand = vi.fn();
    const selectLaunchAgent = vi.fn();
    const browseLaunchWorkdir = vi.fn();
    const pickLaunchWorkdir = vi.fn();
    const unfoldLaunch = vi.fn();
    const sub = attachLogEvents(log, {
      getTopic: () => 't1',
      getTopics: () => [],
      isNarrow: () => false,
      setSidebar: () => {},
      switchTopic: () => {},
      openShot: () => {},
      sendCommand,
      selectLaunchAgent,
      browseLaunchWorkdir,
      pickLaunchWorkdir,
      unfoldLaunch,
      toggleBtw: () => {},
      openReader: () => {},
      deliverLocal: () => {},
      copyLocal: () => {},
      discardLocal: () => {},
      toggleAll: () => {},
      toggleLine: () => {},
      openTurnChanges: () => {},
    });
    log.querySelector<HTMLButtonElement>('button[data-agent="oc"]')?.click();
    expect(selectLaunchAgent).toHaveBeenCalledWith('oc');
    expect(sendCommand).not.toHaveBeenCalled();
    const wd = log.querySelector<HTMLElement>('.launch-wd')!;
    wd.innerHTML =
      '<div class="wd-picker">' +
      '<button type="button" class="wd-change" data-launch-unfold="workdir">Change</button>' +
      '<button type="button" class="wd-open" data-wd-browse="/work/sub">sub</button>' +
      '<button type="button" class="wd-choose" data-wd-pick="/work/sub">Select</button>' +
      '</div>';
    wd.querySelector<HTMLButtonElement>('button[data-wd-browse]')?.click();
    expect(browseLaunchWorkdir).toHaveBeenCalledWith('/work/sub');
    wd.querySelector<HTMLButtonElement>('button[data-wd-pick]')?.click();
    expect(pickLaunchWorkdir).toHaveBeenCalledWith('/work/sub');
    log.querySelector<HTMLButtonElement>('button[data-launch-unfold="agents"]')?.click();
    expect(unfoldLaunch).toHaveBeenLastCalledWith('agents');
    log.querySelector<HTMLButtonElement>('button[data-launch-unfold="workdir"]')?.click();
    expect(unfoldLaunch).toHaveBeenLastCalledWith('workdir');
    sub.dispose();
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
    const launchNode = log.querySelector('.launch');
    expect(launchNode).not.toBeNull();
    expect(log.querySelector('.empty')).toBeNull();
    expect(machineNoteEl.hidden).toBe(true);

    // Topic dir.path changes alone do not rebuild the launch DOM.
    topics[1] = { ...topics[1]!, dir: { host: 'box1', path: '/work/other' } };
    banners.syncLaunch(true);
    expect(log.querySelector('.launch')).toBe(launchNode);

    // Switching agent and rendering inline folder browser happen in place on the same .launch node.
    banners.setLaunchWorkdir({
      agentId: 'claude',
      root: '/work',
      current: '/work',
      browsing: '/work',
      breadcrumbs: [{ name: '/', path: '/', buttonId: 'wdb:launch:0' }, { name: 'work', path: '/work', buttonId: 'wdb:launch:1' }],
      selectCurrent: { path: '/work', buttonId: 'wdr:launch:0', current: true, root: true },
      entries: [{ name: 'sub-a', path: '/work/sub-a', enterId: 'wde:launch:1', pickId: 'wdr:launch:1' }],
      truncated: 0,
    });
    expect(log.querySelector('.launch')).toBe(launchNode);
    expect(log.querySelector('.launch-wd .wd-picker')).not.toBeNull();
    expect(log.querySelector('.launch-wd .wd-cur')).toBeNull();
    expect(log.querySelector('.launch-wd .wd-bar .wd-pick-bar')?.getAttribute('data-wd-pick')).toBe('/work');
    expect(log.querySelector('.launch-wd .wd-selected .wd-path')?.textContent).toBe('/work');
    banners.setLaunchCwd('/work/sub-a');
    expect(log.querySelector('.launch')).toBe(launchNode);
    expect(log.querySelector('.launch-wd .wd-selected .wd-path')?.textContent).toBe('/work/sub-a');
    expect(log.querySelector('.launch-wd .wd-row.on')?.getAttribute('data-wd-name')).toBe('sub-a');

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

  it('folds agent cards and workdir, survives repaints, unfolds on demand, and resets on topic switch', () => {
    const log = document.createElement('div');
    const machineNoteEl = document.createElement('div');
    const forkNote = document.createElement('button');
    let curTopic = 't1';
    const launch: LaunchChoice = {
      current: 'cc@myhost',
      groups: [{ name: 'myhost', agents: [{ id: 'cc@myhost', harness: 'claude', kind: 'Claude' }] }],
    };
    const banners = createBannersController({
      log,
      machineNoteEl,
      forkNote,
      getTopic: () => curTopic,
      getTopics: () => [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }],
      topicById: (id) => ({ id, title: id }),
      getData: () => ({}),
      getEls: () => ({}),
      isSynced: () => true,
      isStale: () => false,
      getLaunch: () => launch,
      isHistory: () => false,
      getIcons: () => ICONS,
      formatStatusClock: () => '11:30',
      paintTopics: () => {},
      paintStatus: () => {},
      switchTopic: () => {},
      isNarrow: () => false,
      setSidebar: () => {},
    });
    const screen = {
      agentId: 'cc@myhost',
      host: 'myhost',
      root: '/home/me/projects',
      current: '/home/me/projects',
      browsing: '/home/me/projects',
      breadcrumbs: [{ name: '/', path: '/', buttonId: 'wdb:launch:0' }],
      selectCurrent: { path: '/home/me/projects', buttonId: 'wdr:launch:0', current: true, root: true },
      entries: [{ name: 'sub-a', path: '/home/me/projects/sub-a', enterId: 'wde:launch:1', pickId: 'wdr:launch:1' }],
      truncated: 0,
    };
    const hiddenOf = (sel: string) => log.querySelector<HTMLElement>(sel)!.hidden;

    banners.syncLaunch(true);
    banners.setLaunchWorkdir(screen);
    expect(log.querySelector('.wd-cur')).toBeNull();
    expect(log.querySelector('.wd-bar .wd-pick-bar')?.classList.contains('on')).toBe(true);
    expect([
      hiddenOf('.launch-agents'),
      hiddenOf('.launch-choice'),
      hiddenOf('.launch-wd'),
      hiddenOf('.wd-body'),
      hiddenOf('.wd-hint'),
      hiddenOf('.wd-selected'),
      hiddenOf('[data-launch-unfold="workdir"]'),
    ]).toEqual([false, true, false, false, false, true, true]);

    // Folding only agent keeps workdir picker open.
    banners.setLaunchAgent('cc@myhost', { fold: true });
    expect([
      hiddenOf('.launch-agents'),
      hiddenOf('.launch-choice'),
      hiddenOf('.wd-body'),
      hiddenOf('[data-launch-unfold="workdir"]'),
    ]).toEqual([true, false, false, true]);

    // Folding workdir keeps .wd-head visible with selected path and its own Change button.
    banners.setLaunchCwd('/home/me/projects/sub-a', { fold: true });
    expect([
      hiddenOf('.launch-wd'),
      hiddenOf('.wd-body'),
      hiddenOf('.wd-hint'),
      hiddenOf('.wd-selected'),
      hiddenOf('[data-launch-unfold="workdir"]'),
    ]).toEqual([false, true, true, false, false]);
    expect(log.querySelector('.wd-selected .wd-path')?.textContent).toBe('/home/me/projects/sub-a');

    // Same-topic repaints preserve folded state.
    banners.setMachines([{ name: 'myhost', since: Date.now() }]);
    expect([hiddenOf('.launch-agents'), hiddenOf('.launch-choice'), hiddenOf('.wd-body'), hiddenOf('.wd-selected')]).toEqual([true, false, true, false]);
    banners.setLaunchWorkdir(screen);
    expect(hiddenOf('.wd-body')).toBe(true);

    // Unfolding agents only does not touch workdir.
    banners.unfoldLaunch('agents');
    expect([hiddenOf('.launch-agents'), hiddenOf('.launch-choice'), hiddenOf('.wd-body'), hiddenOf('.wd-selected')]).toEqual([false, true, true, false]);

    // Re-fold agents, then unfold workdir only: agents stay folded.
    banners.setLaunchAgent('cc@myhost', { fold: true });
    banners.unfoldLaunch('workdir');
    expect([hiddenOf('.launch-agents'), hiddenOf('.launch-choice'), hiddenOf('.wd-body'), hiddenOf('.wd-hint'), hiddenOf('.wd-selected')]).toEqual([true, false, false, false, true]);

    // Switching topic resets fold state.
    banners.setLaunchCwd('/home/me/projects/sub-a', { fold: true });
    curTopic = 't2';
    log.innerHTML = '';
    banners.resetForTopicSwitch();
    banners.syncLaunch(true);
    banners.setLaunchWorkdir(screen);
    expect([hiddenOf('.launch-agents'), hiddenOf('.launch-choice'), hiddenOf('.wd-body'), hiddenOf('.wd-selected')]).toEqual([false, true, false, true]);
    banners.dispose();
  });
});
