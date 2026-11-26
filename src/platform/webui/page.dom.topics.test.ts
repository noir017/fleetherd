import { describe, it, expect } from 'vitest';
import {
  tick,
  until,
  within,
  chipNames,
  sync,
  message,
  face,
  open,
  type Harness,
  type Call,
} from './page.dom.test-helpers.js';



/**
 * A topic's copy (page.ts put / get / enter): one per topic, in memory and in IndexedDB, as of the
 * last event it reflects. Going back to a topic puts its copy up and resumes the stream from there.
 */



/**
 * One composer serves every topic, so what is in it has to be swapped on the way through — text,
 * caret and attachments alike. Before, a half-written prompt followed the reader into the next
 * topic, and so did a pasted screenshot, which then went out with whatever was sent there.
 */
describe('webui page: a composer per topic', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const input = (h: Harness): HTMLTextAreaElement => h.el('input') as HTMLTextAreaElement;
  const stored = (h: Harness): unknown => JSON.parse(h.window.localStorage.getItem('aa_drafts') ?? 'null');
  const sends = (h: Harness): Call[] => h.calls.filter((c) => c.path === 'api/send');

  /** A screenshot pasted into the page, the way the pasting tests below build one. */
  const paste = (h: Harness): void => {
    const file = new h.window.File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });
    const ev = new h.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
      value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
    });
    h.el('input').dispatchEvent(ev);
  };

  /** The page going into the background, which is the write that has to survive a discard. */
  const hide = (h: Harness): void => {
    Object.defineProperty(h.doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
    h.doc.dispatchEvent(new h.window.Event('visibilitychange'));
  };

  it('gives each topic its own text, and puts the caret back where it was', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A, B]));
    input(h).value = 'for A, half written';
    input(h).setSelectionRange(5, 5);

    await h.click(`[data-topic="${B}"]`);
    expect(input(h).value).toBe('');
    input(h).value = 'for B';

    await h.click(`[data-topic="${A}"]`);
    expect(input(h).value).toBe('for A, half written');
    expect(input(h).selectionStart).toBe(5);

    await h.click(`[data-topic="${B}"]`);
    expect(input(h).value).toBe('for B');
  });

  it('keeps an attachment with the topic it was attached in', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A, B]));
    paste(h);
    await until('the chip is rendered', () => chipNames(h).join() === 'pasted-1.png');

    await h.click(`[data-topic="${B}"]`);
    expect(chipNames(h)).toEqual([]);
    input(h).value = 'nothing attached here';
    await h.click('#composer button[type="submit"]');
    expect(sends(h)[0]?.body.files).toBeUndefined();

    await h.click(`[data-topic="${A}"]`);
    expect(chipNames(h)).toEqual(['pasted-1.png']);
    await h.click('#composer button[type="submit"]');
    expect((sends(h)[1]?.body.files as unknown[]).length).toBe(1);
    expect(sends(h)[1]?.body.topic).toBe(A);
  });

  it('lands a file still being read in the topic it was picked in, not the one switched to', async () => {
    // FileReader answers a few turns after the paste; a click on another topic in between is
    // exactly the moment a global list would hand the file to the wrong conversation.
    const h = await open();
    await h.emit(sync(A, [], [A, B]));
    paste(h);
    h.doc.querySelector<HTMLElement>(`[data-topic="${B}"]`)!.click();
    for (let i = 0; i < 20; i++) await tick();
    expect(chipNames(h)).toEqual([]);

    await h.click(`[data-topic="${A}"]`);
    expect(chipNames(h)).toEqual(['pasted-1.png']);
  });

  it('keeps the text across a reload, written when the page is hidden rather than per keystroke', async () => {
    const first = await open({ url: `http://localhost:8787/?t=${A}` });
    await first.emit(sync(A, [], [A, B]));
    input(first).value = 'survives a reload';
    // A key alone writes nothing: storage is touched on the way out, and once typing pauses.
    input(first).dispatchEvent(new first.window.Event('input', { bubbles: true }));
    expect(stored(first)).toBeNull();

    hide(first);
    expect(stored(first)).toEqual({ [A]: 'survives a reload' });

    const again = await open({
      url: `http://localhost:8787/?t=${A}`,
      storage: { aa_drafts: first.window.localStorage.getItem('aa_drafts')! },
    });
    // Before the stream has said anything: the draft is this browser's, not the daemon's.
    expect(input(again).value).toBe('survives a reload');

    await again.emit(sync(A, [], [A, B]));
    await again.click('#composer button[type="submit"]');
    // Sent, so gone — a reload now must not offer it for sending a second time.
    expect(stored(again)).toEqual({});
  });

  it('writes the draft down once typing pauses, for a page that goes away without a word', async () => {
    // A renderer that crashes, or a phone that kills the tab in the foreground, fires no
    // visibilitychange. That used to cost the whole draft; now it costs the last pause's worth.
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A, B]));
    const type = (s: string): void => {
      input(h).value = s;
      input(h).dispatchEvent(new h.window.Event('input', { bubbles: true }));
    };
    type('half');
    type('half a thought');
    expect(stored(h)).toBeNull();

    await within('the pause is written down', 3000, () => stored(h) !== null);
    expect(stored(h)).toEqual({ [A]: 'half a thought' });
  });

  it('picks up its draft from the first sync when the visit named no topic', async () => {
    const h = await open({ storage: { aa_drafts: JSON.stringify({ [A]: 'from last time' }) } });
    expect(input(h).value).toBe('');
    await h.emit(sync(A, [], [A]));
    expect(input(h).value).toBe('from last time');
  });

  it('leaves drafts another tab wrote alone', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A, B]));
    // Written by a second tab on this origin, after this one loaded.
    h.window.localStorage.setItem('aa_drafts', JSON.stringify({ c3d4e5f6: 'the other tab' }));
    input(h).value = 'this tab';

    await h.click(`[data-topic="${B}"]`);
    expect(stored(h)).toEqual({ c3d4e5f6: 'the other tab', [A]: 'this tab' });
  });

  it('keeps a very long draft in memory only', async () => {
    // localStorage is one small budget for the whole origin; a pasted log must not fill it and take
    // the read marks and the drawer state down with it.
    const h = await open();
    await h.emit(sync(A, [], [A, B]));
    const long = 'x'.repeat(70 * 1024);
    input(h).value = long;

    await h.click(`[data-topic="${B}"]`);
    expect(stored(h)).toBeNull();
    await h.click(`[data-topic="${A}"]`);
    expect(input(h).value).toBe(long);
  });

  it('touches no storage at all switching between two empty composers', async () => {
    // Most switches are exactly this, and the draft swap is on the path of every one of them.
    const h = await open();
    await h.emit(sync(A, [], [A, B]));
    const touched: string[] = [];
    const proto = h.window.Storage.prototype;
    const get = proto.getItem;
    const set = proto.setItem;
    proto.getItem = function (this: Storage, k: string) {
      if (k === 'aa_drafts') touched.push('get');
      return get.call(this, k);
    };
    proto.setItem = function (this: Storage, k: string, v: string) {
      if (k === 'aa_drafts') touched.push('set');
      return set.call(this, k, v);
    };

    await h.click(`[data-topic="${B}"]`);
    await h.click(`[data-topic="${A}"]`);
    expect(touched).toEqual([]);
  });

});

describe('webui page: a topic the daemon no longer has', () => {
  // A transcript lives in the daemon's memory while the topic LIST lives on disk, so every
  // restart leaves rows that open onto nothing. Rendered faithfully that is a blank panel — which
  // is indistinguishable from a page that failed to load, and is how it was reported.
  it('says why an emptied topic is empty', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { stale: true }));

    expect(h.painted()).toBe(0);
    expect(h.skeletons()).toBe(0);
    expect(h.notice()).toContain('older than the running daemon');
    // The half that keeps it from reading as data loss: the agent's own context is persisted.
    expect(h.notice()).toContain('still has its context');
  });

  it('takes the notice away as soon as the topic has something in it', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { stale: true }));
    expect(h.notice()).not.toBeNull();

    await h.emit({ t: 'msg', msg: message('m1', '<p>carrying on</p>') });

    expect(h.notice()).toBeNull();
    expect(h.painted()).toBe(1);
  });

  it('leaves a genuinely new topic to speak for itself', async () => {
    // No flag, so this room is empty because nothing has been said in it yet. Explaining a
    // restart here would be both wrong and the first thing a new install ever reads.
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    expect(h.notice()).toBeNull();
  });

  it('does not carry the notice into the next topic', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5'], { stale: true }));
    expect(h.notice()).not.toBeNull();

    await h.click('[data-topic="b2c3d4e5"]');

    // Whether THAT room predates the daemon is its own sync's answer to give; until it lands the
    // page is back to showing the shape of a transcript that is on its way.
    expect(h.notice()).toBeNull();
    expect(h.skeletons()).toBeGreaterThan(0);
  });
});

describe('webui page: choosing an agent for a new topic', () => {
  /** Two machines, the shape `agentCatalog` builds: the live deployment's, give or take. */
  const agents = {
    current: 'cc',
    groups: [
      {
        name: 'uniagent',
        agents: [
          { id: 'cc', harness: 'claude', kind: 'Claude Code' },
          { id: 'oc', harness: 'opencode', kind: 'OpenCode', model: 'opencode/deepseek-v4.1-flash-free' },
          { id: 'cx', harness: 'codex', kind: 'Codex' },
        ],
      },
      {
        name: 'buildbox',
        agents: [
          { id: 'oc2', harness: 'opencode', kind: 'OpenCode' },
          { id: 'cb', harness: 'custom', kind: 'codebuddy' },
        ],
      },
    ],
  };
  const launch = (h: Harness): HTMLElement | null => h.el('log').querySelector('.launch');
  const cards = (h: Harness): HTMLElement[] => Array.from(h.el('log').querySelectorAll<HTMLElement>('.agent-card'));

  it('lays every agent out by machine in place of the empty transcript, the default marked', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents }));

    expect(h.skeletons()).toBe(0);
    expect(h.painted()).toBe(0);
    expect(Array.from(launch(h)!.querySelectorAll('.launch-host')).map((e) => e.firstChild?.textContent?.trim())).toEqual([
      'uniagent',
      'buildbox',
    ]);
    expect(cards(h).map((c) => c.getAttribute('data-agent'))).toEqual(['cc', 'oc', 'cx', 'oc2', 'cb']);
    // What each one IS, not only its id — and the model, where one is configured.
    expect(cards(h)[1]!.textContent).toContain('OpenCode');
    expect(cards(h)[1]!.querySelector('.ac-model')?.textContent).toBe('opencode/deepseek-v4.1-flash-free');
    expect(cards(h)[4]!.textContent).toContain('codebuddy');
    // Coloured by the configured harness, which is a key, rather than by the label, which is prose.
    expect(cards(h)[2]!.querySelector('.ac-hc')?.className).toContain('h-codex');
    // Who "just type" reaches, said twice: on its card, and in the line above.
    const def = h.el('log').querySelectorAll('.agent-card.def');
    expect(Array.from(def).map((c) => c.getAttribute('data-agent'))).toEqual(['cc']);
    expect(def[0]!.textContent).toContain('default');
    expect(launch(h)!.querySelector('.launch-sub')?.textContent).toContain('cc answers by default');
  });

  it('names no machine when there is only one', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents: { current: 'cc', groups: [agents.groups[0]] } }));
    expect(cards(h)).toHaveLength(3);
    expect(launch(h)!.querySelector('.launch-host')).toBeNull();
  });

  it('a tap switches agent in place via api/topics/setup, loads its folder root, and preserves the composer draft', async () => {
    const wdScreen = (agentId: string, root: string, browsing = root, current = root) => ({
      agentId,
      root,
      current,
      browsing,
      breadcrumbs: [
        { name: '/', path: '/', buttonId: 'wdb:launch:0' },
        { name: browsing.split('/').filter(Boolean).pop() ?? browsing, path: browsing, buttonId: 'wdb:launch:1' },
      ],
      selectCurrent: { path: browsing, buttonId: 'wdr:launch:0', current: browsing === current, root: browsing === root },
      entries:
        browsing === '/work'
          ? [{ name: 'sub-a', path: '/work/sub-a', enterId: 'wde:launch:1', pickId: 'wdr:launch:1', current: current === '/work/sub-a' }]
          : [{ name: 'nested', path: `${browsing}/nested`, enterId: 'wde:launch:1', pickId: 'wdr:launch:1' }],
      truncated: 0,
    });
    const h = await open({
      url: 'http://localhost:8787/?t=a1b2c3d4',
      replies: {
        'api/topics/workdirs?t=a1b2c3d4&agent=cc': wdScreen('cc', '/work'),
        'api/topics/workdirs?t=a1b2c3d4&agent=cc&dir=%2Fwork%2Fsub-a': wdScreen('cc', '/work', '/work/sub-a', '/work'),
        'api/topics/workdirs?t=a1b2c3d4&agent=oc2&root=1': wdScreen('oc2', '/srv'),
        'api/topics/setup': { ok: true, agent: 'oc2', cwd: '/srv' },
      },
    });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents }));
    await tick();
    const launchEl = launch(h);
    expect(launchEl).not.toBeNull();
    // Inline folder browser loads on the same page for the default agent.
    expect(launchEl!.querySelector('.launch-wd .wd-picker')?.getAttribute('data-browsing')).toBe('/work');
    expect(launchEl!.querySelector('.launch-wd .wd-cur')).toBeNull();
    expect(launchEl!.querySelector('.launch-wd .wd-bar .wd-pick-bar')?.getAttribute('data-wd-pick')).toBe('/work');
    expect(launchEl!.querySelector('.launch-wd .wd-selected .wd-path')?.textContent).toBe('/work');
    // Navigating into a subfolder updates only the folder browser in place.
    await h.click('.launch-wd .wd-open[data-wd-browse="/work/sub-a"]');
    await tick();
    expect(launch(h)).toBe(launchEl);
    expect(launchEl!.querySelector('.launch-wd .wd-picker')?.getAttribute('data-browsing')).toBe('/work/sub-a');

    (h.el('input') as HTMLTextAreaElement).value = 'a draft';

    await h.click('.agent-card[data-agent="oc2"]');
    await tick();
    await tick();

    const setup = h.calls.filter((c) => c.path === 'api/topics/setup');
    expect(setup.map((c) => [c.body.agent, c.body.topic])).toEqual([['oc2', 'a1b2c3d4']]);
    expect(h.calls.filter((c) => c.path === 'api/send')).toHaveLength(0);
    expect(launch(h)).toBe(launchEl);
    expect(launchEl!.querySelector('.agent-card.def')?.getAttribute('data-agent')).toBe('oc2');
    expect(launchEl!.querySelector<HTMLElement>('.launch-agents')?.hidden).toBe(true);
    expect(launchEl!.querySelector<HTMLElement>('.launch-choice')?.hidden).toBe(false);
    expect(launchEl!.querySelector<HTMLElement>('.launch-wd')?.hidden).toBe(false);
    expect(launchEl!.querySelector<HTMLElement>('.launch-wd .wd-body')?.hidden).toBe(false);
    expect(launchEl!.querySelector('.launch-wd .wd-picker')?.getAttribute('data-browsing')).toBe('/srv');
    expect(launchEl!.querySelector('.launch-wd .wd-selected .wd-path')?.textContent).toBe('/srv');
    // A control, like Stop: what was in the composer is still there.
    expect((h.el('input') as HTMLTextAreaElement).value).toBe('a draft');
  });

  it('folds agent cards and folder browser once chosen, survives repaints, unfolds on Change, and resets on topic switch', async () => {
    const wdScreen = (agentId: string, root: string, browsing = root, current = root) => ({
      agentId,
      root,
      current,
      browsing,
      breadcrumbs: [{ name: '/', path: '/', buttonId: 'wdb:launch:0' }, { name: 'work', path: root, buttonId: 'wdb:launch:1' }],
      selectCurrent: { path: browsing, buttonId: 'wdr:launch:0', current: browsing === current, root: browsing === root },
      entries: [{ name: 'sub-a', path: `${root}/sub-a`, enterId: 'wde:launch:1', pickId: 'wdr:launch:1', current: `${root}/sub-a` === current }],
      truncated: 0,
    });
    const h = await open({
      url: 'http://localhost:8787/?t=a1b2c3d4',
      replies: {
        'api/topics/workdirs?t=a1b2c3d4&agent=cc': wdScreen('cc', '/work'),
        'api/topics/workdirs?t=a1b2c3d4&agent=oc2&root=1': wdScreen('oc2', '/srv'),
        'api/topics/workdirs?t=a1b2c3d4&agent=oc2': wdScreen('oc2', '/srv', '/srv', '/srv/sub-a'),
        'api/topics/workdirs?t=b2c3d4e5&agent=cc': wdScreen('cc', '/work'),
        'api/topics/setup': { ok: true, agent: 'oc2', cwd: '/srv/sub-a' },
      },
    });
    const foldState = () => {
      const root = launch(h)!;
      return {
        agents: root.querySelector<HTMLElement>('.launch-agents')!.hidden,
        agentRow: root.querySelector<HTMLElement>('.launch-choice')!.hidden,
        wdBody: root.querySelector<HTMLElement>('.launch-wd .wd-body')!.hidden,
        wdHint: root.querySelector<HTMLElement>('.launch-wd .wd-hint')!.hidden,
        wdSelected: root.querySelector<HTMLElement>('.launch-wd .wd-selected')!.hidden,
        wdChange: root.querySelector<HTMLElement>('[data-launch-unfold="workdir"]')!.hidden,
      };
    };
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5'], { agents }));
    await tick();

    // Fresh topic starts unfolded with both Change rows hidden and no .wd-cur.
    expect(launch(h)!.querySelector('.wd-cur')).toBeNull();
    expect(launch(h)!.querySelector('.wd-bar .wd-pick-bar')?.getAttribute('data-wd-pick')).toBe('/work');
    expect(foldState()).toEqual({
      agents: false,
      agentRow: true,
      wdBody: false,
      wdHint: false,
      wdSelected: true,
      wdChange: true,
    });

    // Choosing an agent folds agent cards only; folder browser stays open.
    await h.click('.agent-card[data-agent="oc2"]');
    await tick();
    await tick();
    expect(foldState()).toEqual({
      agents: true,
      agentRow: false,
      wdBody: false,
      wdHint: false,
      wdSelected: true,
      wdChange: true,
    });
    expect(launch(h)!.querySelector('.launch-choice-agent')!.textContent).toBe('oc2');

    // Choosing a folder folds only the folder body, keeping .wd-head with the selected path.
    await h.click('.launch-wd .wd-choose[data-wd-pick="/srv/sub-a"]');
    await tick();
    await tick();
    expect(foldState()).toEqual({
      agents: true,
      agentRow: false,
      wdBody: true,
      wdHint: true,
      wdSelected: false,
      wdChange: false,
    });
    expect(launch(h)!.querySelector('.launch-wd .wd-selected .wd-path')!.textContent).toBe('/srv/sub-a');

    // Machine offline repaint preserves folded state for the same topic.
    await h.emit({ t: 'machines', offline: [{ name: 'buildbox', since: Date.now() }] });
    await tick();
    expect(foldState()).toEqual({
      agents: true,
      agentRow: false,
      wdBody: true,
      wdHint: true,
      wdSelected: false,
      wdChange: false,
    });
    expect(launch(h)!.querySelector('.launch-wd .wd-selected .wd-path')!.textContent).toBe('/srv/sub-a');

    // Clicking Agent Change unfolds only agent cards; workdir stays folded.
    await h.click('[data-launch-unfold="agents"]');
    expect(foldState()).toEqual({
      agents: false,
      agentRow: true,
      wdBody: true,
      wdHint: true,
      wdSelected: false,
      wdChange: false,
    });

    // Clicking Workdir Change unfolds only workdir; agent cards stay as they are.
    await h.click('.agent-card[data-agent="oc2"]');
    await tick();
    await h.click('[data-launch-unfold="workdir"]');
    expect(foldState()).toEqual({
      agents: true,
      agentRow: false,
      wdBody: false,
      wdHint: false,
      wdSelected: true,
      wdChange: true,
    });

    // Switch to another new topic: folded state must not leak.
    expect(foldState().agents).toBe(true);
    await h.click('[data-topic="b2c3d4e5"]');
    await h.emit(sync('b2c3d4e5', [], ['a1b2c3d4', 'b2c3d4e5'], { agents }));
    await tick();
    expect(foldState()).toEqual({
      agents: false,
      agentRow: true,
      wdBody: false,
      wdHint: false,
      wdSelected: true,
      wdChange: true,
    });
  });

  it('goes as soon as anything is said, typed or not, and comes back if the room empties again', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents }));

    await h.emit({ t: 'msg', msg: message('w1', '<p>a scheduled task said this</p>') });
    expect(launch(h)).toBeNull();

    // Deleted again, and nothing has said the choice is closed: the room is what it was.
    await h.emit({ t: 'del', id: 'w1' });
    expect(cards(h)).toHaveLength(5);
  });

  it('follows the sync: a room that has started shows none, and a stale one shows the choice instead of the notice', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents }));
    expect(launch(h)).not.toBeNull();

    // A reconnect's sync for the same room, now carrying nothing: the daemon closed the question.
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    expect(launch(h)).toBeNull();

    // Older than the daemon and still open: no agent has a session here, so "the agent still has its
    // context" would be untrue — the choice is the honest thing to show.
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { stale: true, agents }));
    expect(launch(h)).not.toBeNull();
    expect(h.notice()).toBeNull();
  });

  it('is redrawn only when what it shows changed', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents }));
    const first = launch(h);
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents }));
    expect(launch(h)).toBe(first);

    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents: { ...agents, current: 'cx' } }));
    expect(launch(h)).not.toBe(first);
    expect(h.el('log').querySelector('.agent-card.def')?.getAttribute('data-agent')).toBe('cx');
  });

  it('does not carry into the next topic', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5'], { agents }));
    expect(launch(h)).not.toBeNull();

    await h.click('[data-topic="b2c3d4e5"]');

    // That room's own sync says whether it has a choice to offer; until then, placeholders.
    expect(launch(h)).toBeNull();
    expect(h.skeletons()).toBeGreaterThan(0);
  });

  it('lays it out again in the next new topic, though it offers the very same agents', async () => {
    // The everyday path — + twice — and the one a cached "already drawn" would get wrong: the
    // element went with the last topic's transcript, while what it was drawn from has not changed.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5'], { agents }));
    await h.click('[data-topic="b2c3d4e5"]');
    await h.emit(sync('b2c3d4e5', [], ['a1b2c3d4', 'b2c3d4e5'], { agents }));

    expect(cards(h)).toHaveLength(5);
    expect(h.skeletons()).toBe(0);
  });

  it('escapes what it is given, which comes from config.yaml', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    const odd = { id: 'x"><img src=x>', harness: 'custom', kind: '<b>k</b>', model: '<i>m</i>' };
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents: { current: 'cc', groups: [{ name: '<u>g</u>', agents: [odd] }, agents.groups[0]] } }));
    expect(h.el('log').querySelector('.launch img, .launch b:not(.launch-sub b), .launch i:not(.ac-dot), .launch u')).toBeNull();
    expect(cards(h)[0]!.getAttribute('data-agent')).toBe('x"><img src=x>');
  });
});

describe('webui page: a machine the gateway cannot reach', () => {
  const agents = {
    current: 'cc',
    groups: [
      { name: 'uniagent', agents: [{ id: 'cc', harness: 'claude', kind: 'Claude Code' }] },
      { name: 'laptop', agents: [{ id: 'cc@laptop', harness: 'claude', kind: 'Claude Code' }, { id: 'oc@laptop', harness: 'opencode', kind: 'OpenCode' }] },
    ],
  };
  // A few minutes ago, so the page says it as a time of day.
  const since = Date.now() - 5 * 60_000;
  const at = (ms: number): string => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const laptopDown = [{ name: 'laptop', since }];
  /** Two topics, one on each machine, the shape `topicList` builds with a workdir lookup. */
  const placed = (current: string, messages: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    sync(current, messages, [], {
      topics: [
        { id: 'a1b2c3d4', title: 'Fix the build', lastAt: 1000, running: false, msgCount: current === 'a1b2c3d4' ? messages.length : 0, dir: { name: 'shop-api', path: '/home/user/work/shop-api', host: 'laptop' } },
        { id: 'b2c3d4e5', title: 'Docs', lastAt: 999, running: false, msgCount: 0, dir: { name: 'fleetherd', path: '/home/user/workspace/fleetherd', host: 'uniagent' } },
      ],
      ...extra,
    });
  const heading = (h: Harness, name: string): Element | undefined =>
    Array.from(h.el('log').querySelectorAll('.launch-host')).find((e) => e.firstChild?.textContent?.trim() === name);

  it('marks the machine over its agents on a new topic, and still lets one be chosen', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents, offline: laptopDown }));

    expect(face(heading(h, 'laptop')?.querySelector('.off'))).toBe(`[offline]offline since ${at(since)}`);
    expect(heading(h, 'uniagent')?.querySelector('.off')).toBeNull();
    expect(h.el('log').querySelector('.launch-group.off .agent-card')?.getAttribute('data-agent')).toBe('cc@laptop');
    // Dimmed, not disabled: the machine may be back by the time anyone writes.
    await h.click('.agent-card[data-agent="oc@laptop"]');
    expect(h.calls.filter((c) => c.path === 'api/topics/setup').map((c) => c.body.agent)).toEqual(['oc@laptop']);
  });

  it('follows the machines event while the choice is open, both ways', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents }));
    expect(h.el('log').querySelector('.launch-group.off')).toBeNull();

    await h.emit({ t: 'machines', offline: laptopDown });
    expect(heading(h, 'laptop')?.querySelector('.off')).not.toBeNull();

    await h.emit({ t: 'machines', offline: [] });
    expect(h.el('log').querySelector('.launch-group.off, .launch-host .off')).toBeNull();
  });

  it('names the only machine when it is the one that is offline', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { agents: { current: 'cc@laptop', groups: [agents.groups[1]] }, offline: laptopDown }));
    expect(face(heading(h, 'laptop'))).toContain('offline since');
  });



  it('leaves the line out under the agent cards, whose heading already says it', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(placed('a1b2c3d4', [], { agents, offline: laptopDown }));
    expect(heading(h, 'laptop')?.querySelector('.off')).not.toBeNull();
    expect(h.el('machine-note').hidden).toBe(true);
  });

});

describe('webui page: topic row agent tag and row menu stability', () => {
  it('renders a quiet separated agent label and keeps an open row menu anchored across topic list repaints', async () => {
    const h = await open({ width: 1280, height: 800 });
    const t1 = {
      id: 'a1b2c3d4',
      title: 'Fix row menu',
      lastAt: Date.now() - 120_000,
      running: false,
      live: true,
      msgCount: 3,
      agent: { id: 'cc@myhost', harness: 'claude' },
      dir: { name: 'workspace', path: '/home/me/projects', host: 'myhost' },
    };
    const t2 = {
      id: 'b2c3d4e5',
      title: '',
      lastAt: Date.now() - 60_000,
      running: false,
      msgCount: 0,
      agent: { id: 'cc', harness: 'claude' },
    };
    await h.emit(sync('a1b2c3d4', [], [], { topics: [t1, t2] }));

    const row1 = h.doc.querySelector<HTMLElement>('[data-topic="a1b2c3d4"]')!;
    expect(row1.querySelector('.topic-hc.h-claude')?.textContent).toBe('cc');
    expect(row1.querySelector('.topic-hc')?.getAttribute('title')).toBe('Agent: cc@myhost');
    expect(row1.querySelector('.topic-sep')?.textContent).toBe('·');

    const row2 = h.doc.querySelector<HTMLElement>('[data-topic="b2c3d4e5"]')!;
    expect(row2.querySelector('.topic-hc.h-claude')?.textContent).toBe('cc');
    expect(row2.querySelector('.topic-sep')?.textContent).toBe('·');

    const origGetRect = h.window.HTMLElement.prototype.getBoundingClientRect;
    h.window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.getAttribute('data-rm') === 'topic:a1b2c3d4' && this.isConnected) {
        return { left: 220, right: 244, top: 150, bottom: 170, width: 24, height: 20, x: 220, y: 150, toJSON: () => ({}) } as DOMRect;
      }
      if (this.getAttribute('data-rm') === 'topic:a1b2c3d4' && !this.isConnected) {
        return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return origGetRect.call(this);
    };

    await h.click('[data-rm="topic:a1b2c3d4"]');
    const menu = h.doc.querySelector<HTMLElement>('.wb-topic-row-menu')!;
    expect(menu.hidden).toBe(false);
    const leftBefore = menu.style.left;
    const topBefore = menu.style.top;
    expect(topBefore).toBe('174px');

    // Trigger a list repaint with updated message count and a new row
    await h.emit({
      t: 'topics',
      topics: [
        { ...t1, msgCount: 4, lastAt: Date.now() },
        t2,
        { id: 'c3d4e5f6', title: 'Another topic', lastAt: Date.now() - 30_000, running: false, msgCount: 1 },
      ],
    });
    expect(menu.hidden).toBe(false);
    expect(menu.style.left).toBe(leftBefore);
    expect(menu.style.top).toBe(topBefore);
    expect(h.doc.querySelector('[data-rm="topic:a1b2c3d4"]')?.getAttribute('aria-expanded')).toBe('true');

    // Removing the topic closes the open menu
    await h.emit({ t: 'topics', topics: [t2] });
    expect(menu.hidden).toBe(true);
  });
});
