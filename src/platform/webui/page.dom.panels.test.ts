import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderPage,
  tick,
  until,
  within,
  opens,
  sync,
  message,
  face,
  open,
  type Harness,
} from './page.dom.test-helpers.js';

describe('webui page: the scheduled-task panel', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'a1b2c3',
    name: 'Morning CI',
    state: 'active',
    when: '0 8 * * * (Asia/Shanghai)',
    next: '2026-11-05 08:00',
    nextAt: Date.UTC(2026, 10, 5, 0, 0, 0),
    run: 'cc · fixed session',
    target: 'web:main#' + A,
    targetTopic: A,
    runs: 2,
    running: false,
    detail: 'summarise the failures',
    kind: 'agent',
    ...over,
  });
  const listReply = (tasks: Array<Record<string, unknown>>): Record<string, unknown> => ({ enabled: true, tasks });
  const TASK_URL = 'api/schedules/task?id=a1b2c3';
  /** core/schedule.ts SHAPE_SETTINGS, as the daemon hands it over. */
  const SHAPES = {
    bash: ['cwd', 'host', 'timeout', 'at'],
    fixed: ['agent', 'at'],
    new: ['agent', 'model', 'cwd', 'at'],
    daily: ['agent', 'model', 'cwd'],
  };
  /** What the form offers whatever task it is filled from: agents, machines, places, defaults. */
  const formContext = (): Record<string, unknown> => ({
    agents: ['cc', 'oc'],
    agentHosts: { oc: 'box' },
    hosts: ['box'],
    channels: [{ id: 'tg:-100/7', title: 'ops chat' }],
    shapes: SHAPES,
    tz: 'Asia/Shanghai',
    agent: 'cc',
  });
  /** A task's page as the daemon answers it: a new-session task with a directory and a model. */
  const detail = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...formContext(),
    task: task(),
    fields: {
      name: 'Morning CI',
      cron: '0 8 * * *',
      tz: 'Asia/Shanghai',
      prompt: 'summarise the failures',
      agent: 'cc',
      session: 'new',
      model: 'm1',
      cwd: '/srv/app',
      target: 'web:main/' + A,
    },
    runs: [],
    ...over,
  });
  /** Whether a form field is on screen: its group follows the shape the form is set to. */
  const shownField = (h: Harness, id: string): boolean => {
    const group = h.el(id).closest('[data-tp-need],[data-tp-kinded]') as HTMLElement | null;
    return !h.el(id).hidden && !(group?.hidden ?? false);
  };
  const pageReply = (d: Record<string, unknown>): Record<string, unknown> => ({ ok: true, detail: d });
  /** Open a task row's ⋯ menu, as a person would: one box, so the selector is inside #row-menu. */
  const taskMenu = async (h: Harness, id: string): Promise<HTMLElement> => {
    await h.click(`[data-rm="task:${id}"]`);
    return h.el('row-menu');
  };

  it('is closed by default, opens from the header, and draws the list', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task()]) } });
    await h.emit(sync(A, [], [A]));

    expect(h.el('app').classList.contains('sched-open')).toBe(false);
    expect(h.el('schedules-toggle').getAttribute('aria-expanded')).toBe('false');

    await h.click('#schedules-toggle');

    expect(h.el('app').classList.contains('sched-open')).toBe(true);
    expect(h.el('schedules-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(h.el('schedules-summary').textContent).toBe('1 active');
    expect(h.el('schedules-list').textContent).toContain('Morning CI');
    // The cron is not on the row any more — it is on the row's hover card, with the next run.
    // The detail is in the DOM (folded), so the row is what is read here, not the whole list.
    const row = h.doc.querySelector('.sched-item .topic-item') as HTMLElement;
    expect(row.textContent).not.toContain('0 8 * * *');
    expect(row.getAttribute('title')).toContain('0 8 * * * (Asia/Shanghai)');
    expect(row.getAttribute('title')).toContain('next 2026-11-05 08:00');
    // The target is resolved against the topic list the page already has, rather than shown as
    // `web:main#…` — the one thing a person cannot read.
    expect(h.el('schedules-list').textContent).toContain('→ Topic ' + A);
  });

  it('draws a task as a row: no cron on it, the state on its dot, the rest on one line', async () => {
    const now = Date.now();
    const replies = { 'api/schedules': listReply([
      task({ id: 't00001', name: 'Active one', nextAt: now + 3 * 3600 * 1000 }),
      task({ id: 't00002', name: 'Running one', running: true }),
      task({ id: 't00003', name: 'Paused one', state: 'paused' }),
      task({ id: 't00004', name: 'Failed one', last: { status: 'failed', at: now - 2 * 3600 * 1000 } }),
      task({ id: 't00005', name: 'Tagged one', tags: ['ci', 'ops'] }),
      task({ id: 't00006', name: 'Done one', state: 'done' }),
    ]) };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    const row = (id: string): HTMLElement => h.doc.querySelector(`.sched-item[data-id="${id}"] .topic-item`) as HTMLElement;
    const dot = (id: string): Element | null => row(id).querySelector('.topic-dot');
    const line = (id: string): string => row(id).querySelector('.topic-dir')?.textContent ?? '';

    // The shared row component, and the cron is nowhere on the row itself.
    expect(row('t00001').classList.contains('topic-item')).toBe(true);
    expect(row('t00001').textContent).not.toContain('0 8 * * *');
    expect(row('t00001').getAttribute('title')).toContain('0 8 * * * (Asia/Shanghai)');
    expect(row('t00001').querySelector('.topic-title')?.textContent).toBe('Active one');

    // Active: dim-blue dot, the countdown, the target, no last run.
    expect(dot('t00001')?.classList.contains('live')).toBe(true);
    expect(line('t00001')).toMatch(/^in \d+h/);
    expect(line('t00001')).toContain('→ Topic ' + A);

    // Running: the blue pulsing dot, the row's own running class (what colours "running now"),
    // and the words themselves.
    expect(dot('t00002')?.classList.contains('running')).toBe(true);
    expect(row('t00002').classList.contains('running')).toBe(true);
    expect(line('t00002')).toContain('running now');

    // Paused and done: grey dot, the state word, and the title dimmed like an idle row.
    expect(dot('t00003')?.className).toBe('topic-dot');
    expect(line('t00003')).toContain('paused');
    expect(row('t00003').classList.contains('idle')).toBe(true);
    expect(row('t00006').classList.contains('idle')).toBe(true);

    // A failed last run: the red dot and a red last-run segment.
    expect(dot('t00004')?.classList.contains('failed')).toBe(true);
    expect(line('t00004')).toContain('last failed');
    expect(row('t00004').querySelector('.sched-last')?.classList.contains('bad')).toBe(true);

    // Tags are on the line as #tag.
    expect(line('t00005')).toContain('#ci');
    expect(line('t00005')).toContain('#ops');
  });

  it('draws the selected scheduled run' + "'s title white, as the topic list does", () => {
    const html = renderPage('Chat', false);
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    // The old .sess-item.on .sess-title rule went with the row; this is the shared one that
    // replaces it. The topic list's own selected-idle greys are id-scoped and still win there.
    expect(css).toContain('.topic-item.on .topic-title{color:#fff}');
  });

  it('keeps its menu through a poll, and closes it when the task goes', async () => {
    const replies: Record<string, unknown> = {
      'api/schedules': listReply([task(), task({ id: 'b2c3d4', name: 'Other task' })]),
    };
    // The 30s poll is shortened to 30ms, which is the repaint an open menu has to survive.
    const h = await open({ replies, shortenLong: true });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await taskMenu(h, 'a1b2c3');
    const menu = h.el('row-menu');
    const first = h.doc.querySelector('[data-rm="task:a1b2c3"]');

    await within('a repaint', 1000, () => h.doc.querySelector('[data-rm="task:a1b2c3"]') !== first);
    expect(menu.hidden).toBe(false);
    expect(h.doc.querySelector('[data-rm="task:a1b2c3"]')?.getAttribute('aria-expanded')).toBe('true');

    // The task leaving the daemon's list leaves the menu with nothing to act on.
    replies['api/schedules'] = listReply([task({ id: 'b2c3d4', name: 'Other task' })]);
    await within('the task to go', 1000, () => h.doc.querySelector('[data-rm="task:a1b2c3"]') === null);
    expect(menu.hidden).toBe(true);
  });

  it('divides the side panel into Scheduled and Reviews outer tabs, with Tasks and Sessions sub-tabs', async () => {
    const replies = {
      'api/schedules': listReply([task()]),
      'api/reviews': { reviews: [] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');

    // Outer tabs at the foot
    expect(h.el('sched-tab-scheduled').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-tab-scheduled').classList.contains('on')).toBe(true);
    expect(h.el('sched-tab-reviews').getAttribute('aria-selected')).toBe('false');
    expect(h.el('sched-tab-reviews').classList.contains('on')).toBe(false);

    // Sub-tabs under the header
    expect(h.el('sched-subnav').hidden).toBe(false);
    expect(h.el('sched-tab-tasks').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-tab-tasks').classList.contains('on')).toBe(true);
    expect(h.el('sched-tab-sessions').getAttribute('aria-selected')).toBe('false');
    expect(h.el('sched-tab-sessions').classList.contains('on')).toBe(false);

    // Initial content visibility
    expect(h.el('schedules-list').hidden).toBe(false);
    expect(h.el('sched-sessions').hidden).toBe(true);
    expect(h.el('sched-reviews').hidden).toBe(true);

    // Counts on outer tab and sub-tabs
    expect(h.el('sched-tab-scheduled-n').textContent).toBe('1');
    expect(h.el('sched-tab-tasks-n').textContent).toBe('1');
    expect(h.el('sched-tab-sessions-n').textContent).toBe('0');
  });

  it('switches between Tasks and Sessions sub-tabs and outer Reviews tab', async () => {
    const C = 'c3d4e5f6';
    const replies = {
      'api/schedules': listReply([task()]),
      'api/reviews': {
        enabled: true,
        reviews: [{
          id: 'rev1',
          title: 'Reviewed Topic',
          at: 1000,
          outcome: 'nothing',
          changes: [],
          preferences: [],
          topic: A,
        }],
      },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 2, stage: 'idle', scheduled: true },
      ],
    });
    await h.click('#schedules-toggle');

    // Both task count and session count are shown on outer Scheduled tab ('1·1'). No spaces
    // around the separator: at the panel's narrowest 220px the two of them pushed the amber
    // dot past the tab's clip edge (measured in Chromium; see page.ts).
    expect(h.el('sched-tab-scheduled-n').textContent).toBe('1·1');
    expect(h.el('sched-tab-tasks-n').textContent).toBe('1');
    expect(h.el('sched-tab-sessions-n').textContent).toBe('1');

    // Switch to Sessions subtab
    await h.click('#sched-tab-sessions');
    expect(h.el('sched-tab-sessions').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-tab-tasks').getAttribute('aria-selected')).toBe('false');
    expect(h.el('sched-sessions').hidden).toBe(false);
    expect(h.el('schedules-list').hidden).toBe(true);
    expect(h.window.localStorage.getItem('aa_sched_subtab')).toBe('sessions');
    expect(h.el('schedules-summary').textContent).toContain('1 session');

    // Switch back to Tasks subtab
    await h.click('#sched-tab-tasks');
    expect(h.el('sched-tab-tasks').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-tab-sessions').getAttribute('aria-selected')).toBe('false');
    expect(h.el('schedules-list').hidden).toBe(false);
    expect(h.el('sched-sessions').hidden).toBe(true);
    expect(h.window.localStorage.getItem('aa_sched_subtab')).toBe('tasks');
    expect(h.el('schedules-summary').textContent).toBe('1 active');

    // Switch to Reviews outer tab: outer Scheduled tab still shows '1·1'
    await h.click('#sched-tab-reviews');
    await until('reviews list', () => h.el('sched-reviews-list').textContent!.includes('Reviewed Topic'));
    expect(h.el('sched-tab-reviews').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-tab-scheduled').getAttribute('aria-selected')).toBe('false');
    expect(h.el('sched-tab-scheduled-n').textContent).toBe('1·1');
    expect(h.el('sched-tab-reviews-n').textContent).toBe('1');
    expect(h.el('sched-subnav').hidden).toBe(true);
    expect(h.el('sched-reviews').hidden).toBe(false);
    expect(h.el('schedules-list').hidden).toBe(true);
    expect(h.el('sched-sessions').hidden).toBe(true);
    expect(h.window.localStorage.getItem('aa_sched_tab')).toBe('reviews');

    // Switch back to Scheduled outer tab
    await h.click('#sched-tab-scheduled');
    expect(h.el('sched-tab-scheduled').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-tab-reviews').getAttribute('aria-selected')).toBe('false');
    expect(h.el('sched-subnav').hidden).toBe(false);
    expect(h.el('sched-reviews').hidden).toBe(true);
    expect(h.el('schedules-list').hidden).toBe(false);
    expect(h.window.localStorage.getItem('aa_sched_tab')).toBe('scheduled');
  });

  it('shows waiting-on-answer amber alert on outer Scheduled tab and Sessions sub-tab', async () => {
    const C = 'c3d4e5f6';
    const replies = {
      'api/schedules': listReply([task()]),
      'api/reviews': { reviews: [] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');

    expect(h.el('sched-alert').hidden).toBe(true);
    expect(h.el('sched-tab-alert').hidden).toBe(true);
    expect(h.el('sched-sessions-alert').hidden).toBe(true);

    // Scheduled run is waiting on answer
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 3, stage: 'answer', asking: true, scheduled: true },
      ],
    });

    expect(h.el('sched-alert').hidden).toBe(false);
    expect(h.el('sched-tab-alert').hidden).toBe(false);
    expect(h.el('sched-sessions-alert').hidden).toBe(false);
    expect(h.el('sched-tab-scheduled').getAttribute('title')).toContain('waiting');
    expect(h.el('sched-tab-sessions').getAttribute('title')).toContain('waiting');

    // Outer alert stays visible even when viewing Reviews tab
    await h.click('#sched-tab-reviews');
    expect(h.el('sched-tab-alert').hidden).toBe(false);

    // Clear waiting state
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 4, stage: 'idle', scheduled: true },
      ],
    });

    expect(h.el('sched-alert').hidden).toBe(true);
    expect(h.el('sched-tab-alert').hidden).toBe(true);
    expect(h.el('sched-sessions-alert').hidden).toBe(true);
  });

  it.each([
    {
      legacyTab: 'sessions',
      expectedTab: 'scheduled',
      expectedSubtab: 'sessions',
      scheduledSelected: 'true',
      reviewsSelected: 'false',
      tasksSelected: 'false',
      sessionsSelected: 'true',
      subnavHidden: false,
      visiblePanel: 'sched-sessions',
    },
    {
      legacyTab: 'tasks',
      expectedTab: 'scheduled',
      expectedSubtab: 'tasks',
      scheduledSelected: 'true',
      reviewsSelected: 'false',
      tasksSelected: 'true',
      sessionsSelected: 'false',
      subnavHidden: false,
      visiblePanel: 'schedules-list',
    },
    {
      legacyTab: 'reviews',
      expectedTab: 'reviews',
      expectedSubtab: 'tasks',
      scheduledSelected: 'false',
      reviewsSelected: 'true',
      tasksSelected: 'false',
      sessionsSelected: 'false',
      subnavHidden: true,
      visiblePanel: 'sched-reviews',
    },
  ] as const)(
    'restores legacy aa_sched_tab = $legacyTab to $expectedTab + $expectedSubtab',
    async ({
      legacyTab,
      scheduledSelected,
      reviewsSelected,
      tasksSelected,
      sessionsSelected,
      subnavHidden,
      visiblePanel,
    }) => {
      const C = 'c3d4e5f6';
      const replies = {
        'api/schedules': listReply([task()]),
        'api/reviews': { enabled: true, reviews: [] },
      };
      const h = await open({
        storage: { aa_sched_tab: legacyTab },
        replies,
      });
      await h.emit(sync(A, [], [A]));
      await h.emit({
        t: 'topics',
        topics: [
          { id: A, title: 'ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
          { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 2, stage: 'idle', scheduled: true },
        ],
      });
      await h.click('#schedules-toggle');

      expect(h.el('sched-tab-scheduled').getAttribute('aria-selected')).toBe(scheduledSelected);
      expect(h.el('sched-tab-reviews').getAttribute('aria-selected')).toBe(reviewsSelected);
      expect(h.el('sched-subnav').hidden).toBe(subnavHidden);
      expect(h.el('sched-tab-tasks').getAttribute('aria-selected')).toBe(tasksSelected);
      expect(h.el('sched-tab-sessions').getAttribute('aria-selected')).toBe(sessionsSelected);
      expect(h.el(visiblePanel).hidden).toBe(false);
    }
  );

  it('stays open across a topic switch and a reload, and a first visit starts closed', async () => {
    const replies = { 'api/schedules': listReply([task()]) };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A, B]));

    // First visit: no stored choice, so the panel is not in the way.
    expect(h.el('app').classList.contains('sched-open')).toBe(false);
    expect(h.window.localStorage.getItem('aa_sched_open')).toBeNull();

    await h.click('#schedules-toggle');
    expect(h.window.localStorage.getItem('aa_sched_open')).toBe('1');

    // Following a topic no longer puts it away.
    await h.click('[data-topic="' + B + '"]');
    expect(h.el('app').classList.contains('sched-open')).toBe(true);

    // What the next page finds: the open choice, not the closed state of some earlier visit.
    const again = await open({ replies, storage: { aa_sched_open: '1' } });
    await again.emit(sync(A, [], [A, B]));
    expect(again.el('app').classList.contains('sched-open')).toBe(true);

    await again.click('#schedules-close');
    expect(again.el('app').classList.contains('sched-open')).toBe(false);
    expect(again.window.localStorage.getItem('aa_sched_open')).toBeNull();
  });

  it('does not restore an open panel where there is nowhere to dock it', async () => {
    const h = await open({ width: 500, storage: { aa_sched_open: '1' } });
    expect(h.el('app').classList.contains('sched-open')).toBe(false);
  });

  it('puts the overlay away after a run, without forgetting it was opened', async () => {
    const C = 'c3d4e5f6';
    const h = await open({ width: 500 });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'an ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 3, stage: 'idle', scheduled: true },
      ],
    });

    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');
    (h.doc.querySelector('.sess-item') as HTMLElement).click();
    await until('the switch', () => h.window.location.search.includes(C));

    // The overlay has to get out of the way of the chat it opened, but that is not the operator
    // closing the panel: the next wide window still opens it.
    expect(h.el('app').classList.contains('sched-open')).toBe(false);
    expect(h.window.localStorage.getItem('aa_sched_open')).toBe('1');
  });

  it('deletes from the task menu, after one confirmation', async () => {
    const replies = {
      'api/schedules': listReply([task()]),
      'api/schedules/op': { ok: true, tasks: [] },
    };
    const h = await open({ replies, confirm: true });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await taskMenu(h, 'a1b2c3');

    // Pause, Run now and Edit, then Delete below its divider: the row's actions are all in here.
    expect(Array.from(h.el('row-menu').querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toEqual([
      'Pause',
      'Run now',
      'Edit',
      'Delete',
    ]);
    expect(h.el('row-menu').querySelector('[role="separator"]')).not.toBeNull();
    expect(h.doc.querySelector('.sched-item')?.querySelector('.topic-item [data-rm]')).not.toBeNull();

    await h.click('[data-rmk="remove"]');
    await until('the delete request', () => h.calls.some((c) => c.path === 'api/schedules/op'));
    expect(h.confirms.at(-1)).toBe('Delete task "Morning CI"?');
    expect(h.calls.find((c) => c.path === 'api/schedules/op')?.body).toEqual({ id: 'a1b2c3', action: 'remove' });
    await until('the empty state', () => h.el('schedules-list').textContent!.includes('No scheduled tasks yet'));
  });

  it('leaves the task alone when the confirmation is cancelled', async () => {
    const replies = {
      'api/schedules': listReply([task()]),
      'api/schedules/op': { ok: true, tasks: [] },
    };
    const h = await open({ replies, confirm: false });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await taskMenu(h, 'a1b2c3');
    await h.click('[data-rmk="remove"]');
    await tick();

    expect(h.confirms.at(-1)).toBe('Delete task "Morning CI"?');
    expect(h.calls.some((c) => c.path === 'api/schedules/op')).toBe(false);
    expect(h.el('schedules-list').textContent).toContain('Morning CI');
  });

  it.each([
    { state: 'active', key: 'pause', action: 'pause' },
    { state: 'paused', key: 'resume', action: 'resume' },
    { state: 'active', key: 'run', action: 'run' },
  ])('sends $action from the task menu', async ({ state, key, action }) => {
    const replies = {
      'api/schedules': listReply([task({ state })]),
      'api/schedules/op': { ok: true, tasks: [task({ state })] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await taskMenu(h, 'a1b2c3');
    await h.click(`[data-rmk="${key}"]`);
    await until('the op', () => h.calls.some((c) => c.path === 'api/schedules/op'));

    expect(h.calls.find((c) => c.path === 'api/schedules/op')?.body).toEqual({ id: 'a1b2c3', action });
    expect(h.el('row-menu').hidden).toBe(true);
  });

  it('greys Run now while a run is in flight, and says why', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task({ running: true })]) } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await taskMenu(h, 'a1b2c3');

    const run = h.doc.querySelector<HTMLButtonElement>('[data-rmk="run"]')!;
    expect(run.disabled).toBe(true);
    expect(run.title).toMatch(/run is in progress/);
  });

  it('shows the daemon sentence when an action is refused, and keeps the list', async () => {
    const replies = {
      'api/schedules': listReply([task()]),
      'api/schedules/op': { ok: false, error: '#a1b2c3 is already paused' },
    };
    const h = await open({ replies, status: { 'api/schedules/op': 400 } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await taskMenu(h, 'a1b2c3');

    await h.click('[data-rmk="pause"]');
    await until('the refusal', () => !h.el('schedules-note').hidden);

    expect(h.el('schedules-note').textContent).toBe('#a1b2c3 is already paused');
    expect(h.el('schedules-list').textContent).toContain('Morning CI');
  });

  it("opens the task's page on a tap, without treating the tap as an action", async () => {
    const h = await open({
      replies: { 'api/schedules': listReply([task()]), [TASK_URL]: pageReply(detail()) },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    expect(h.el('task-page').hidden).toBe(true);

    (h.doc.querySelector('.sched-item') as HTMLElement).click();
    await until("the task's page", () => h.el('task-view').textContent!.includes('summarise the failures'));

    expect(h.el('task-page').hidden).toBe(false);
    expect(h.el('task-title').textContent).toBe('Morning CI');
    expect(h.calls.some((c) => c.path === TASK_URL)).toBe(true);
    // The page names the target in full, as the hover card does, resolved to the topic's title.
    expect(h.el('task-view').textContent).toContain('Posts to');
    expect(h.el('task-view').textContent).toContain('Topic ' + A);
    expect(h.el('task-view').textContent).toContain('/srv/app');
    expect(h.calls.some((c) => c.path === 'api/schedules/op')).toBe(false);

    await h.click('#task-close');
    expect(h.el('task-page').hidden).toBe(true);
  });

  it('opens a task from the keyboard, and Space does not scroll the page', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task()]), [TASK_URL]: pageReply(detail()) } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    const row = h.doc.querySelector('.sched-item .topic-item') as HTMLElement;
    const press = (target: HTMLElement, key: string): KeyboardEvent => {
      const ev = new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      return ev;
    };

    // The row says role=button, so Enter and Space do what a click does — and Space is not left
    // to the browser's scroll.
    expect(press(row, 'Enter').defaultPrevented).toBe(true);
    await tick();
    expect(h.el('task-page').hidden).toBe(false);
    await h.click('#task-close');
    expect(press(row, ' ').defaultPrevented).toBe(true);
    await tick();
    expect(h.el('task-page').hidden).toBe(false);
    await h.click('#task-close');

    // The ⋯ is its own control: Enter on it must not also open the page.
    press(h.doc.querySelector('[data-rm="task:a1b2c3"]') as HTMLElement, 'Enter');
    await tick();
    expect(h.el('task-page').hidden).toBe(true);
  });

  it('lets Enter on a tag' + "'s × delete the tag, on the task's page", async () => {
    const replies = {
      'api/schedules': listReply([task({ tags: ['ci'] })]),
      'api/schedules/op': { ok: true, tasks: [task({ tags: [] })] },
      [TASK_URL]: pageReply(detail({ task: task({ tags: ['ci'] }) })),
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    (h.doc.querySelector('.sched-item') as HTMLElement).click();
    await until('the chip', () => h.doc.querySelector('#task-view [data-tag-del="ci"]') !== null);

    const del = h.doc.querySelector('#task-view [data-tag-del="ci"]') as HTMLElement;
    del.focus();
    // A browser turns Enter on a focused button into a click unless the keydown was cancelled;
    // jsdom performs no default actions, so the test does that step itself.
    const ev = new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    const live = del.dispatchEvent(ev);
    expect(live).toBe(true);
    if (live) del.click();
    await until('the tags request', () => h.calls.some((c) => c.path === 'api/schedules/op'));

    expect(h.calls.find((c) => c.path === 'api/schedules/op')?.body).toEqual({ id: 'a1b2c3', action: 'tags', tags: [] });
    await until('no chip', () => h.doc.querySelectorAll('#task-view .sched-tag').length === 0);
    expect(h.el('task-page').hidden).toBe(false);
  });

  /** Open the panel and the task's page, and wait for the detail to be drawn. */
  const openTaskPage = async (h: Harness, topics?: Array<Record<string, unknown>>): Promise<void> => {
    await h.emit(sync(A, [], [A]));
    if (topics) await h.emit({ t: 'topics', topics });
    await h.click('#schedules-toggle');
    (h.doc.querySelector('.sched-item') as HTMLElement).click();
    await until("the task's page", () => h.el('task-view').querySelector('.tp-acts') !== null);
  };
  const setField = (h: Harness, id: string, value: string): void => {
    const el = h.el(id) as HTMLInputElement;
    el.value = value;
    el.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  };

  it('lists the topics its runs opened, and every run with where its output went', async () => {
    const R1 = 'c3d4e5f6';
    const R2 = 'd4e5f6a7';
    const OLD = 'e5f6a7b8';
    const runs = [
      { at: 3, atText: '2026-11-16 08:00', status: 'ok', durationMs: 42_000, topic: R1 },
      { at: 2, atText: '2026-11-15 08:00', status: 'failed', error: 'the harness exited mid-turn', topic: OLD },
      { at: 1, atText: '2026-11-14 08:00', status: 'missed', error: 'the gateway was down' },
      { at: 0, atText: '2026-11-13 08:00', status: 'ok', where: 'tg:-100/7' },
      { at: -1, atText: '2026-11-12 08:00', status: 'ok', topic: 'f6a7b8c9' },
    ];
    const h = await open({ replies: { 'api/schedules': listReply([task()]), [TASK_URL]: pageReply(detail({ runs })) } });
    await openTaskPage(h, [
      { id: A, title: 'an ordinary topic', lastAt: 1000, msgCount: 1, stage: 'idle' },
      // Marked with the task: listed even though no recorded run names it.
      { id: R2, title: '[cc] ⏰ Morning CI · 2026-11-01 08:00', lastAt: 500, msgCount: 2, stage: 'idle', scheduled: true, task: 'a1b2c3', agent: { id: 'cc', harness: 'claude' } },
      { id: R1, title: '[cc] ⏰ Morning CI · 2026-11-16 08:00', lastAt: 900, msgCount: 4, stage: 'review', scheduled: true, task: 'a1b2c3' },
      // Opened before topics were marked: found through the run that names it.
      { id: OLD, title: '[cc] ⏰ Morning CI · 2026-11-15 08:00', lastAt: 800, msgCount: 1, stage: 'failed', scheduled: true },
      // Another task's run is not this one's.
      { id: 'a7b8c9d0', title: '[cc] ⏰ Other', lastAt: 700, scheduled: true, task: 'ffff00' },
    ]);

    const sessions = Array.from(h.doc.querySelectorAll('#task-view .tp-sess')).map((n) => n.getAttribute('data-tp-topic'));
    expect(sessions).toEqual([R1, OLD, R2]);
    expect(h.doc.querySelector('#tp-sessions .tp-label')!.textContent).toBe('Sessions3');
    // The rows the switcher draws: the subject on the title line, the agent on the frame — so the
    // agent this list used to leave out altogether (it already cut the tag) is on screen here too.
    const session = (id: string): Element => h.doc.querySelector(`#task-view .tp-sess[data-tp-topic="${id}"]`)!;
    expect(session(R2).querySelector('.topic-title')?.textContent).toBe('⏰ Morning CI · 2026-11-01 08:00');
    expect(session(R2).querySelector('.agent-tag')?.className).toBe('agent-tag h-claude');
    expect(session(R2).querySelector('.agent-tag')?.textContent).toBe('cc');
    expect(session(R1).querySelector('.agent-tag')?.textContent).toBe('cc');
    expect(session(R1).classList.contains('framed')).toBe(true);
    expect(h.doc.querySelector('#tp-sessions .tp-list')?.classList.contains('tp-topics')).toBe(true);
    const rows = Array.from(h.doc.querySelectorAll('#task-view .tp-run')).map((n) => n.textContent);
    expect(rows[0]).toContain('ok · 2026-11-16 08:00 · 42.0s');
    expect(rows[1]).toContain('the harness exited mid-turn');
    expect(rows[2]).toContain('missed');
    expect(rows[3]).toContain('tg:-100/7');
    // A run whose topic this page no longer has says so, rather than offering a dead link.
    expect(rows[4]).toContain('topic gone');
    expect(h.doc.querySelectorAll('#task-view .tp-run-open')).toHaveLength(2);

    // A run's Open and a session row both go to the topic, and put the page away.
    await h.click(`#task-view .tp-run-open[data-tp-topic="${R1}"]`);
    expect(h.el('task-page').hidden).toBe(true);
    expect(h.window.location.search).toContain(R1);
  });

  it('follows the topic list while open: a new run topic appears among the sessions', async () => {
    const R1 = 'c3d4e5f6';
    const h = await open({ replies: { 'api/schedules': listReply([task()]), [TASK_URL]: pageReply(detail()) } });
    await openTaskPage(h);
    expect(h.doc.querySelectorAll('#task-view .tp-sess')).toHaveLength(0);
    expect(h.el('task-view').textContent).toContain('None on this page yet');

    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'an ordinary topic', lastAt: 1000, msgCount: 1, stage: 'idle' },
        { id: R1, title: '[cc] ⏰ Morning CI · now', lastAt: 1200, msgCount: 1, stage: 'working', running: true, scheduled: true, task: 'a1b2c3' },
      ],
    });
    const row = h.doc.querySelector(`#task-view .tp-sess[data-tp-topic="${R1}"]`) as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('running');

    // Enter on a session row opens it, as a click does.
    row.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick();
    expect(h.el('task-page').hidden).toBe(true);
    expect(h.window.location.search).toContain(R1);
  });

  it('edits in place: the form holds the raw values, and Save sends only what changed', async () => {
    const saved = detail({ fields: { ...(detail().fields as object), prompt: 'summarise the failures and the flakes' } });
    delete (saved.fields as Record<string, unknown>).cwd;
    const replies = {
      'api/schedules': listReply([task()]),
      [TASK_URL]: pageReply(detail()),
      'api/schedules/edit': { ok: true, detail: saved, tasks: [task({ detail: 'summarise the failures and the flakes' })] },
    };
    const h = await open({ replies });
    await openTaskPage(h);
    await h.click('#task-view [data-tp-act="edit"]');

    expect((h.el('tp-name') as HTMLInputElement).value).toBe('Morning CI');
    expect((h.el('tp-cron') as HTMLInputElement).value).toBe('0 8 * * *');
    expect((h.el('tp-tz') as HTMLInputElement).value).toBe('Asia/Shanghai');
    expect((h.el('tp-text') as HTMLTextAreaElement).value).toBe('summarise the failures');
    expect((h.el('tp-agent') as HTMLSelectElement).value).toBe('cc');
    expect(Array.from((h.el('tp-agent') as HTMLSelectElement).options).map((o) => o.value)).toEqual(['cc', 'oc']);
    expect((h.el('tp-model') as HTMLInputElement).value).toBe('m1');
    expect((h.el('tp-cwd') as HTMLInputElement).value).toBe('/srv/app');
    // What the task is, how it runs and where it posts are on the form too, set to the task's own.
    expect(h.doc.querySelector('[data-tp-kind="agent"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(h.doc.querySelector('[data-tp-session="new"]')!.getAttribute('aria-pressed')).toBe('true');
    expect((h.el('tp-target') as HTMLSelectElement).value).toBe('topic:' + A);
    expect(shownField(h, 'tp-host')).toBe(false);
    expect(shownField(h, 'tp-timeout')).toBe(false);

    setField(h, 'tp-text', 'summarise the failures and the flakes');
    setField(h, 'tp-cwd', '');
    await h.click('#task-view [data-tp-act="save"]');
    await until('the edit request', () => h.calls.some((c) => c.path === 'api/schedules/edit'));

    expect(h.calls.find((c) => c.path === 'api/schedules/edit')?.body).toEqual({
      id: 'a1b2c3',
      edit: { prompt: 'summarise the failures and the flakes', cwd: null },
    });
    await until('the view again', () => h.el('task-view').querySelector('#tp-form') === null);
    expect(h.el('task-view').textContent).toContain('summarise the failures and the flakes');
    expect(h.el('task-view').textContent).not.toContain('/srv/app');
    expect(h.el('task-note').className).toBe('ok');
    // The list behind the page took the same answer.
    expect((h.doc.querySelector('.sched-item .topic-item') as HTMLElement).getAttribute('title')).toBeTruthy();
  });

  it('keeps the form and says the refusal when the daemon will not take the edit', async () => {
    const replies = {
      'api/schedules': listReply([task()]),
      [TASK_URL]: pageReply(detail()),
      'api/schedules/edit': { ok: false, error: '--cron: Invalid cron expression' },
    };
    const h = await open({ replies, status: { 'api/schedules/edit': 400 } });
    await openTaskPage(h);
    await h.click('#task-view [data-tp-act="edit"]');
    setField(h, 'tp-cron', '0 25 * * *');
    await h.click('#task-view [data-tp-act="save"]');
    await until('the refusal', () => !h.el('task-note').hidden);

    expect(h.calls.find((c) => c.path === 'api/schedules/edit')?.body).toEqual({ id: 'a1b2c3', edit: { cron: '0 25 * * *' } });
    expect(h.el('task-note').textContent).toBe('--cron: Invalid cron expression');
    expect(h.el('task-note').className).toBe('error');
    expect((h.el('tp-cron') as HTMLInputElement).value).toBe('0 25 * * *');
    expect((h.doc.querySelector('[data-tp-act="save"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends nothing when nothing changed, and refuses a timeout that is not a length of time', async () => {
    const bash = detail({
      task: task({ kind: 'bash', run: 'bash · 10m', detail: 'pg_dump app' }),
      fields: { name: 'Backup', cron: '0 2 * * *', tz: 'Asia/Shanghai', command: 'pg_dump app', timeoutMs: 600_000, target: 'web:main/' + A },
    });
    const h = await open({ replies: { 'api/schedules': listReply([task({ kind: 'bash' })]), [TASK_URL]: pageReply(bash) } });
    await openTaskPage(h);
    await h.click('#task-view [data-tp-act="edit"]');

    // A bash task: a command, a machine and a timeout, no agent or model to choose.
    expect((h.el('tp-text') as HTMLTextAreaElement).value).toBe('pg_dump app');
    expect((h.el('tp-timeout') as HTMLInputElement).value).toBe('10m');
    expect((h.el('tp-host') as HTMLSelectElement).value).toBe('');
    expect(shownField(h, 'tp-host')).toBe(true);
    expect(shownField(h, 'tp-agent')).toBe(false);
    expect(shownField(h, 'tp-model')).toBe(false);
    expect(h.el('tp-text-label').textContent).toBe('Command');

    await h.click('#task-view [data-tp-act="save"]');
    expect(h.calls.some((c) => c.path === 'api/schedules/edit')).toBe(false);
    expect(h.el('task-note').textContent).toBe('Nothing was changed.');

    await h.click('#task-view [data-tp-act="edit"]');
    setField(h, 'tp-timeout', 'soon');
    await h.click('#task-view [data-tp-act="save"]');
    expect(h.el('task-note').textContent).toContain('90s, 10m or 1h');
    expect(h.calls.some((c) => c.path === 'api/schedules/edit')).toBe(false);
    setField(h, 'tp-timeout', '90s');
    await h.click('#task-view [data-tp-act="save"]');
    await until('the edit request', () => h.calls.some((c) => c.path === 'api/schedules/edit'));
    expect(h.calls.find((c) => c.path === 'api/schedules/edit')?.body).toEqual({ id: 'a1b2c3', edit: { timeoutMs: 90_000 } });
  });

  it('switches a task to one run, and sends the time again when the zone changes', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task()]), [TASK_URL]: pageReply(detail()) } });
    await openTaskPage(h);
    await h.click('#task-view [data-tp-act="edit"]');

    expect(h.el('tp-at').hidden).toBe(true);
    await h.click('#task-view [data-tp-when="at"]');
    expect(h.el('tp-at').hidden).toBe(false);
    expect(h.el('tp-cron').hidden).toBe(true);
    setField(h, 'tp-at', '2026-11-20T09:30');
    await h.click('#task-view [data-tp-act="save"]');
    await until('the edit request', () => h.calls.some((c) => c.path === 'api/schedules/edit'));
    expect(h.calls.find((c) => c.path === 'api/schedules/edit')?.body).toEqual({ id: 'a1b2c3', edit: { at: '2026-11-20 09:30' } });

    // A one-time task whose zone changes sends its time with it, so the time is read in the new zone.
    const once = detail({ fields: { ...(detail().fields as object), cron: undefined, at: '2026-11-20 09:30' } });
    const r = await open({ replies: { 'api/schedules': listReply([task()]), [TASK_URL]: pageReply(once) } });
    await openTaskPage(r);
    await r.click('#task-view [data-tp-act="edit"]');
    expect((r.el('tp-at') as HTMLInputElement).value).toBe('2026-11-20T09:30');
    setField(r, 'tp-tz', 'Europe/Berlin');
    await r.click('#task-view [data-tp-act="save"]');
    await until('the edit request', () => r.calls.some((c) => c.path === 'api/schedules/edit'));
    expect(r.calls.find((c) => c.path === 'api/schedules/edit')?.body).toEqual({
      id: 'a1b2c3',
      edit: { tz: 'Europe/Berlin', at: '2026-11-20 09:30' },
    });
  });

  it('shows only what the shape keeps: a fixed session has no directory or model, a daily one no one-shot switch', async () => {
    const fixed = detail({
      fields: { name: 'Morning CI', cron: '0 8 * * *', tz: 'Asia/Shanghai', prompt: 'p', agent: 'cc', session: 'fixed', target: 'web:main/' + A },
    });
    const h = await open({ replies: { 'api/schedules': listReply([task()]), [TASK_URL]: pageReply(fixed) } });
    await openTaskPage(h);
    await h.click('#task-view [data-tp-act="edit"]');
    expect(shownField(h, 'tp-model')).toBe(false);
    expect(shownField(h, 'tp-cwd')).toBe(false);
    expect(shownField(h, 'tp-agent')).toBe(true);
    expect(h.el('tp-session-hint').textContent).toContain('/cd and /model there');

    const daily = detail({ fields: { ...(detail().fields as object), session: 'daily' } });
    const r = await open({ replies: { 'api/schedules': listReply([task()]), [TASK_URL]: pageReply(daily) } });
    await openTaskPage(r);
    await r.click('#task-view [data-tp-act="edit"]');
    expect((r.doc.querySelector('.tp-when') as HTMLElement).hidden).toBe(true);
    expect(shownField(r, 'tp-model')).toBe(true);
  });

  it('has no Edit on a task that is over, and says why', async () => {
    const over = detail({ task: task({ state: 'expired' }), locked: '#a1b2c3 has expired (a fixed-session task lives 24h); add a new task instead' });
    const h = await open({ replies: { 'api/schedules': listReply([task({ state: 'expired' })]), [TASK_URL]: pageReply(over) } });
    await openTaskPage(h);
    expect(h.doc.querySelector('[data-tp-act="edit"]')).toBeNull();
    expect(h.el('task-view').textContent).toContain('has expired');
  });

  it('opens on the form from the row menu, and asks before throwing away changes', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task()]), [TASK_URL]: pageReply(detail()) }, confirm: false });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await taskMenu(h, 'a1b2c3');
    await h.click('[data-rmk="edit"]');
    await until('the form', () => h.doc.getElementById('tp-name') !== null);
    expect(h.doc.activeElement).toBe(h.el('tp-name'));

    // Untouched: closes without asking.
    await h.click('#task-close');
    expect(h.el('task-page').hidden).toBe(true);
    expect(h.confirms).toEqual([]);

    await taskMenu(h, 'a1b2c3');
    await h.click('[data-rmk="edit"]');
    await until('the form', () => h.doc.getElementById('tp-name') !== null);
    setField(h, 'tp-name', 'Renamed');
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    // Refused: still open, still holding the change, and the panel behind it is not closed either.
    expect(h.confirms).toEqual(['Discard your changes to this task?']);
    expect(h.el('task-page').hidden).toBe(false);
    expect((h.el('tp-name') as HTMLInputElement).value).toBe('Renamed');
    expect(h.el('app').classList.contains('sched-open')).toBe(true);
  });

  /** Pick an option of a select, as a person does: the value, then the change event the form follows. */
  const choose = (h: Harness, id: string, value: string): void => {
    const el = h.el(id) as HTMLSelectElement;
    el.value = value;
    el.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  };
  const lastBody = (h: Harness, path: string): unknown => h.calls.filter((c) => c.path === path).at(-1)?.body;
  /** Open the new-task form from the Tasks tab's +, and wait for the daemon's choices to fill it. */
  const openNewTask = async (h: Harness): Promise<void> => {
    await h.emit(sync(A, [], [A, B]));
    await h.click('#schedules-toggle');
    await h.click('#sched-new');
    await until('the new-task form', () => h.doc.getElementById('tp-form') !== null);
  };

  it('adds a task from the Tasks tab: the form starts from the daemon\'s defaults, and Add sends schedule add\'s fields', async () => {
    const made = task({ id: 'b2c3d4', name: 'Nightly', detail: 'check the nightly build' });
    const added = detail({ task: made, fields: { ...(detail().fields as object), name: 'Nightly', prompt: 'check the nightly build' } });
    const replies = {
      'api/schedules': listReply([task()]),
      'api/schedules/form': { ok: true, form: formContext() },
      'api/schedules/add': { ok: true, detail: added, tasks: [task(), made] },
    };
    const h = await open({ replies });
    await openNewTask(h);

    expect(h.el('task-title').textContent).toBe('New task');
    // The daemon's defaults: its zone, its routing agent, a new session — and the topic on screen.
    expect((h.el('tp-tz') as HTMLInputElement).value).toBe('Asia/Shanghai');
    expect((h.el('tp-agent') as HTMLSelectElement).value).toBe('cc');
    expect(h.doc.querySelector('[data-tp-kind="agent"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(h.doc.querySelector('[data-tp-session="new"]')!.getAttribute('aria-pressed')).toBe('true');
    expect((h.el('tp-target') as HTMLSelectElement).value).toBe('topic:' + A);
    // This page's topics by title, and any other place by the id fleetherd channels prints.
    expect(Array.from((h.el('tp-target') as HTMLSelectElement).options).map((o) => o.value)).toEqual(['topic:' + A, 'topic:' + B, 'other']);
    expect(Array.from(h.doc.querySelectorAll('#tp-chans option')).map((o) => o.getAttribute('value'))).toEqual(['tg:-100/7']);
    expect(h.el('task-view').querySelector('[data-tp-act="save"]')!.textContent).toBe('Add');

    setField(h, 'tp-name', 'Nightly');
    setField(h, 'tp-text', 'check the nightly build');
    setField(h, 'tp-cron', '0 3 * * *');
    setField(h, 'tp-tags', 'ci, Nightly');
    await h.click('#task-view [data-tp-act="save"]');
    await until('the add request', () => h.calls.some((c) => c.path === 'api/schedules/add'));

    expect(lastBody(h, 'api/schedules/add')).toEqual({
      task: {
        name: 'Nightly',
        tz: 'Asia/Shanghai',
        cron: '0 3 * * *',
        prompt: 'check the nightly build',
        session: 'new',
        agent: 'cc',
        target: { topic: A },
        tags: ['ci', 'Nightly'],
      },
    });
    // The answer is the new task's page, and the list behind it took the same answer.
    await until('the task page', () => h.el('task-view').querySelector('#tp-form') === null);
    expect(h.el('task-title').textContent).toBe('Nightly');
    expect(h.el('task-note').className).toBe('ok');
    expect(h.el('schedules-list').textContent).toContain('Nightly');
  });

  it('offers + on the Tasks tab only', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task()]) } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    expect(h.el('sched-new').hidden).toBe(false);
    await h.click('#sched-tab-sessions');
    expect(h.el('sched-new').hidden).toBe(true);
    await h.click('#sched-tab-tasks');
    await h.click('#sched-tab-reviews');
    expect(h.el('sched-new').hidden).toBe(true);
  });

  it('a new bash task: the form turns to a command, its machine and its timeout, and keeps the refusal on screen', async () => {
    const replies = {
      'api/schedules': listReply([task()]),
      'api/schedules/form': { ok: true, form: formContext() },
      'api/schedules/add': { ok: false, error: '--cron: "0 3 * *" is not a 5-field cron expression (minute hour day month weekday)' },
    };
    const h = await open({ replies, status: { 'api/schedules/add': 400 } });
    await openNewTask(h);

    await h.click('#task-view [data-tp-kind="bash"]');
    expect(h.el('tp-text-label').textContent).toBe('Command');
    expect(shownField(h, 'tp-agent')).toBe(false);
    expect(shownField(h, 'tp-model')).toBe(false);
    expect(shownField(h, 'tp-host')).toBe(true);
    expect(shownField(h, 'tp-timeout')).toBe(true);
    expect((h.doc.querySelector('[data-tp-kinded="agent"]') as HTMLElement).hidden).toBe(true);
    expect(h.el('tp-cwd-hint').textContent).toContain("the gateway’s machine");
    choose(h, 'tp-host', 'box');
    expect(h.el('tp-cwd-hint').textContent).toContain('on box');

    setField(h, 'tp-text', 'df -h');
    setField(h, 'tp-cron', '0 3 * *');
    setField(h, 'tp-timeout', '90s');
    setField(h, 'tp-cwd', '/srv');
    await h.click('#task-view [data-tp-act="save"]');
    await until('the refusal', () => !h.el('task-note').hidden);

    expect(lastBody(h, 'api/schedules/add')).toEqual({
      task: { tz: 'Asia/Shanghai', cron: '0 3 * *', command: 'df -h', host: 'box', cwd: '/srv', timeoutMs: 90_000, target: { topic: A } },
    });
    // The daemon's sentence, and the form as it was typed.
    expect(h.el('task-note').textContent).toContain('is not a 5-field cron expression');
    expect(h.el('task-note').className).toBe('error');
    expect((h.el('tp-cron') as HTMLInputElement).value).toBe('0 3 * *');
    expect(h.el('task-title').textContent).toBe('New task');
  });

  it('a new task: Cancel closes it, and asks first only once something was typed', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task()]), 'api/schedules/form': { ok: true, form: formContext() } }, confirm: false });
    await openNewTask(h);
    await h.click('#task-view [data-tp-act="cancel"]');
    expect(h.el('task-page').hidden).toBe(true);
    expect(h.confirms).toEqual([]);

    await h.click('#sched-new');
    await until('the new-task form', () => h.doc.getElementById('tp-form') !== null);
    setField(h, 'tp-text', 'half a prompt');
    await h.click('#task-view [data-tp-act="cancel"]');
    expect(h.confirms).toEqual(['Discard this new task?']);
    expect(h.el('task-page').hidden).toBe(false);
  });

  it('turns a prompt task into a command, on the machine its agent ran on', async () => {
    const onBox = detail({ fields: { ...(detail().fields as object), agent: 'oc' } });
    const h = await open({ replies: { 'api/schedules': listReply([task()]), [TASK_URL]: pageReply(onBox) } });
    await openTaskPage(h);
    await h.click('#task-view [data-tp-act="edit"]');
    expect(h.el('task-view').textContent).toContain('keeps its id, tags and run history');

    await h.click('#task-view [data-tp-kind="bash"]');
    expect((h.el('tp-host') as HTMLSelectElement).value).toBe('box');
    expect(shownField(h, 'tp-agent')).toBe(false);
    expect(shownField(h, 'tp-cwd')).toBe(true);
    setField(h, 'tp-text', 'make check');
    await h.click('#task-view [data-tp-act="save"]');
    await until('the edit request', () => h.calls.some((c) => c.path === 'api/schedules/edit'));
    // What the new kind runs with is sent; the directory it keeps is left to the daemon.
    expect(lastBody(h, 'api/schedules/edit')).toEqual({ id: 'a1b2c3', edit: { command: 'make check', host: 'box' } });
  });

  it('turns a command into a prompt task, sending the agent and session it will run with', async () => {
    const bash = detail({
      task: task({ kind: 'bash', run: 'bash · 10m', detail: 'pg_dump app' }),
      fields: { name: 'Backup', cron: '0 2 * * *', tz: 'Asia/Shanghai', command: 'pg_dump app', timeoutMs: 600_000, host: 'box', target: 'web:main/' + A },
    });
    const h = await open({ replies: { 'api/schedules': listReply([task({ kind: 'bash' })]), [TASK_URL]: pageReply(bash) } });
    await openTaskPage(h);
    await h.click('#task-view [data-tp-act="edit"]');
    expect((h.el('tp-host') as HTMLSelectElement).value).toBe('box');

    await h.click('#task-view [data-tp-kind="agent"]');
    await h.click('#task-view [data-tp-session="daily"]');
    expect(shownField(h, 'tp-host')).toBe(false);
    expect(shownField(h, 'tp-timeout')).toBe(false);
    setField(h, 'tp-text', 'summarise the backup log');
    await h.click('#task-view [data-tp-act="save"]');
    await until('the edit request', () => h.calls.some((c) => c.path === 'api/schedules/edit'));
    expect(lastBody(h, 'api/schedules/edit')).toEqual({
      id: 'a1b2c3',
      edit: { prompt: 'summarise the backup log', session: 'daily', agent: 'cc' },
    });
  });

  it('changes the session, and leaves what the new one does not keep to the daemon', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task()]), [TASK_URL]: pageReply(detail()) } });
    await openTaskPage(h);
    await h.click('#task-view [data-tp-act="edit"]');
    await h.click('#task-view [data-tp-when="at"]');
    setField(h, 'tp-at', '2026-11-20T09:30');

    // Daily takes no one-shot: the switch goes, and the time goes back to the cron.
    await h.click('#task-view [data-tp-session="daily"]');
    expect((h.doc.querySelector('.tp-when') as HTMLElement).hidden).toBe(true);
    expect(h.el('tp-at').hidden).toBe(true);
    expect(h.el('tp-cron').hidden).toBe(false);

    await h.click('#task-view [data-tp-session="fixed"]');
    expect(shownField(h, 'tp-model')).toBe(false);
    expect(shownField(h, 'tp-cwd')).toBe(false);
    await h.click('#task-view [data-tp-act="save"]');
    await until('the edit request', () => h.calls.some((c) => c.path === 'api/schedules/edit'));
    // The model and the directory are not sent: a fixed session keeps neither, and the daemon drops them.
    expect(lastBody(h, 'api/schedules/edit')).toEqual({ id: 'a1b2c3', edit: { session: 'fixed' } });
  });

  it('moves a task to another topic of the page, or to a place fleetherd channels lists, and edits its tags', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task({ tags: ['ci'] })]), [TASK_URL]: pageReply(detail({ task: task({ tags: ['ci'] }) })) } });
    await h.emit(sync(A, [], [A, B]));
    await h.click('#schedules-toggle');
    (h.doc.querySelector('.sched-item') as HTMLElement).click();
    await until("the task's page", () => h.el('task-view').querySelector('.tp-acts') !== null);
    await h.click('#task-view [data-tp-act="edit"]');
    expect((h.el('tp-tags') as HTMLInputElement).value).toBe('ci');

    choose(h, 'tp-target', 'topic:' + B);
    setField(h, 'tp-tags', 'ci, ops');
    await h.click('#task-view [data-tp-act="save"]');
    await until('the edit request', () => h.calls.some((c) => c.path === 'api/schedules/edit'));
    expect(lastBody(h, 'api/schedules/edit')).toEqual({ id: 'a1b2c3', edit: { target: { topic: B }, tags: ['ci', 'ops'] } });

    // Another chat: the id field appears, and an empty one is said rather than sent.
    const before = h.calls.length;
    choose(h, 'tp-target', 'other');
    expect(h.el('tp-target-other').hidden).toBe(false);
    await h.click('#task-view [data-tp-act="save"]');
    expect(h.el('task-note').textContent).toContain('Say where it posts');
    expect(h.calls.length).toBe(before);
    setField(h, 'tp-target-other', 'tg:-100/7');
    await h.click('#task-view [data-tp-act="save"]');
    await until('the second edit', () => h.calls.filter((c) => c.path === 'api/schedules/edit').length === 2);
    expect(lastBody(h, 'api/schedules/edit')).toEqual({ id: 'a1b2c3', edit: { target: { channel: 'tg:-100/7' }, tags: ['ci', 'ops'] } });
  });

  it('a task posting elsewhere starts on Another chat with its id, and is not moved by saving something else', async () => {
    const elsewhere = task({ target: 'tg:-100/7', targetTopic: undefined });
    const away = detail({ task: elsewhere, fields: { ...(detail().fields as object), target: 'tg:-100/7' } });
    const h = await open({ replies: { 'api/schedules': listReply([elsewhere]), [TASK_URL]: pageReply(away) } });
    await openTaskPage(h);
    await h.click('#task-view [data-tp-act="edit"]');
    expect((h.el('tp-target') as HTMLSelectElement).value).toBe('other');
    expect((h.el('tp-target-other') as HTMLInputElement).value).toBe('tg:-100/7');
    setField(h, 'tp-name', 'Renamed');
    await h.click('#task-view [data-tp-act="save"]');
    await until('the edit request', () => h.calls.some((c) => c.path === 'api/schedules/edit'));
    expect(lastBody(h, 'api/schedules/edit')).toEqual({ id: 'a1b2c3', edit: { name: 'Renamed' } });
  });

  it('goes when its task goes, and reads the detail again when a run ends', async () => {
    const replies: Record<string, unknown> = { 'api/schedules': listReply([task()]), [TASK_URL]: pageReply(detail()) };
    const h = await open({ replies, shortenLong: true });
    await openTaskPage(h);
    const reads = (): number => h.calls.filter((c) => c.path === TASK_URL).length;
    const first = reads();

    replies['api/schedules'] = listReply([task({ runs: 3, last: { at: 5, atText: 'x', status: 'ok' } })]);
    await within('a second read of the detail', 1000, () => reads() > first);

    replies['api/schedules'] = listReply([]);
    await within('the page to close', 1000, () => h.el('task-page').hidden);
  });

  it('pauses, runs and deletes from its page, through the same operation the menu uses', async () => {
    const replies = {
      'api/schedules': listReply([task()]),
      [TASK_URL]: pageReply(detail()),
      'api/schedules/op': { ok: true, tasks: [task({ state: 'paused' })] },
    };
    const h = await open({ replies, confirm: true });
    await openTaskPage(h);
    await h.click('#task-view [data-tp-act="pause"]');
    await until('the op', () => h.calls.some((c) => c.path === 'api/schedules/op'));
    expect(h.calls.find((c) => c.path === 'api/schedules/op')?.body).toEqual({ id: 'a1b2c3', action: 'pause' });
    await until('Resume', () => h.doc.querySelector('#task-view [data-tp-act="resume"]') !== null);
    expect(h.el('task-sub').textContent).toContain('paused');

    await h.click('#task-view [data-tp-act="remove"]');
    expect(h.confirms.at(-1)).toBe('Delete task "Morning CI"?');
  });

  it('does not open a menu with a separator when the task has no state change', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task({ state: 'expired' })]) } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await taskMenu(h, 'a1b2c3');

    const menu = h.el('row-menu');
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toEqual(['Delete']);
    expect(menu.querySelector('[role="separator"]')).toBeNull();
    expect(menu.firstElementChild?.getAttribute('data-rmk')).toBe('remove');
  });

  it('puts an open task menu away when the panel tab changes or the panel closes', async () => {
    const C = 'c3d4e5f6';
    const replies = {
      'api/schedules': listReply([task()]),
      'api/reviews': { enabled: true, reviews: [] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 3, stage: 'idle', scheduled: true },
      ],
    });
    await h.click('#schedules-toggle');
    const menu = h.el('row-menu');

    await taskMenu(h, 'a1b2c3');
    await h.click('#sched-tab-sessions');
    expect(menu.hidden).toBe(true);

    await h.click(`[data-rm="sess:${C}"]`);
    expect(menu.hidden).toBe(false);
    await h.click('#sched-tab-tasks');
    expect(menu.hidden).toBe(true);

    await taskMenu(h, 'a1b2c3');
    await h.click('#sched-tab-reviews');
    expect(menu.hidden).toBe(true);

    await h.click('#sched-tab-scheduled');
    await taskMenu(h, 'a1b2c3');
    await h.click('#schedules-close');
    expect(menu.hidden).toBe(true);
  });

  it('closes on Escape', async () => {
    const h = await open({ replies: { 'api/schedules': listReply([task()]) } });
    await h.click('#schedules-toggle');
    expect(h.el('app').classList.contains('sched-open')).toBe(true);

    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();

    expect(h.el('app').classList.contains('sched-open')).toBe(false);
    expect(h.window.localStorage.getItem('aa_sched_open')).toBeNull();
  });

  it('closes on the backdrop, which is how a drawer is dismissed on a phone', async () => {
    const h = await open({ width: 390, height: 844, replies: { 'api/schedules': listReply([task()]) } });
    await h.emit(sync(A, [], [A]));

    // Closed, the drawer is off-screen but laid out: inert is what keeps Tab out of it.
    expect(h.el('schedules').hasAttribute('inert')).toBe(true);
    await h.click('#schedules-toggle');
    expect(h.el('app').classList.contains('sched-open')).toBe(true);
    expect(h.el('schedules').hasAttribute('inert')).toBe(false);
    // The panel is a drawer here, so the dimmed chat behind it is the way out — the one backdrop
    // both edges share, not a second one.
    await h.click('#backdrop');

    expect(h.el('app').classList.contains('sched-open')).toBe(false);
    expect(h.el('schedules').hasAttribute('inert')).toBe(true);
    expect(h.window.localStorage.getItem('aa_sched_open')).toBeNull();
  });

  it('says when the daemon has no task store instead of showing an empty list', async () => {
    const h = await open({ replies: { 'api/schedules': { enabled: false, tasks: [] } } });
    await h.click('#schedules-toggle');
    await until('the disabled note', () => h.el('schedules-list').textContent!.includes('not enabled'));

    expect(h.el('schedules-list').textContent).toContain('Scheduled tasks are not enabled in this daemon');
  });

  it('keeps a scheduled run out of the switcher and lists it under Sessions', async () => {
    const C = 'c3d4e5f6';
    const h = await open({ replies: { 'api/schedules': listReply([task()]) } });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'an ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI · 2026-11-04 08:00', lastAt: 3000, msgCount: 3, stage: 'idle', scheduled: true },
      ],
    });

    // One row, not two: a run is a conversation, but the switcher is where the person's own
    // topics live. The panel is the only place the run is listed.
    expect(h.rows()).toBe(1);
    expect(h.el('topics').textContent).not.toContain('Morning CI');

    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');

    expect(h.el('sched-sessions').hidden).toBe(false);
    expect(h.el('schedules-list').hidden).toBe(true);
    expect(h.el('sched-tab-sessions').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-sessions').textContent).toContain('Morning CI');
    expect(h.el('sched-sessions').textContent).toContain('3 messages');
    expect(h.el('sched-tab-sessions-n').textContent).toBe('1');

    // A run holding a question has no row in the switcher, so the clock itself has to say so.
    expect(h.el('sched-alert').hidden).toBe(true);
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'an ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 3, stage: 'answer', asking: true, scheduled: true },
      ],
    });
    expect(h.el('sched-alert').hidden).toBe(false);
    expect(h.el('schedules-toggle').getAttribute('title')).toContain('waiting');
  });

  it('opens a run from the Sessions tab, and remembers which tab was last read', async () => {
    const C = 'c3d4e5f6';
    const h = await open();
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'an ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 3, stage: 'idle', scheduled: true },
      ],
    });

    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');
    expect(h.window.localStorage.getItem('aa_sched_tab')).toBe('scheduled');
    expect(h.window.localStorage.getItem('aa_sched_subtab')).toBe('sessions');

    (h.doc.querySelector('.sess-item') as HTMLElement).click();
    await until('the switch', () => h.window.location.search.includes(C));
    // Following the run leaves the panel beside the transcript: it is part of the workspace now,
    // not a side glance that gets out of the way.
    expect(h.el('app').classList.contains('sched-open')).toBe(true);

    const again = await open({ storage: { aa_sched_tab: 'scheduled', aa_sched_subtab: 'sessions' } });
    expect(again.el('sched-tab-sessions').getAttribute('aria-selected')).toBe('true');
    expect(again.el('sched-sessions').hidden).toBe(false);
    expect(again.el('sched-tab-scheduled').getAttribute('aria-selected')).toBe('true');
  });

  it('deletes a run from its row, without switching to it first', async () => {
    const C = 'c3d4e5f6';
    const h = await open({ confirm: true });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: A, title: 'an ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' },
        { id: C, title: '[cc] ⏰ Morning CI', lastAt: 3000, msgCount: 3, stage: 'idle', scheduled: true },
      ],
    });

    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');
    // The run's ⋯ holds the same topic menu a sidebar row has.
    await h.click(`[data-rm="sess:${C}"]`);
    expect(Array.from(h.el('row-menu').querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toEqual([
      'Star',
      'Copy reference',
      'Fork',
      'End agent',
      'Delete topic',
    ]);
    await h.click('[data-rmk="delete"]');
    await until('the delete request', () => h.calls.some((c) => c.path === 'api/topics/delete'));

    expect(h.calls.find((c) => c.path === 'api/topics/delete')?.body).toEqual({ topic: C });
    expect(h.confirms[0]).toContain('Morning CI');
    expect(h.window.location.search).not.toContain(C);
  });

  it('restores a dragged width, and double-clicking the handle returns to the default', async () => {
    const h = await open({ storage: { aa_sched_w: '300' } });
    expect(h.el('schedules').style.getPropertyValue('--pw')).toBe('300px');

    h.doc.getElementById('sched-resize')!.dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true }));
    expect(h.el('schedules').style.getPropertyValue('--pw')).toBe('');
    expect(h.window.localStorage.getItem('aa_sched_w')).toBeNull();
  });

  it('drags from its left edge: moving the pointer left widens it', async () => {
    // jsdom has no layout, so pin the right edge where a docked panel's is. The drag measures
    // from that edge; the reversed arithmetic would clamp to the 220px minimum instead of 280.
    const h = await open({ width: 1440, height: 900 });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    h.el('schedules').getBoundingClientRect = () =>
      ({ left: 1024, right: 1280, width: 256, top: 0, bottom: 800, height: 800, x: 1024, y: 0, toJSON: () => ({}) }) as DOMRect;

    const handle = h.el('sched-resize');
    handle.dispatchEvent(new h.window.MouseEvent('pointerdown', { bubbles: true, clientX: 1024 }));
    h.doc.dispatchEvent(new h.window.MouseEvent('pointermove', { bubbles: true, clientX: 1000 }));
    h.doc.dispatchEvent(new h.window.MouseEvent('pointerup', { bubbles: true, clientX: 1000 }));
    await tick();

    expect(h.el('schedules').style.getPropertyValue('--pw')).toBe('280px');
    expect(h.window.localStorage.getItem('aa_sched_w')).toBe('280');
  });
});

/**
 * The Sessions list's calendar, with the clock fixed.
 *
 * "Today", "Yesterday", "this month" and a month across the year boundary are all real cases,
 * and a test that read the wall clock could reach only some of them — the Today and Yesterday
 * branches only on the 1st and 2nd of a month — and would flake across midnight. The date is
 * Saturday 2027-01-02, 12:00 local: yesterday is 2027-01-01 and last month is December 2026, so
 * both the day labels and the year boundary are exercised on every run.
 */
describe('webui page: the Sessions list calendar', () => {
  const A = 'a1b2c3d4';
  const C = 'c3d4e5f6';
  const D = 'd4e5f6a7';
  const E = 'e5f6a7b8';
  const F = 'f6a7b8c9';
  const NOW = new Date(2027, 0, 2, 12, 0, 0);
  const at = (y: number, m: number, d: number): number => new Date(y, m, d, 12).getTime();
  const TODAY = at(2027, 0, 2);
  const YESTERDAY = at(2027, 0, 1);
  const LAST_MONTH = at(2026, 11, 31);
  const OLDER = at(2026, 10, 15);
  /** Keeps the topic on screen off the run list, so the default fold is about the newest group. */
  const ordinary = { id: A, title: 'ordinary topic', lastAt: 0, msgCount: 1, stage: 'idle' };
  const heads = (h: Harness): HTMLElement[] =>
    Array.from(h.doc.querySelectorAll('#sched-sessions .sess-group-head')) as HTMLElement[];
  const names = (h: Harness): Array<string | null> =>
    heads(h).map((n) => n.querySelector('.sess-group-name')?.textContent ?? null);
  const expanded = (h: Harness): Array<string | null> => heads(h).map((n) => n.getAttribute('aria-expanded'));
  const body = (h: Harness, head: HTMLElement): HTMLElement =>
    h.doc.getElementById(head.getAttribute('aria-controls') ?? '') as HTMLElement;
  const flags = (head: HTMLElement): string[] =>
    Array.from(head.querySelectorAll('.sess-group-flag')).map((n) => n.textContent ?? '');
  const stored = (h: Harness): Record<string, boolean> =>
    JSON.parse(h.window.localStorage.getItem('aa_sched_groups') ?? '{}');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('groups this month by day and older runs by month, folded except the newest', async () => {
    const h = await open({ storage: { aa_reads: JSON.stringify({ [C]: 1, [E]: 0 }) } });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: D, title: 'newest run', lastAt: TODAY, msgCount: 3, stage: 'idle', scheduled: true },
        { id: C, title: 'yesterday run', lastAt: YESTERDAY, msgCount: 5, stage: 'idle', scheduled: true },
        { id: F, title: 'last month, asking', lastAt: LAST_MONTH, msgCount: 2, stage: 'answer', asking: true, running: true, scheduled: true },
        { id: E, title: 'the month before', lastAt: OLDER, msgCount: 2, stage: 'idle', running: true, scheduled: true },
        ordinary,
      ],
    });
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');

    // December 2026 under a January clock: the month group crosses the year boundary.
    expect(names(h)).toEqual(['Today', 'Yesterday', 'December 2026', 'November 2026']);
    expect(heads(h).map((n) => n.querySelector('.sess-group-count')?.textContent)).toEqual(['1', '1', '1', '1']);
    // The newest group starts open; the rest are folded, and their headers carry what the rows
    // underneath would have said. 5 messages against a mark of 1 is 4 unread; 2 against 0 is 2.
    expect(expanded(h)).toEqual(['true', 'false', 'false', 'false']);
    expect(flags(heads(h)[0]!)).toEqual([]);
    expect(flags(heads(h)[1]!)).toEqual(['4 unread']);
    expect(flags(heads(h)[2]!)).toEqual(['1 awaiting you']);
    expect(flags(heads(h)[3]!)).toEqual(['2 unread', '1 running']);
    expect(body(h, heads(h)[0]!).hidden).toBe(false);
    expect(body(h, heads(h)[1]!).hidden).toBe(true);
    expect(body(h, heads(h)[3]!).hidden).toBe(true);
    expect(body(h, heads(h)[0]!).querySelector('.sess-item')?.textContent).toContain('newest run');
    expect(body(h, heads(h)[1]!).querySelector('.sess-item')?.textContent).toContain('yesterday run');
  });

  it('puts an undated run in an Earlier group, last', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    // First in the list on purpose: the server sorts by lastAt, but the group has to be last
    // whatever order the list arrives in.
    await h.emit({
      t: 'topics',
      topics: [
        { id: E, title: 'no timestamp', lastAt: 0, msgCount: 2, stage: 'idle', scheduled: true },
        { id: D, title: 'today run', lastAt: TODAY, msgCount: 1, stage: 'idle', scheduled: true },
        ordinary,
      ],
    });
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');

    expect(names(h)).toEqual(['Today', 'Earlier']);
    expect(heads(h)[1]!.querySelector('.sess-group-count')?.textContent).toBe('1');
    expect(body(h, heads(h)[1]!).querySelector('.sess-item')?.textContent).toContain('no timestamp');
    // No "December 1969": a run with no timestamp has no date to name.
    expect(h.el('sched-sessions').textContent).not.toContain('1969');
  });

  it('remembers a folded or opened group, and drops groups the list no longer has', async () => {
    const sessions = (): Array<Record<string, unknown>> => [
      { id: D, title: 'newest run', lastAt: TODAY, msgCount: 1, stage: 'idle', scheduled: true },
      { id: C, title: 'yesterday run', lastAt: YESTERDAY, msgCount: 2, stage: 'idle', scheduled: true },
      ordinary,
    ];
    const h = await open({ storage: { aa_sched_groups: JSON.stringify({ 'd:1999-01-01': true }) } });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: sessions() });
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');

    heads(h)[1]!.click();
    await tick();
    expect(expanded(h)).toEqual(['true', 'true']);
    expect(body(h, heads(h)[1]!).hidden).toBe(false);
    // The stale key is gone: only the groups the list still has are kept.
    expect(stored(h)).toEqual({ 'd:2027-01-01': true });

    const again = await open({ storage: { aa_sched_groups: JSON.stringify(stored(h)) } });
    await again.emit(sync(A, [], [A]));
    await again.emit({ t: 'topics', topics: sessions() });
    await again.click('#schedules-toggle');
    await again.click('#sched-tab-sessions');
    expect(expanded(again)).toEqual(['true', 'true']);

    // The newest group can be folded too, and that is remembered over its default.
    heads(again)[0]!.click();
    await tick();
    expect(expanded(again)).toEqual(['false', 'true']);
  });

  it('keeps the group holding the open run unfolded over a manual fold, and restores focus', async () => {
    const h = await open({
      url: `http://localhost:8787/?t=${E}`,
      storage: { aa_sched_groups: JSON.stringify({ 'm:2026-11': false }) },
    });
    await h.emit(sync(E, [], [E]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: D, title: 'newest run', lastAt: TODAY, msgCount: 1, stage: 'idle', scheduled: true },
        { id: C, title: 'yesterday run', lastAt: YESTERDAY, msgCount: 1, stage: 'idle', scheduled: true },
        { id: E, title: 'the one on screen', lastAt: OLDER, msgCount: 1, stage: 'idle', scheduled: true },
        ordinary,
      ],
    });
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');

    // Newest first, then the run on screen: two open, the day between them folded — and the
    // run's group opens even though this browser folded it last time.
    expect(names(h)).toEqual(['Today', 'Yesterday', 'November 2026']);
    expect(expanded(h)).toEqual(['true', 'false', 'true']);
    expect(body(h, heads(h)[2]!).querySelector('.sess-item')?.textContent).toContain('the one on screen');

    // Folding it by hand does nothing while the run is on screen, and stores nothing.
    heads(h)[2]!.click();
    await tick();
    expect(expanded(h)).toEqual(['true', 'false', 'true']);
    expect(stored(h)).toEqual({ 'm:2026-11': false });

    // A fold that does repaint puts the focus back on the header that was clicked.
    heads(h)[1]!.click();
    await tick();
    expect(expanded(h)).toEqual(['true', 'true', 'true']);
    expect(h.doc.activeElement?.getAttribute('data-sgroup')).toBe('d:2027-01-01');
  });

  it('marks every run read in one tap, badges and the daemon’s reply mark alike', async () => {
    const h = await open({ storage: { aa_reads: JSON.stringify({ [C]: 0, [D]: 0 }) } });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: C, title: 'finished run', lastAt: TODAY, msgCount: 3, stage: 'review', scheduled: true },
        { id: D, title: 'working run', lastAt: TODAY - 1000, msgCount: 2, stage: 'idle', scheduled: true },
        ordinary,
      ],
    });
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');

    const button = (): HTMLButtonElement => h.doc.querySelector('#sched-read') as HTMLButtonElement;
    expect(button().disabled).toBe(false);
    expect(h.el('sched-sessions').querySelectorAll('.topic-badge')).toHaveLength(2);

    button().click();
    await until('the seen request', () => h.calls.some((c) => c.path === 'api/seen'));

    // The badge is this page's count, so it goes at once; the green dot is the daemon's, and
    // only the run that had one is reported.
    expect(h.el('sched-sessions').querySelectorAll('.topic-badge')).toHaveLength(0);
    expect(h.calls.filter((c) => c.path === 'api/seen').map((c) => c.body)).toEqual([{ topic: C }]);
    expect(JSON.parse(h.window.localStorage.getItem('aa_reads') ?? '{}')).toMatchObject({ [C]: 3, [D]: 2 });

    // Once the daemon's own list says the reply was seen, there is nothing left to mark.
    await h.emit({
      t: 'topics',
      topics: [
        { id: C, title: 'finished run', lastAt: TODAY, msgCount: 3, stage: 'idle', scheduled: true },
        { id: D, title: 'working run', lastAt: TODAY - 1000, msgCount: 2, stage: 'idle', scheduled: true },
        ordinary,
      ],
    });
    expect(button().disabled).toBe(true);
  });

  it('keeps Mark all read in the panel title, shown on the Sessions tab only', async () => {
    const h = await open({ storage: { aa_reads: JSON.stringify({ [C]: 0 }) } });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [{ id: C, title: 'finished run', lastAt: TODAY, msgCount: 3, stage: 'review', scheduled: true }, ordinary],
    });
    await h.click('#schedules-toggle');
    const button = h.el('sched-read') as HTMLButtonElement;
    // Beside the close, the way the topic list has its own beside its title — not a bar over the rows.
    expect(button.parentElement?.id).toBe('schedules-head');
    await h.click('#sched-tab-tasks');
    expect(button.hidden).toBe(true);
    await h.click('#sched-tab-sessions');
    expect(button.hidden).toBe(false);
    expect(button.title).toBe('Mark all read (1 session)');
    expect(h.el('sched-sessions').textContent).not.toContain('Mark all read');
    // It marks runs, so over the reviews it would name nothing listed there.
    await h.click('#sched-tab-reviews');
    expect(button.hidden).toBe(true);
  });

  it('says so when the daemon refuses a mark, and sends them one at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = await open({
      held: { 'api/seen': gate },
      status: { 'api/seen': 500 },
      storage: { aa_reads: JSON.stringify({ [C]: 0, [D]: 0 }) },
    });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: C, title: 'finished one', lastAt: TODAY, msgCount: 3, stage: 'review', scheduled: true },
        { id: D, title: 'finished two', lastAt: YESTERDAY, msgCount: 2, stage: 'review', scheduled: true },
        ordinary,
      ],
    });
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');
    (h.doc.querySelector('#sched-read') as HTMLButtonElement).click();
    await tick();

    // One at a time: the second is not even sent until the first has answered.
    expect(h.calls.filter((c) => c.path === 'api/seen')).toHaveLength(1);
    release();
    await until('both marks', () => h.calls.filter((c) => c.path === 'api/seen').length === 2);
    await until('the note', () => h.el('schedules-note').textContent !== '');

    expect(h.calls.filter((c) => c.path === 'api/seen').map((c) => c.body)).toEqual([{ topic: C }, { topic: D }]);
    // A 4xx/5xx resolves, so the page has to look at r.ok; the note is how it says the daemon
    // still counts both as finished.
    expect(h.el('schedules-note').hidden).toBe(false);
    expect(h.el('schedules-note').textContent).toContain('Could not mark 2 sessions read');
    expect(h.el('sched-sessions').querySelectorAll('.topic-dot.review')).toHaveLength(2);
  });
});

describe('webui page: sub-agents a scheduled run opened', () => {
  const A = 'a1b2c3d4';
  const R = 'c3d4e5f6';
  const S = 'd4e5f6a7';
  const G = 'e5f6a7b8';
  const N = 'f6a7b8c9';
  const ordinary = { id: A, title: 'an ordinary topic', lastAt: 2000, msgCount: 1, stage: 'idle' };
  const run = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: R, title: '[cc] ⏰ After close', lastAt: 3000, msgCount: 3, stage: 'idle', scheduled: true, ...extra,
  });
  const sub = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: S, title: '[ag] verify', lastAt: 2900, msgCount: 2, stage: 'idle', parent: R,
    dir: { host: 'pod', path: '/w/trader', name: 'trader' }, ...extra,
  });
  const grand = { id: G, title: '[cc] check', lastAt: 2800, msgCount: 1, stage: 'idle', parent: S };
  /** A run active now, so its group is the newest and starts open; R's 1970 group starts folded. */
  const newer = { id: N, title: '[cc] ⏰ Today', lastAt: Date.now(), msgCount: 1, stage: 'idle', scheduled: true };
  const switcher = (h: Harness): Array<string | null> =>
    Array.from(h.el('topics').querySelectorAll('[data-topic]')).map((r) => r.getAttribute('data-topic'));
  const sessions = (h: Harness): Array<string | null> =>
    Array.from(h.el('sched-sessions').querySelectorAll('[data-sess]')).map((r) => r.getAttribute('data-sess'));
  const row = (h: Harness, id: string): Element => h.doc.querySelector(`#sched-sessions [data-sess="${id}"]`)!;
  const panel = async (h: Harness): Promise<void> => {
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-sessions');
  };

  it('nests them under the run in Sessions, folded as a topic’s are, and keeps them out of the switcher', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: [run(), sub(), grand, ordinary] });
    // The switcher drew the run's sub-agent as a root of its own, its run nowhere near it
    // (reported 2026-11-13). It belongs with the run.
    expect(switcher(h)).toEqual([A]);

    await panel(h);
    const stream = h.live().url;
    expect(sessions(h)).toEqual([R]);
    expect(face(row(h, R).querySelector('[data-fold]'))).toBe('[chevronRight] 1');
    // The tab counts runs: a sub-agent rides with its run, as it does with its topic.
    expect(h.el('sched-tab-sessions-n').textContent).toBe('1');

    await h.click(`#sched-sessions [data-fold="${R}"]`);
    expect(sessions(h)).toEqual([R, S]);
    expect(row(h, S).className).toMatch(/\bsub d1\b/);
    // The same row a topic's sub-agent gets: where it works, not the run's message count.
    expect(row(h, S).querySelector('.topic-dir')?.textContent).toBe('pod · trader');
    expect(face(row(h, S).querySelector('[data-fold]'))).toBe('[chevronRight] 1');
    // Folding is remembered like a topic's, and is not a reason to switch.
    expect(JSON.parse(h.window.localStorage.getItem('aa_folded') ?? '{}')).toEqual({ [R]: false });
    await opens(h, stream);

    await h.click(`#sched-sessions [data-fold="${S}"]`);
    expect(sessions(h)).toEqual([R, S, G]);
    expect(row(h, G).className).toMatch(/\bsub d2\b/);

    (row(h, S) as HTMLElement).click();
    await until('the switch', () => h.window.location.search.includes(S));
    expect(switcher(h)).toEqual([A]);
  });

  it('says when one of them asks: the clock, the run’s pill, and its folded group', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: [newer, run(), sub({ stage: 'answer', asking: true, running: true }), ordinary] });
    // It has no row in the switcher any more, so the clock is what reaches the person.
    expect(switcher(h)).toEqual([A]);
    expect(h.el('sched-alert').hidden).toBe(false);

    await panel(h);
    const heads = Array.from(h.el('sched-sessions').querySelectorAll('.sess-group-head'));
    expect(heads.map((n) => n.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
    expect(Array.from(heads[1]!.querySelectorAll('.sess-group-flag')).map((n) => n.textContent)).toEqual(['1 awaiting you']);

    await h.click(`#sched-sessions [data-sgroup="${heads[1]!.getAttribute('data-sgroup')}"]`);
    expect(row(h, R).querySelector('[data-fold]')?.className).toContain('asking');
    // Its own turn is over, but the run is working while what it opened works, as a topic is.
    expect(row(h, R).querySelector('.topic-dot')?.className).toBe('topic-dot running');
    expect(row(h, R).querySelector('.topic-dir')?.textContent).toContain('running');
  });

  it('opens the way to the one on screen', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${S}` });
    await h.emit(sync(S, [], [S]));
    await h.emit({ t: 'topics', topics: [newer, run(), sub(), ordinary] });
    expect(switcher(h)).toEqual([A]);
    expect(h.el('topic-title').textContent).toBe('[ag] verify');

    await panel(h);
    // Its run's group and the run itself are drawn open, without that being saved.
    const heads = Array.from(h.el('sched-sessions').querySelectorAll('.sess-group-head'));
    expect(heads.map((n) => n.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
    expect(sessions(h)).toEqual([N, R, S]);
    expect(row(h, S).classList.contains('on')).toBe(true);
    expect(h.window.localStorage.getItem('aa_folded')).toBeNull();
  });

  it('marks a sub-agent’s badge read with the runs, and leaves its finished turn to the run', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: [run(), sub(), ordinary] });
    // Two new messages in the sub-agent's topic since the page last saw it; its finished turn is
    // the run's news, so its row has no green dot and api/seen is not the page's to send for it.
    await h.emit({ t: 'topics', topics: [run(), sub({ msgCount: 4, stage: 'review' }), ordinary] });
    await panel(h);
    await h.click(`#sched-sessions [data-fold="${R}"]`);
    expect(row(h, S).querySelector('.topic-badge')?.textContent).toBe('2');
    expect(row(h, S).querySelector('.topic-dot')?.className).toBe('topic-dot');
    const readAll = h.doc.querySelector('#sched-read') as HTMLButtonElement;
    expect(readAll.disabled).toBe(false);

    readAll.click();
    await tick();
    expect(row(h, S).querySelector('.topic-badge')).toBeNull();
    expect((h.doc.querySelector('#sched-read') as HTMLButtonElement).disabled).toBe(true);
    expect(h.calls.filter((c) => c.path === 'api/seen')).toEqual([]);
  });
});

describe('webui page: Mark all read in the topic list', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const C = 'c3d4e5f6';
  const D = 'd4e5f6a7';
  const R = 'e5f6a7b8';
  const list = (extra: Record<string, Record<string, unknown>> = {}): Array<Record<string, unknown>> => [
    { id: A, title: 'on screen', lastAt: 5000, msgCount: 1, stage: 'idle', ...(extra[A] ?? {}) },
    { id: B, title: 'b', lastAt: 4000, msgCount: 2, stage: 'idle', ...(extra[B] ?? {}) },
    { id: C, title: 'c', lastAt: 3000, msgCount: 2, stage: 'idle', ...(extra[C] ?? {}) },
    { id: D, title: 'd', lastAt: 2000, msgCount: 1, stage: 'idle', parent: C, ...(extra[D] ?? {}) },
    { id: R, title: 'a run', lastAt: 1000, msgCount: 1, stage: 'idle', scheduled: true, ...(extra[R] ?? {}) },
  ];
  const btn = (h: Harness): HTMLButtonElement => h.el('read-topics') as HTMLButtonElement;
  const badges = (h: Harness): string[] =>
    Array.from(h.el('topics').querySelectorAll('.topic-badge')).map((n) => n.textContent ?? '');

  it('clears every badge and finished reply in the list, and nothing of the Sessions tab', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: list() });
    // Everything was seen on first sight: nothing to mark.
    expect(btn(h).disabled).toBe(true);

    await h.emit({
      t: 'topics',
      topics: list({ [B]: { msgCount: 5 }, [C]: { stage: 'review' }, [D]: { msgCount: 3, stage: 'review' }, [R]: { msgCount: 4, stage: 'review' } }),
    });
    await h.click(`#topics [data-fold="${C}"]`);
    expect(badges(h)).toEqual(['2', '3']);
    expect(btn(h).disabled).toBe(false);
    expect(btn(h).title).toBe('Mark all read (3 topics)');

    await h.click('#read-topics');
    await until('the mark', () => h.calls.some((c) => c.path === 'api/seen'));
    expect(badges(h)).toEqual([]);
    // The green dot is the daemon's to clear, and only a topic the person reads has one: C, not
    // its sub-agent D, and not the run, which is the Sessions tab's.
    await tick();
    expect(h.calls.filter((c) => c.path === 'api/seen').map((c) => c.body)).toEqual([{ topic: C }]);
    const reads = JSON.parse(h.window.localStorage.getItem('aa_reads') ?? '{}');
    expect(reads[R]).toBe(1);

    // The daemon announces C seen, and there is nothing left to mark.
    await h.emit({ t: 'topics', topics: list({ [B]: { msgCount: 5 }, [D]: { msgCount: 3 }, [R]: { msgCount: 4, stage: 'review' } }) });
    expect(btn(h).disabled).toBe(true);
  });

  it('says so when the daemon refuses a mark', async () => {
    const h = await open({ status: { 'api/seen': 500 } });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: list() });
    await h.emit({ t: 'topics', topics: list({ [C]: { stage: 'review' } }) });
    await h.click('#read-topics');
    await until('the note', () => h.el('note').textContent !== '');
    expect(h.el('note').textContent).toContain('Could not mark 1 topic read');
  });
});

describe('webui page: the task list filter', () => {
  const A = 'a1b2c3d4';
  const HOUR = 3_600_000;
  const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'a1b2c3',
    name: 'Morning CI',
    tags: [],
    createdAt: Date.UTC(2026, 10, 1),
    state: 'active',
    when: '0 8 * * * (Asia/Shanghai)',
    next: '2026-11-05 08:00',
    nextAt: Date.UTC(2026, 10, 5, 0, 0, 0),
    run: 'cc · fixed session',
    target: 'web:main#' + A,
    targetTopic: A,
    runs: 2,
    running: false,
    detail: 'summarise the failures',
    kind: 'agent',
    ...over,
  });
  const listReply = (tasks: Array<Record<string, unknown>>): Record<string, unknown> => ({ enabled: true, tasks });
  const ids = (h: Harness): string[] =>
    Array.from(h.doc.querySelectorAll('#schedules-list .sched-item')).map((n) => n.getAttribute('data-id') ?? '');
  const search = async (h: Harness, s: string): Promise<void> => {
    const q = h.doc.querySelector('#sched-filter .fb-q') as HTMLInputElement;
    q.value = s;
    q.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await tick();
  };
  const toggle = async (h: Harness, group: string, value: string): Promise<void> => {
    await h.click(`#sched-filter .fb-chip[data-fb-group="${group}"][data-fb-value="${value}"]`);
  };
  const sortBy = async (h: Harness, value: string): Promise<void> => {
    const sel = h.doc.querySelector('#sched-filter .fb-sortsel') as HTMLSelectElement;
    sel.value = value;
    sel.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await tick();
  };
  const flip = async (h: Harness): Promise<void> => {
    await h.click('#sched-filter .fb-dir');
  };
  const openPanel = async (h: Harness): Promise<void> => {
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
  };
  /** One task per status, two tags plus untagged, and a live run. */
  const fleet = (): Array<Record<string, unknown>> => [
    task({ id: 'a1b2c3', name: 'Morning CI', tags: ['ci'] }),
    task({
      id: 'b2c3d4',
      name: 'Nightly backup',
      state: 'paused',
      tags: ['ops'],
      nextAt: undefined,
      next: undefined,
      detail: 'pg_dump app',
      target: 'tg:1',
      targetTopic: undefined,
    }),
    task({ id: 'c3d4e5', name: 'Old report', state: 'expired', nextAt: undefined, next: undefined, detail: 'weekly report' }),
    task({ id: 'd4e5f6', name: 'One shot', state: 'done', nextAt: undefined, next: undefined, detail: 'ping once' }),
    task({ id: 'e5f6a7', name: 'Live run', running: true, tags: ['ci'] }),
  ];

  it('hangs its bar above the list on the Tasks sub-tab only', async () => {
    const replies = { 'api/schedules': listReply([task()]), 'api/reviews': { enabled: true, reviews: [] } };
    const h = await open({ replies });
    await openPanel(h);

    const host = h.el('sched-filter');
    expect(host.hidden).toBe(false);
    expect(host.querySelector('.filterbar')).not.toBeNull();
    // Outside the list that is redrawn: the caret and the open panel live in this DOM.
    expect(h.el('schedules-list').querySelector('.filterbar')).toBeNull();

    await h.click('#sched-tab-sessions');
    expect(host.hidden).toBe(true);
    await h.click('#sched-tab-tasks');
    expect(host.hidden).toBe(false);
    await h.click('#sched-tab-reviews');
    await until('the reviews list', () => h.el('sched-reviews-list').textContent !== '');
    expect(host.hidden).toBe(true);
  });

  it('searches the name, the prompt or command, and the target, word by word', async () => {
    const h = await open({ replies: { 'api/schedules': listReply(fleet()) } });
    await openPanel(h);
    expect(ids(h)).toHaveLength(5);

    await search(h, 'backup');
    expect(ids(h)).toEqual(['b2c3d4']);
    await search(h, 'pg_dump');
    expect(ids(h)).toEqual(['b2c3d4']);
    await search(h, 'tg:1');
    expect(ids(h)).toEqual(['b2c3d4']);
    await search(h, 'MORNING weekend');
    expect(ids(h)).toEqual([]);
    await search(h, 'morning');
    expect(ids(h)).toEqual(['a1b2c3']);
  });

  it('filters by status (Running, Active, Paused, Ended) and by tag, with counts', async () => {
    const h = await open({ replies: { 'api/schedules': listReply(fleet()) } });
    await openPanel(h);

    // Status is the pinned row: on screen with the panel shut, four chips in one row.
    expect((h.doc.querySelector('#sched-filter .fb-panel') as HTMLElement).hidden).toBe(true);
    const statusChips = Array.from(h.doc.querySelectorAll('#sched-filter .fb-pins .fb-chip'));
    expect(statusChips.map((c) => c.getAttribute('data-fb-value'))).toEqual(['running', 'active', 'paused', 'ended']);

    const count = (group: string, value: string): string | undefined =>
      h.doc.querySelector(`#sched-filter .fb-chip[data-fb-group="${group}"][data-fb-value="${value}"] .fb-count`)
        ?.textContent ?? undefined;
    expect([count('status', 'running'), count('status', 'active'), count('status', 'paused'), count('status', 'ended')]).toEqual([
      '1',
      '1',
      '1',
      '2',
    ]);
    // A pinned chip filters without opening the panel.
    await toggle(h, 'status', 'ended');
    expect(new Set(ids(h))).toEqual(new Set(['c3d4e5', 'd4e5f6']));
    expect((h.doc.querySelector('#sched-filter .fb-panel') as HTMLElement).hidden).toBe(true);

    // The tags still live in the panel.
    await h.click('#sched-filter .fb-filter');
    expect(count('tags', 'ci')).toBe('2');
    expect(count('tags', 'ops')).toBe('1');
    expect(count('tags', ' untagged')).toBe('2');
    // The chip carries the tag icon, like the card's own chips.
    expect(h.doc.querySelector('#sched-filter .fb-chip[data-fb-value="ci"] .ic-tag')).not.toBeNull();

    // Values in one group widen: running joins the ended ones.
    await toggle(h, 'status', 'running');
    expect(new Set(ids(h))).toEqual(new Set(['c3d4e5', 'd4e5f6', 'e5f6a7']));

    await toggle(h, 'status', 'ended');
    await toggle(h, 'status', 'running');
    await toggle(h, 'tags', 'ops');
    expect(ids(h)).toEqual(['b2c3d4']);
    // Groups intersect: a tag plus a status the tagged task does not have matches nothing.
    await toggle(h, 'status', 'active');
    expect(ids(h)).toEqual([]);
    expect(h.doc.querySelector('.sched-none')?.textContent).toContain('No matching tasks');
    await h.click('.sched-none .fb-clear');
    expect(ids(h)).toHaveLength(5);
    expect((h.doc.querySelector('#sched-filter .fb-q') as HTMLInputElement).value).toBe('');
  });

  it('keeps a pinned Status chip’s pressed state in step without restating the groups', async () => {
    const h = await open({ replies: { 'api/schedules': listReply(fleet()) } });
    await openPanel(h);
    const paused = (): HTMLElement =>
      h.doc.querySelector('#sched-filter .fb-chip[data-fb-group="status"][data-fb-value="paused"]') as HTMLElement;
    expect(paused().getAttribute('aria-pressed')).toBe('false');

    await toggle(h, 'status', 'paused');
    expect(paused().getAttribute('aria-pressed')).toBe('true');
    // The chip carries its full name and its number, because the row may show only the number.
    expect(paused().getAttribute('aria-label')).toBe('Paused 1');

    await toggle(h, 'status', 'paused');
    expect(paused().getAttribute('aria-pressed')).toBe('false');

    await toggle(h, 'status', 'paused');
    await h.click('#sched-filter .fb-sum .fb-clear');
    expect(paused().getAttribute('aria-pressed')).toBe('false');
    expect((h.doc.querySelector('#sched-filter .fb-sum') as HTMLElement).hidden).toBe(true);
  });

  it('sorts by next run, last run and creation, with the missing values always last', async () => {
    const at = (n: number): Record<string, unknown> => ({ at: n, atText: 'x', status: 'ok' });
    const replies = {
      'api/schedules': listReply([
        task({ id: 'd0d0d0', name: 'done', state: 'done', nextAt: undefined, next: undefined, createdAt: 4000 }),
        task({
          id: 'b0b0b0',
          name: 'paused',
          state: 'paused',
          nextAt: undefined,
          next: undefined,
          last: at(1000),
          createdAt: 3000,
        }),
        task({ id: 'e0e0e0', name: 'later', nextAt: 30 * HOUR, last: at(3000), createdAt: 1000 }),
        task({ id: 'a0a0a0', name: 'sooner', nextAt: HOUR, last: undefined, createdAt: 2000 }),
      ]),
    };
    const h = await open({ replies });
    await openPanel(h);

    // Status is the daemon's order, untouched.
    expect(ids(h)).toEqual(['d0d0d0', 'b0b0b0', 'e0e0e0', 'a0a0a0']);

    await sortBy(h, 'next');
    expect(ids(h)).toEqual(['a0a0a0', 'e0e0e0', 'd0d0d0', 'b0b0b0']);
    await flip(h);
    // Descending reverses the values; the two with no next run stay at the bottom.
    expect(ids(h)).toEqual(['e0e0e0', 'a0a0a0', 'd0d0d0', 'b0b0b0']);

    await sortBy(h, 'last');
    await flip(h); // back to ascending
    expect(ids(h)).toEqual(['b0b0b0', 'e0e0e0', 'd0d0d0', 'a0a0a0']);
    await flip(h);
    expect(ids(h)).toEqual(['e0e0e0', 'b0b0b0', 'd0d0d0', 'a0a0a0']);

    await sortBy(h, 'created');
    await flip(h); // ascending again
    expect(ids(h)).toEqual(['e0e0e0', 'a0a0a0', 'b0b0b0', 'd0d0d0']);
    await flip(h);
    expect(ids(h)).toEqual(['d0d0d0', 'b0b0b0', 'a0a0a0', 'e0e0e0']);

    // Back to Status: the API's order, reversed while the direction is descending.
    await sortBy(h, 'status');
    expect(ids(h)).toEqual(['a0a0a0', 'e0e0e0', 'b0b0b0', 'd0d0d0']);
    await flip(h);
    expect(ids(h)).toEqual(['d0d0d0', 'b0b0b0', 'e0e0e0', 'a0a0a0']);
  });

  /** A task's page, for the tag editor on it: the tags shown are the list row's (taskPageFollow). */
  const tagPage = { ok: true, detail: { task: task(), fields: { name: 'Morning CI', cron: '0 8 * * *', tz: 'Asia/Shanghai', prompt: 'x', agent: 'cc', session: 'fixed' }, agents: ['cc'], runs: [] } };
  const openTask = async (h: Harness): Promise<HTMLInputElement> => {
    (h.doc.querySelector('.sched-item') as HTMLElement).click();
    await until('the tag field', () => h.doc.querySelector('#task-view [data-tag-input]') !== null);
    return h.doc.querySelector('#task-view [data-tag-input]') as HTMLInputElement;
  };

  it("adds a tag on the task's page, and the row and the page both show it", async () => {
    const replies = {
      'api/schedules': listReply([task({ tags: ['ci'] })]),
      'api/schedules/op': { ok: true, tasks: [task({ tags: ['ci', 'deploy'] })] },
      'api/schedules/task?id=a1b2c3': tagPage,
    };
    const h = await open({ replies });
    await openPanel(h);

    const input = await openTask(h);
    input.focus();
    input.value = 'deploy';
    input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until('the tags request', () => h.calls.some((c) => c.path === 'api/schedules/op'));

    expect(h.calls.find((c) => c.path === 'api/schedules/op')?.body).toEqual({
      id: 'a1b2c3',
      action: 'tags',
      tags: ['ci', 'deploy'],
    });
    await until('the new chip', () => h.doc.querySelectorAll('#task-view .sched-tag').length === 2);
    expect(h.el('schedules-list').textContent).toContain('deploy');
    // The field is emptied and keeps the focus, for the next tag.
    const again = h.doc.querySelector('#task-view [data-tag-input]') as HTMLInputElement;
    expect(again.value).toBe('');
    expect(h.doc.activeElement).toBe(again);
  });

  it("removes a tag with its ×, and says a refusal on the page, where the person is looking", async () => {
    const removed = {
      'api/schedules': listReply([task({ tags: ['ci'] })]),
      'api/schedules/op': { ok: true, tasks: [task({ tags: [] })] },
      'api/schedules/task?id=a1b2c3': tagPage,
    };
    const h = await open({ replies: removed });
    await openPanel(h);
    await openTask(h);
    (h.doc.querySelector('#task-view [data-tag-del="ci"]') as HTMLElement).click();
    await until('the tags request', () => h.calls.some((c) => c.path === 'api/schedules/op'));

    expect(h.calls.find((c) => c.path === 'api/schedules/op')?.body).toEqual({ id: 'a1b2c3', action: 'tags', tags: [] });
    await until('no chip', () => h.doc.querySelectorAll('#task-view .sched-tag').length === 0);

    const refused = {
      'api/schedules': listReply([task({ tags: ['ci'] })]),
      'api/schedules/op': { ok: false, error: 'a task takes at most 5 tags, got 6' },
      'api/schedules/task?id=a1b2c3': tagPage,
    };
    const r = await open({ replies: refused, status: { 'api/schedules/op': 400 } });
    await openPanel(r);
    const input = await openTask(r);
    input.value = 'x';
    input.dispatchEvent(new r.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until('the refusal', () => !r.el('task-note').hidden);

    expect(r.el('task-note').textContent).toBe('a task takes at most 5 tags, got 6');
    expect(r.el('task-note').className).toBe('error');
    // The panel behind the page is not where it is said: nobody can see it there.
    expect(r.el('schedules-note').hidden).toBe(true);
    // What was typed is still there to correct.
    expect((r.doc.querySelector('#task-view [data-tag-input]') as HTMLInputElement).value).toBe('x');
  });

  it('keeps a tag being typed and its caret through a poll', async () => {
    const replies = { 'api/schedules': listReply([task()]), 'api/schedules/task?id=a1b2c3': tagPage };
    // The 30s poll is shortened to 30ms, which is the repaint a person editing a tag would see.
    const h = await open({ replies, shortenLong: true });
    await openPanel(h);
    const input = await openTask(h);
    input.value = 'deploy';
    input.focus();
    input.setSelectionRange(3, 3);
    const polls = h.calls.filter((c) => c.path === 'api/schedules').length;

    await within('a poll', 1000, () => h.calls.filter((c) => c.path === 'api/schedules').length > polls);
    await tick();
    // Not redrawn while it holds text: the same field, its value, its focus and its caret.
    expect(h.doc.contains(input)).toBe(true);
    expect(input.value).toBe('deploy');
    expect(h.doc.activeElement).toBe(input);
    expect(input.selectionStart).toBe(3);
  });

  it('keeps Loading until the first answer arrives, even when the bar is used', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await open({ replies: { 'api/schedules': listReply([task()]) }, held: { 'api/schedules': gate } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await until('the loading line', () => h.el('schedules-list').textContent!.includes('Loading'));

    // A sort before the list has arrived must not paint "no scheduled tasks" over the wait.
    await sortBy(h, 'created');
    expect(h.el('schedules-list').textContent).toContain('Loading');

    release();
    await until('the tasks', () => h.el('schedules-list').textContent!.includes('Morning CI'));
  });

  it('restores the keyword, the tags and the sort after a reload', async () => {
    const replies = { 'api/schedules': listReply(fleet()) };
    const h = await open({ replies });
    await openPanel(h);
    await h.click('#sched-filter .fb-filter');
    await toggle(h, 'status', 'paused');
    await toggle(h, 'tags', 'ops');
    await sortBy(h, 'created');
    await flip(h);
    expect(ids(h)).toEqual(['b2c3d4']);

    const saved = h.window.localStorage.getItem('aa_sched_filter');
    expect(saved).toBeTruthy();
    const again = await open({ replies, storage: { aa_sched_filter: saved! } });
    await openPanel(again);
    // The page came back with the panel open; clicking the clock is a click outside the bar, so
    // it folds the panel as any click elsewhere does. Reopen it to read the restored view.
    await again.click('#sched-filter .fb-filter');

    expect((again.doc.querySelector('#sched-filter .fb-q') as HTMLInputElement).value).toBe('');
    expect(again.doc.querySelector('#sched-filter .fb-chip[data-fb-value="ops"]')?.getAttribute('aria-pressed')).toBe('true');
    // The pinned Status row came back too, without the panel.
    expect(again.doc.querySelector('#sched-filter .fb-chip[data-fb-value="paused"]')?.getAttribute('aria-pressed')).toBe('true');
    expect((again.doc.querySelector('#sched-filter .fb-pins') as HTMLElement).hidden).toBe(false);
    expect((again.doc.querySelector('#sched-filter .fb-panel') as HTMLElement).hidden).toBe(false);
    expect((again.doc.querySelector('#sched-filter .fb-sortsel') as HTMLSelectElement).value).toBe('created');
    expect(again.doc.querySelector('#sched-filter .fb-dir')?.getAttribute('title')).toBe('Descending');
    expect(ids(again)).toEqual(['b2c3d4']);
    expect(again.doc.querySelector('#sched-filter .fb-sumtext')?.textContent).toBe('Showing 1 of 5');
  });
});

describe('webui page: the Reviews tab', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const at = Date.now() - 2 * 3_600_000;

  const review = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'review:web#main#' + A + ':1',
    title: 'Right sidebar',
    at,
    outcome: 'changed',
    summary: 'updated deploy-check · 1 preference',
    changes: [
      {
        action: 'patch',
        name: 'deploy-check',
        reason: 'two runs forgot the tests',
        applied: true,
        undo: 'fleetherd skills revert deploy-check 0001-abc',
      },
      {
        action: 'write-file',
        name: 'ci-logs',
        file: 'references/grep.md',
        applied: false,
        error: 'files may only go in references/',
      },
    ],
    preferences: ['answers lead with the conclusion'],
    invalid: [],
    topic: A,
    ...over,
  });

  const reply = (
    reviews: Array<Record<string, unknown>> = [review()],
    over: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    enabled: true,
    running: true,
    reviews,
    ...over,
  });

  it('lists reviews under a tab of their own, with no daily quota', async () => {
    const h = await open({ replies: { 'api/reviews': reply() } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the review row', () => h.el('sched-reviews-list').textContent!.includes('Right sidebar'));

    expect(h.el('sched-tab-reviews').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sched-tab-tasks').getAttribute('aria-selected')).toBe('false');
    expect(h.el('sched-reviews').hidden).toBe(false);
    expect(h.el('schedules-list').hidden).toBe(true);
    expect(h.el('sched-tab-reviews-n').textContent).toBe('1');
    expect(h.el('schedules-summary').textContent).toBe('1 review');
    // The cap is gone, so there is no counter and no "used up" line to draw.
    expect(h.doc.getElementById('sched-reviews-quota')).toBeNull();
    expect(h.el('sched-reviews').textContent).not.toContain('/10');
    const row = h.doc.querySelector('.rev-item')!;
    expect(row.textContent).toContain('Right sidebar');
    expect(row.textContent).toContain('updated deploy-check · 1 preference');
    // The tab is remembered like the other two.
    expect(h.window.localStorage.getItem('aa_sched_tab')).toBe('reviews');
  });

  it('lists the pending preference suggestions above the reviews, and dismisses one', async () => {
    const pending = [
      { text: 'answers lead with the conclusion', count: 3, at, from: [{ title: 'Right sidebar', topic: A }, { title: 'Deploy' }] },
      { text: 'delete credentials to the trash, never for good', count: 1, at, from: [{ title: 'Vault' }] },
    ];
    const h = await open({
      replies: {
        'api/reviews': reply([review()], { pending }),
        'api/reviews/op': reply([review()], { pending: [pending[1]] }),
      },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the pending list', () => Boolean(h.doc.querySelector('.rev-pending')));

    const block = h.doc.querySelector('.rev-pending')!;
    // Above the reviews, and saying that nothing here is in force.
    expect(h.el('sched-reviews-list').firstElementChild).toBe(block);
    expect(block.textContent).toContain('Suggestions · 2');
    expect(block.textContent).toContain('Not in effect anywhere');
    // The note says what each answer does, now that there are two of them.
    expect(block.textContent).toContain('Adopt opens a new topic');
    const items = block.querySelectorAll('.rev-pitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('answers lead with the conclusion');
    expect(items[0]!.textContent).toContain('3 reviews · Right sidebar, Deploy');
    expect(items[0]!.querySelector('.rev-adopt')!.textContent).toBe('Adopt');
    expect(items[1]!.querySelector('.rev-pmeta')!.textContent).toBe('Vault');

    (items[0]!.querySelector('.rev-dismiss') as HTMLElement).click();
    await until('the dismissal', () => h.doc.querySelectorAll('.rev-pitem').length === 1);
    expect(h.calls.find((c) => c.path === 'api/reviews/op')?.body).toEqual({
      action: 'dismiss',
      text: 'answers lead with the conclusion',
    });
    expect(h.doc.querySelector('.rev-pending')!.textContent).toContain('Suggestions · 1');
    // Dismissing is not opening: no review row was toggled by the click.
    expect(h.doc.querySelector('.rev-detail')).toBeNull();
  });

  it('offers Archive for an archive suggestion, through the Skills tab\'s own operation', async () => {
    const pending = [
      {
        text: 'Archive simular-box, merged into sbox',
        archive: { name: 'simular-box', into: 'sbox' },
        reason: 'the same tool, written twice',
        count: 1,
        at,
        from: [{ title: 'mcpmux' }],
      },
    ];
    const suggestion = review({
      outcome: 'preferences',
      summary: '1 archive suggestion',
      changes: [
        {
          action: 'archive',
          name: 'simular-box',
          into: 'sbox',
          suggested: true,
          command: 'fleetherd skills archive simular-box',
        },
      ],
      preferences: [],
    });
    const replies: Record<string, unknown> = {
      'api/reviews': reply([suggestion], { pending }),
      'api/skills/op': { ok: true, skills: [] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the pending list', () => Boolean(h.doc.querySelector('.rev-pending')));

    const item = h.doc.querySelector('.rev-pitem')!;
    expect(item.textContent).toContain('the same tool, written twice');
    expect(item.querySelector('[data-rev-adopt]')).toBeNull();
    // The change row says it was a suggestion and names the command that carries it out.
    (h.doc.querySelector('.rev-item') as HTMLElement).click();
    await until('the detail', () => Boolean(h.doc.querySelector('.rev-detail')));
    const change = h.doc.querySelector('.rev-change')!;
    expect(change.textContent).toContain('Archive simular-box into sbox');
    expect(change.querySelector('.rev-status')!.textContent).toBe('suggested');
    expect(change.querySelector('.rev-undo')!.textContent).toBe('fleetherd skills archive simular-box');

    replies['api/reviews'] = reply([suggestion], { pending: [] });
    (h.doc.querySelector('[data-rev-archive]') as HTMLElement).click();
    await until('the archive', () => h.calls.some((c) => c.path === 'api/skills/op'));
    expect(h.calls.find((c) => c.path === 'api/skills/op')?.body).toEqual({ action: 'archive', name: 'simular-box' });
    // Gone once the daemon no longer lists it — the skill is archived, so the suggestion is done.
    await until('the refreshed list', () => h.doc.querySelector('.rev-pending') === null);
  });

  it('keeps a list answer that predates an archive suggestion out of the skills cache', async () => {
    const skill = {
      name: 'simular-box',
      description: 'the old name',
      version: 'v1',
      status: 'active',
      pinned: false,
      resident: false,
      uses: 0,
      agents: [],
    };
    const archived = { ...skill, status: 'archived' };
    const pending = [
      { text: 'Archive simular-box', archive: { name: 'simular-box' }, count: 1, at, from: [{ title: 'mcpmux' }] },
    ];
    const replies: Record<string, unknown> = {
      'api/skills': { enabled: true, skills: [skill] },
      'api/reviews': reply([review()], { pending }),
      'api/skills/op': { ok: true, skills: [archived] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));

    // Seed the cache, then open again with a list request held and close the window under it.
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('simular-box'));
    await h.click('#skills-close');
    const real = h.window.fetch;
    let releaseOld!: () => void;
    let held = false;
    (h.window as any).fetch = (path: string, init?: any) => {
      if (path === 'api/skills' && !held) {
        held = true;
        return new Promise((resolve) => {
          releaseOld = () =>
            resolve({
              ok: true,
              status: 200,
              headers: { get: () => null },
              json: () => Promise.resolve({ enabled: true, skills: [skill] }),
            });
        });
      }
      return real(path, init);
    };
    await h.click('#skills-toggle');
    await h.click('#skills-close');

    // Archive from Reviews while that request is still in the air.
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the pending list', () => Boolean(h.doc.querySelector('.rev-pending')));
    replies['api/skills'] = { enabled: true, skills: [archived] };
    const reviews = (): number => h.calls.filter((c) => c.path === 'api/reviews').length;
    const before = reviews();
    (h.doc.querySelector('[data-rev-archive]') as HTMLElement).click();
    // The archive has been answered and its own follow-ups have run.
    await until('the archive answer', () => reviews() > before);

    // The held answer is what the store said before the archive: it must not reach the cache.
    releaseOld();
    await until('the cache', () => {
      const d = JSON.parse(h.window.localStorage.getItem('aa_skills') || '{}') as { skills?: Array<{ status?: string }> };
      return d.skills?.[0]?.status === 'archived';
    });
  });

  it('keeps an archive suggestion and says why when the archive is refused', async () => {
    const pending = [
      { text: 'Archive simular-box', archive: { name: 'simular-box' }, count: 1, at, from: [{ title: 'mcpmux' }] },
    ];
    const h = await open({
      replies: {
        'api/reviews': reply([review()], { pending }),
        'api/skills/op': { ok: false, error: 'no skill named "simular-box"' },
      },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the pending list', () => Boolean(h.doc.querySelector('.rev-pending')));
    (h.doc.querySelector('[data-rev-archive]') as HTMLElement).click();
    await until('the note', () => h.doc.body.textContent!.includes('Could not archive simular-box: no skill named'));
    expect((h.doc.querySelector('[data-rev-archive]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('draws no pending block when nothing is pending', async () => {
    const h = await open({ replies: { 'api/reviews': reply([review()], { pending: [] }) } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the review row', () => Boolean(h.doc.querySelector('.rev-item')));
    expect(h.doc.querySelector('.rev-pending')).toBeNull();
  });

  const SUGGESTION = 'answers lead with the conclusion';
  const OTHER = 'delete credentials to the trash, never for good';
  const pendingList = (): Array<Record<string, unknown>> => [
    { text: SUGGESTION, count: 3, at, from: [{ title: 'Right sidebar', topic: A }] },
    { text: OTHER, count: 1, at, from: [{ title: 'Vault' }] },
  ];

  /** The Reviews tab, open on a pending list, with `api/topics` answering the new topic. */
  const reviewing = async (
    opts: {
      topicsStatus?: number;
      topicsReply?: Record<string, unknown>;
      held?: Record<string, Promise<void>>;
    } = {}
  ): Promise<Harness> => {
    const h = await open({
      replies: {
        'api/reviews': reply([review()], { pending: pendingList() }),
        'api/reviews/op': reply([review()], { pending: [pendingList()[1]] }),
        'api/topics': opts.topicsReply ?? { topic: { id: 'd4e5f6a7', title: '', lastAt: at } },
      },
      ...(opts.topicsStatus ? { status: { 'api/topics': opts.topicsStatus } } : {}),
      ...(opts.held ? { held: opts.held } : {}),
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the pending list', () => Boolean(h.doc.querySelector('.rev-pending')));
    return h;
  };

  it('adopts a suggestion into a new topic as a draft, and sends nothing', async () => {
    const h = await reviewing();
    const fresh = 'd4e5f6a7';

    (h.doc.querySelector('.rev-adopt') as HTMLElement).click();
    await until('the new topic', () => h.window.location.search.includes(fresh));

    expect(h.calls.find((c) => c.path === 'api/topics')?.body).toEqual({});
    const draft = (h.el('input') as HTMLTextAreaElement).value;
    expect(draft).toContain('standing instructions');
    expect(draft).toContain('instructions/');
    expect(draft).toContain('diff');
    expect(draft).toContain(`"${SUGGESTION}"`);
    // A draft, not a message: nothing went out, and the suggestion is still on the list.
    expect(h.calls.map((c) => c.path)).not.toContain('api/send');
    expect(h.calls.map((c) => c.path)).not.toContain('api/reviews/op');
    expect(h.doc.querySelector('.rev-pending')!.textContent).toContain('Suggestions · 2');
  });

  it('takes a suggestion off the list once the draft is actually sent', async () => {
    const h = await reviewing();

    (h.doc.querySelector('.rev-adopt') as HTMLElement).click();
    await until('the draft', () => Boolean((h.el('input') as HTMLTextAreaElement).value));
    // The new topic's stream opening asks for the list again. Let that answer land first, so
    // what is asserted below is the dismissal rather than a race with a list fetched earlier.
    await until('the list refreshed', () => h.calls.filter((c) => c.path === 'api/reviews').length === 2);
    await tick();
    await h.click('#composer button[type="submit"]');
    await until('the dismissal', () => h.calls.some((c) => c.path === 'api/reviews/op'));

    expect(h.calls.find((c) => c.path === 'api/reviews/op')?.body).toEqual({
      action: 'dismiss',
      text: SUGGESTION,
    });
    await until('one suggestion left', () => h.doc.querySelectorAll('.rev-pitem').length === 1);
    expect(h.doc.querySelector('.rev-pending')!.textContent).toContain('Suggestions · 1');
  });

  it('leaves the suggestion alone when the draft is replaced before anything is sent', async () => {
    const h = await reviewing();

    (h.doc.querySelector('.rev-adopt') as HTMLElement).click();
    await until('the draft', () => Boolean((h.el('input') as HTMLTextAreaElement).value));
    // Thrown away and replaced: the message that goes out carries nothing of the suggestion.
    (h.el('input') as HTMLTextAreaElement).value = 'never mind, something else';
    await h.click('#composer button[type="submit"]');
    await until('the send', () => h.calls.some((c) => c.path === 'api/send'));
    await tick();

    expect(h.calls.map((c) => c.path)).not.toContain('api/reviews/op');
    expect(h.doc.querySelector('.rev-pending')!.textContent).toContain('Suggestions · 2');
  });

  it('says why a topic could not be opened, and keeps the suggestion', async () => {
    const refusal =
      'every one of the 64 topics is starred or in use; unstar or delete one before opening another';
    const h = await reviewing({
      topicsStatus: 409,
      topicsReply: { error: refusal },
    });

    (h.doc.querySelector('.rev-adopt') as HTMLElement).click();
    await until('the refusal', () => h.alerts.length > 0);

    expect(h.alerts[0]).toBe(`Could not open a new topic: ${refusal}`);
    // Still in the conversation it was in, with the suggestion untouched and Adopt usable again.
    expect(h.window.location.search).toContain(`t=${A}`);
    expect(h.doc.querySelector('.rev-pending')!.textContent).toContain('Suggestions · 2');
    expect((h.doc.querySelector('.rev-adopt') as HTMLButtonElement).disabled).toBe(false);
    expect(h.calls.map((c) => c.path)).not.toContain('api/send');
  });

  it('dismisses when the echo arrives before the send is acknowledged', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const h = await reviewing({ held: { 'api/send': gate } });

    (h.doc.querySelector('.rev-adopt') as HTMLElement).click();
    await until('the draft', () => Boolean((h.el('input') as HTMLTextAreaElement).value));
    await until('the list refreshed', () => h.calls.filter((c) => c.path === 'api/reviews').length === 2);
    await tick();
    await h.click('#composer button[type="submit"]');
    const nonce = h.calls.find((c) => c.path === 'api/send')?.body.nonce as string;

    // The daemon emits the echo before it answers the POST. claim() is what takes the message
    // out of unsent, so the dismissal has to be settled there — by the 2xx there is no record.
    await h.emit({ t: 'msg', msg: { ...message('w1', '<div class="raw">a draft</div>', true), nonce } });
    await until('the dismissal', () => h.calls.some((c) => c.path === 'api/reviews/op'));

    release();
    await tick();
    await tick();
    expect(h.calls.filter((c) => c.path === 'api/reviews/op')).toHaveLength(1);
    expect(h.calls.find((c) => c.path === 'api/reviews/op')?.body).toEqual({
      action: 'dismiss',
      text: SUGGESTION,
    });
  });

  it('does not dismiss after a reload, which forgets what the draft was for', async () => {
    const h = await reviewing();
    const fresh = 'd4e5f6a7';
    (h.doc.querySelector('.rev-adopt') as HTMLElement).click();
    await until('the draft', () => Boolean((h.el('input') as HTMLTextAreaElement).value));

    // The topic, the draft and the pending list all survive a reload; the link between the draft
    // and the suggestion is this page's memory, so it does not. The suggestion must stay.
    const again = await open({
      url: h.window.location.href,
      idb: h.idb,
      storage: { aa_drafts: h.window.localStorage.getItem('aa_drafts')! },
      replies: {
        'api/reviews': reply([review()], { pending: pendingList() }),
        'api/reviews/op': reply([review()], { pending: [pendingList()[1]] }),
      },
    });
    await again.emit(sync(fresh, [], [A, fresh]));
    expect((again.el('input') as HTMLTextAreaElement).value).toContain(`"${SUGGESTION}"`);

    await again.click('#composer button[type="submit"]');
    await until('the send', () => again.calls.some((c) => c.path === 'api/send'));
    await tick();
    expect(again.calls.map((c) => c.path)).not.toContain('api/reviews/op');

    await again.click('#schedules-toggle');
    await again.click('#sched-tab-reviews');
    await until('the pending list', () => Boolean(again.doc.querySelector('.rev-pending')));
    expect(again.doc.querySelectorAll('.rev-pitem')).toHaveLength(2);
  });

  it('does not let a list fetched before a dismissal put the suggestion back', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const held: Record<string, Promise<void>> = {};
    const h = await reviewing({ held });
    await h.emit(sync(A, [], [A, B]));

    // A refresh starts (the stream of a topic switched to asks for the list) and is held. Its
    // answer still carries both suggestions, because it was fetched before the dismissal.
    held['api/reviews'] = gate;
    await h.click(`[data-topic="${B}"]`);
    await until('the held refresh', () => h.calls.filter((c) => c.path === 'api/reviews').length === 2);

    (h.doc.querySelector('.rev-dismiss') as HTMLElement).click();
    await until('the dismissal', () => h.calls.some((c) => c.path === 'api/reviews/op'));
    await until('one suggestion left', () => h.doc.querySelectorAll('.rev-pitem').length === 1);

    release();
    await tick();
    await tick();
    expect(h.doc.querySelectorAll('.rev-pitem')).toHaveLength(1);
    expect(h.doc.querySelector('.rev-pending')!.textContent).toContain('Suggestions · 1');
  });

  it('opens a review for its changes, reasons, undo command and preferences', async () => {
    const h = await open({ replies: { 'api/reviews': reply() } });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the review row', () => Boolean(h.doc.querySelector('.rev-item')));

    const row = h.doc.querySelector('.rev-item') as HTMLElement;
    expect(row.querySelector('.rev-detail')).toBeNull();
    row.click();
    await tick();

    const detail = h.doc.querySelector('.rev-detail')!;
    expect(detail.textContent).toContain('deploy-check');
    expect(detail.textContent).toContain('two runs forgot the tests');
    expect(detail.textContent).toContain('applied');
    expect(detail.textContent).toContain('refused');
    expect(detail.textContent).toContain('files may only go in references/');
    expect(detail.textContent).toContain('fleetherd skills revert deploy-check 0001-abc');
    expect(detail.textContent).toContain('answers lead with the conclusion');
  });

  it('opens the reviewed topic, and offers no link when that topic is gone', async () => {
    const h = await open({ replies: { 'api/reviews': reply() } });
    await h.emit(sync(B, [], [A, B]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the review row', () => Boolean(h.doc.querySelector('.rev-item')));
    (h.doc.querySelector('.rev-item') as HTMLElement).click();
    await tick();

    const openTopic = h.doc.querySelector('.rev-open') as HTMLElement;
    expect(openTopic).not.toBeNull();
    openTopic.click();
    await until('the switch', () => h.window.location.search.includes(A));

    // A review of a topic this page does not have: the row stays, the link does not.
    const gone = await open({ replies: { 'api/reviews': reply([review({ topic: 'deadbeef' })]) } });
    await gone.emit(sync(A, [], [A]));
    await gone.click('#schedules-toggle');
    await gone.click('#sched-tab-reviews');
    await until('the review row', () => Boolean(gone.doc.querySelector('.rev-item')));
    (gone.doc.querySelector('.rev-item') as HTMLElement).click();
    await tick();
    expect(gone.doc.querySelector('.rev-open')).toBeNull();
  });

  it('marks an old review as inferred and leaves its changes unknown', async () => {
    const h = await open({
      replies: {
        'api/reviews': reply([
          review({
            id: 'review:web#main#a1b2c3d4:0',
            outcome: 'proposed',
            summary: '1 change proposed',
            inferred: true,
            changes: [{ action: 'patch', name: 'deploy-check', reason: '补一条' }],
            preferences: [],
          }),
        ]),
      },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the review row', () => Boolean(h.doc.querySelector('.rev-item')));
    const row = h.doc.querySelector('.rev-item') as HTMLElement;
    expect(row.textContent).toContain('inferred');
    row.click();
    await tick();

    const detail = h.doc.querySelector('.rev-detail')!;
    expect(detail.textContent).toContain('unknown');
    expect(detail.textContent).toContain('whether any of it took effect was not recorded');
  });

  it('says why the list is empty: no reviews yet, review off, or no library', async () => {
    const none = await open({ replies: { 'api/reviews': reply([]) } });
    await none.click('#schedules-toggle');
    await none.click('#sched-tab-reviews');
    await until('the empty note', () => none.el('sched-reviews-list').textContent!.includes('No reviews yet'));
    expect(none.el('sched-reviews-list').textContent).toContain('quiet for an hour');

    const off = await open({ replies: { 'api/reviews': reply([], { running: false }) } });
    await off.click('#schedules-toggle');
    await off.click('#sched-tab-reviews');
    await until('the off note', () => off.el('sched-reviews-list').textContent!.includes('Automatic review is off'));

    const noLibrary = await open({ replies: { 'api/reviews': { enabled: false, running: false, reviews: [] } } });
    await noLibrary.click('#schedules-toggle');
    await noLibrary.click('#sched-tab-reviews');
    await until('the library note', () => noLibrary.el('sched-reviews-list').textContent!.includes('no conversation library'));
  });

  it('asks for the list on a reload that restores the tab and the open panel', async () => {
    const h = await open({
      storage: { aa_sched_open: '1', aa_sched_tab: 'reviews' },
      replies: { 'api/reviews': reply() },
    });
    await h.emit(sync(A, [], [A]));

    expect(h.el('app').classList.contains('sched-open')).toBe(true);
    expect(h.el('sched-tab-reviews').getAttribute('aria-selected')).toBe('true');
    await until('the review row', () => Boolean(h.doc.querySelector('.rev-item')));
    expect(h.calls.some((c) => c.path === 'api/reviews')).toBe(true);
  });

  it('ignores a quota an older daemon still sends', async () => {
    const h = await open({
      replies: { 'api/reviews': reply([review()], { quota: { used: 10, limit: 10, resetsAt: Date.now() + 3_600_000 } }) },
    });
    await h.click('#schedules-toggle');
    await h.click('#sched-tab-reviews');
    await until('the review row', () => Boolean(h.doc.querySelector('.rev-item')));

    expect(h.doc.getElementById('sched-reviews-quota')).toBeNull();
    expect(h.el('sched-reviews').textContent).not.toContain('/10');
    expect(h.el('sched-reviews').textContent).not.toContain('quota used up');
  });
});
