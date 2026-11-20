import { describe, it, expect } from 'vitest';
import {
  renderPage,
  tick,
  until,
  sync,
  message,
  face,
  open,
  type Harness,
} from './page.dom.test-helpers.js';

describe('webui page: menus', () => {
  /** A `/cd`-shaped menu: a root, the current directory, two more, and the page controls. */
  const menu = (): Record<string, unknown> => ({
    ...message('m1', '<p>Working dir</p>'),
    buttons: [
      { id: 'wdr:r:0', label: '⌂ workspace' },
      { id: 'wdr:r:1', label: '● fleetherd' },
      { id: 'wdr:r:2', label: 'uniagent' },
      { id: 'wdr:r:3', label: '项目报告归档' },
      { id: 'wdp:r:1', label: '◀ Prev' },
      { id: 'wdp:r:1', label: 'Next ▶' },
    ],
  });
  const cells = (h: Harness, sel: string): string[] => Array.from(h.doc.querySelectorAll(sel)).map(face);

  it('puts the choices in the grid and the page controls on a row of their own under them', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [menu()], ['a1b2c3d4']));

    // Direct children of .btns are the choices; the controls are inside .nav, after them. Paging
    // used to sit in the middle of the list as two more things to pick.
    expect(cells(h, '.btns > button')).toEqual(['[home] workspace', '[dot] fleetherd', 'uniagent', '项目报告归档']);
    expect(cells(h, '.btns > .nav > button')).toEqual(['[chevronLeft] Prev', 'Next [chevronRight]']);
    expect(h.doc.querySelector('.btns > :last-child')?.className).toBe('nav');
  });

  it('sizes the columns from the widest label, counting a CJK character as two', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [menu()], ['a1b2c3d4']));

    // 项目报告归档 is six characters and twelve columns wide — wider than "⌂ workspace" (11).
    // The page controls are not choices and do not widen the grid.
    expect(h.doc.querySelector<HTMLElement>('.btns')?.style.getPropertyValue('--cw')).toBe('12ch');
  });

  it('lights the current choice, keeping its mark in the text', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [menu()], ['a1b2c3d4']));

    const lit = h.doc.querySelectorAll('.btns button.on');
    expect(Array.from(lit).map(face)).toEqual(['[dot] fleetherd']);
    // The mark is its own element so it can be coloured — and the root's ⌂ is a mark, not a choice.
    expect(face(lit[0]?.querySelector('.mk'))).toBe('[dot]');
    expect(face(h.doc.querySelector('button[data-btn="wdr:r:0"] .mk'))).toBe('[home]');
    expect(h.doc.querySelector('button[data-btn="wdr:r:0"]')?.classList.contains('on')).toBe(false);
  });

  it('lights a ticked multi-select option and not an unticked one', async () => {
    const h = await open();
    await h.emit(
      sync('a1b2c3d4', [{ ...message('m1', '<p>which?</p>'), buttons: [
        { id: 'ask:r:0', label: '☑ EU' },
        { id: 'ask:r:1', label: '☐ US' },
      ] }], ['a1b2c3d4'])
    );

    expect(h.doc.querySelector('button[data-btn="ask:r:0"]')?.classList.contains('on')).toBe(true);
    expect(h.doc.querySelector('button[data-btn="ask:r:1"]')?.classList.contains('on')).toBe(false);
    // The mark is a 1em icon where its glyph was counted as one column: the menu asks for the
    // difference on top of its widest label, or "☑ APAC" wraps its icon onto a line of its own.
    expect(h.doc.querySelector<HTMLElement>('.btns')?.style.getPropertyValue('--cw')).toBe('4ch');
    expect(h.doc.querySelector<HTMLElement>('.btns')?.style.getPropertyValue('--mk')).toBe('1');
  });

  it('a page control still posts its own id', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [menu()], ['a1b2c3d4']));

    await h.click('.nav button:last-child');

    expect(h.calls.find((c) => c.path === 'api/click')?.body).toEqual({
      topic: 'a1b2c3d4',
      messageId: 'm1',
      buttonId: 'wdp:r:1',
    });
  });

  it('lights a tapped cell at once, and stops lighting it when the tap is refused', async () => {
    const h = await open({ status: { 'api/click': 409 } });
    await h.emit(sync('a1b2c3d4', [menu()], ['a1b2c3d4']));

    const b = (): HTMLButtonElement | null => h.doc.querySelector('button[data-btn="wdr:r:2"]');
    h.doc.querySelector<HTMLButtonElement>('button[data-btn="wdr:r:2"]')?.click();
    // Synchronously: the round trip has not even started, and the tap is already visible.
    expect(b()?.classList.contains('busy')).toBe(true);
    expect(b()?.disabled).toBe(true);

    // 409 is "that message is gone": nothing is coming, so it is not left looking like it is.
    await until('the refusal lands', () => b()?.classList.contains('busy') === false);
    expect(b()?.disabled).toBe(true);
  });

  it('a repaint answering the tap takes the lit state away with it', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [menu()], ['a1b2c3d4']));

    await h.click('button[data-btn="wdr:r:2"]');
    expect(h.doc.querySelector('button[data-btn="wdr:r:2"]')?.classList.contains('busy')).toBe(true);

    await h.emit({ t: 'msg', msg: { ...menu(), buttons: [] } });
    expect(h.doc.querySelector('.btns')).toBeNull();
  });
});

describe('webui page: a permission request', () => {
  const A = 'a1b2c3d4';
  /**
   * The card `permissions: ask` posts: the title block, the change block and one button per option
   * the agent offered — the shape `composePermissionPrompt` produces and the daemon sends.
   */
  const card = (): Record<string, unknown> => ({
    ...message(
      'm2',
      '<p>\u{1F510} The agent asks to run:</p><pre><code>Edit src/app.ts</code></pre>'
        + '<pre><code>--- src/app.ts\n-const PORT = 3000;\n+const PORT = 8080;</code></pre>'
        + '<p>No answer within 60 min declines it.</p>'
    ),
    buttons: [
      { id: 'ask:r:0', label: 'Allow' },
      { id: 'ask:r:1', label: 'Always allow' },
      { id: 'ask:r:2', label: 'Reject' },
      { id: 'ask:r:3', label: 'Always reject' },
    ],
  });

  it('draws the change and one button per option, and posts the one that was tapped', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [card()], [A]));

    // The change is what the user is approving; the name alone is not a decision.
    expect(h.el('log').textContent).toContain('-const PORT = 3000;');
    expect(h.el('log').textContent).toContain('+const PORT = 8080;');
    expect(Array.from(h.doc.querySelectorAll('.btns button')).map(face)).toEqual([
      'Allow',
      'Always allow',
      'Reject',
      'Always reject',
    ]);

    await h.click('button[data-btn="ask:r:1"]');
    expect(h.calls.find((c) => c.path === 'api/click')?.body).toEqual({
      topic: A,
      messageId: 'm2',
      buttonId: 'ask:r:1',
    });
  });

  it('takes the buttons away when the daemon says it was answered', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [card()], [A]));
    expect(h.doc.querySelectorAll('.btns button')).toHaveLength(4);

    await h.emit({ t: 'msg', msg: { ...card(), html: `${String(card().html)}\n<p>\u2192 Selected: Allow</p>`, buttons: [] } });

    expect(h.doc.querySelector('.btns')).toBeNull();
    expect(h.el('log').textContent).toContain('Selected: Allow');
  });
});

describe('webui page: the settings page', () => {
  /**
   * A `/setting` list as the daemon sends it with `capabilities.settingsScreen`: the buttons it
   * would send a chat app, plus the same rows as data — groups, a control per row, and the ids each
   * control posts. The model row's value is deliberately longer than the 40-character label
   * budget, the thing this screen exists to stop cutting.
   */
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const LONG_MODEL = 'openrouter/anthropic/claude-opus-4.6-thinking:high';
  const list = (id = 'm1'): Record<string, unknown> => ({
    ...message(id, '<p>Settings — saved to config.yaml, not just this conversation.</p>'),
    buttons: [
      { id: 'stg:r:0', label: 'Default agent · cc · claude' },
      { id: 'stg:r:1', label: 'Default model · cc · (harness default)' },
      { id: 'stg:r:2', label: 'Default model · oc · openrouter/anthropic/claude-opus…' },
      { id: 'stg:r:3', label: 'Confirm sub-agent starts · on' },
      { id: 'stg:r:4', label: 'Idle reclaim · 15m' },
      { id: 'stg:r:5', label: 'Conversation scope · per_thread' },
      { id: 'sco:r:0', label: '⏰ Scheduled tasks · 1 active' },
    ],
    settings: {
      level: 'list',
      about: 'These apply to every conversation. `/model` changes one topic only.',
      groups: [
        { name: 'Agents' },
        { name: 'Default model', note: 'What each agent starts a new session with.' },
        { name: 'Sub-agents' },
        { name: 'Conversations' },
        { name: 'More' },
      ],
      rows: [
        {
          buttonId: 'stg:r:0',
          label: 'Default agent',
          value: 'cc · claude',
          hint: 'Answers a new conversation that no routing rule claims.',
          group: 'Agents',
          control: {
            kind: 'choice',
            options: [
              { buttonId: 'sts:r:0', label: 'cc · claude', current: true },
              { buttonId: 'sts:r:1', label: 'oc · opencode', current: false },
            ],
          },
        },
        {
          buttonId: 'stg:r:1',
          label: 'cc',
          target: 'cc',
          targetKind: 'Claude Code',
          value: 'harness default',
          unset: true,
          group: 'Default model',
          control: { kind: 'list' },
        },
        {
          buttonId: 'stg:r:2',
          label: 'oc',
          target: 'oc',
          targetKind: 'OpenCode',
          here: true,
          value: LONG_MODEL,
          group: 'Default model',
          control: { kind: 'list' },
        },
        {
          buttonId: 'stg:r:3',
          label: 'Confirm sub-agent starts',
          value: 'on',
          hint: 'Wait for your Start before an agent’s sub-tasks run.',
          group: 'Sub-agents',
          control: { kind: 'switch', on: true, set: 'sts:r:2' },
        },
        {
          buttonId: 'stg:r:4',
          label: 'Idle reclaim',
          value: '15m',
          group: 'Conversations',
          control: {
            kind: 'choice',
            options: [
              { buttonId: 'sts:r:3', label: 'off', detail: 'never reclaim', current: false },
              { buttonId: 'sts:r:4', label: '15m', current: true },
              { buttonId: 'sts:r:5', label: '1h', current: false },
            ],
          },
        },
        {
          buttonId: 'stg:r:5',
          label: 'Conversation scope',
          value: 'per_thread',
          effectLabel: 'after restart',
          effectDetail: 'takes effect when the daemon restarts',
          group: 'Conversations',
          control: {
            kind: 'choice',
            options: [
              { buttonId: 'sts:r:6', label: 'per_thread', detail: 'a topic is its own conversation', current: true },
              { buttonId: 'sts:r:7', label: 'per_channel', current: false },
              { buttonId: 'sts:r:8', label: 'per_user', current: false },
              { buttonId: 'sts:r:9', label: 'shared', current: false },
            ],
          },
        },
        { buttonId: 'sco:r:0', label: '⏰ Scheduled tasks · 1 active', group: 'More', control: { kind: 'link' } },
      ],
    },
  });

  /** The value level of `Idle reclaim`, with `15m` current and nothing to page. */
  const values = (id = 'm1'): Record<string, unknown> => ({
    ...message(id, '<p><strong>Idle reclaim</strong> — <code>15m</code></p>'),
    buttons: [
      { id: 'stv:r:0', label: 'off (never reclaim)' },
      { id: 'stv:r:1', label: '● 15m' },
      { id: 'stv:r:2', label: '1h' },
      { id: 'stb:r:0', label: '◀ Back' },
    ],
    settings: {
      level: 'values',
      head: {
        label: 'Idle reclaim',
        value: '15m',
        description: 'How long a conversation may sit quiet before its agent child is stopped.',
        effect: 'Changes in effect now.',
      },
      options: [
        { buttonId: 'stv:r:0', label: 'off', detail: 'never reclaim', current: false },
        { buttonId: 'stv:r:1', label: '15m', current: true },
        { buttonId: 'stv:r:2', label: '1h', current: false },
      ],
      nav: { page: 1, pageCount: 1, back: 'stb:r:0' },
    },
  });

  /** A list screen whose `settings` the test can change before sending. */
  const withScreen = (edit: (s: { rows: Array<Record<string, any>>; notice?: unknown }) => void, id = 'm1') => {
    const m = list(id);
    edit(m.settings as { rows: Array<Record<string, any>> });
    return m;
  };

  /**
   * The shape the daemon now sends for agents: one row per agent under `Agents`, each carrying its
   * own fields — Model opening a value screen, Permissions a closed list — beside the agent's name.
   * The default agent stays a plain row above them, and there is no `Default model` or
   * `Permissions` section any more.
   */
  const LEVEL_DETAIL: Record<string, string> = {
    plan: 'plans first',
    ask: 'asks before each step',
    edits: 'edits go through',
    auto: 'approves everything',
    full: 'no prompts at all',
  };
  const permissions = (prefix: string, current: number, labels = ['plan', 'ask', 'edits', 'auto', 'full'], extra: Record<string, unknown> = {}) => ({
    label: 'Permissions',
    buttonId: 'stg:p:' + prefix,
    value: labels[current],
    control: {
      kind: 'choice',
      options: labels.map((label, i) => ({
        buttonId: 'sts:p:' + prefix + ':' + i,
        label,
        current: i === current,
        ...(LEVEL_DETAIL[label] ? { detail: LEVEL_DETAIL[label] } : {}),
      })),
    },
    ...extra,
  });
  const agentRow = (id: string, kind: string, model: Record<string, unknown>, perm: Record<string, unknown>, here = false) => ({
    buttonId: String(model.buttonId),
    label: id,
    target: id,
    targetKind: kind,
    ...(here ? { here: true } : {}),
    group: 'Agents',
    control: { kind: 'agent', fields: [{ label: 'Model', control: { kind: 'list' }, ...model }, perm] },
  });
  const agentList = (id = 'm1'): Record<string, unknown> => ({
    ...message(id, '<p>Settings</p>'),
    buttons: [
      { id: 'stg:r:0', label: 'Default agent · cc' },
      { id: 'stg:m:0', label: 'cc · Claude Code' },
    ],
    settings: {
      level: 'list',
      groups: [{ name: 'Agents' }],
      rows: [
        {
          buttonId: 'stg:r:0',
          label: 'Default agent',
          value: 'cc',
          group: 'Agents',
          control: { kind: 'choice', options: [{ buttonId: 'sts:r:0', label: 'cc', current: true }] },
        },
        agentRow('cc', 'Claude Code', { buttonId: 'stg:m:0', value: 'harness default', unset: true }, permissions('0', 1, undefined, {
          unset: true,
          valueNote: 'not set',
        }), true),
        agentRow('oc@box', 'OpenCode', { buttonId: 'stg:m:1', value: LONG_MODEL, valueNote: 'pod.yaml' }, permissions('1', 0, [
          'plan',
          'ask',
          'edits',
          'auto',
          'full',
          'bypass permissions',
        ])),
      ],
    },
  });

  /** The instructions panel's answer for agentList: cc has files of its own, oc@box does not. */
  const INSTR = {
    dir: '/c/instructions',
    on: true,
    global: [{ name: 'common.md', layer: 'common', exists: true, size: 5, agents: ['cc'], reach: 'every agent' }],
    agents: [
      { id: 'cc', harness: 'claude', host: 'box', own: '`@` references in `~/.claude/CLAUDE.md`' },
      { id: 'oc@box', harness: 'opencode', host: 'local' },
    ],
  };
  const INSTR_REFS = {
    ok: true,
    agent: 'cc',
    host: 'box',
    root: '~/.claude/CLAUDE.md',
    rootState: 'managed',
    summary: '`@` references',
    refs: [],
  };

  const text = (h: Harness, sel: string): string[] =>
    Array.from(h.doc.querySelectorAll(sel)).map((e) => e.textContent ?? '');
  const clicks = (h: Harness) => h.calls.filter((c) => c.path === 'api/click').map((c) => c.body);

  /** A page with a topic on screen and one live settings screen delivered into it. */
  async function opened(msg: Record<string, unknown> = list(), o: Parameters<typeof open>[0] = {}): Promise<Harness> {
    const h = await open(o);
    await h.emit(sync(A, [], [A, B]));
    await h.emit({ t: 'msg', msg });
    return h;
  }

  it('draws the daemon’s screen in a page of its own, not in the transcript', async () => {
    const h = await opened();

    expect(h.el('settings-page').hidden).toBe(false);
    expect(text(h, '#settings-body .set-group')).toEqual(['Agents', 'Default model', 'Sub-agents', 'Conversations', 'More']);
    // The old grid is not drawn either: the page replaces it, it does not sit under it.
    expect(h.doc.querySelector('#log .btns')).toBeNull();
    // And the screen is not a message: nothing was added to the transcript for it.
    expect(h.painted()).toBe(0);
    expect(h.doc.querySelector('#log .set-card')).toBeNull();
    // The bar says where the settings live, not which topic they belong to: they belong to none.
    expect(h.el('settings-topic').textContent).toBe('Saved to config.yaml · every topic');
    expect(h.el('settings-topic').title).toBe('Opened from the topic “Topic ' + A + '”');
    expect(h.doc.querySelector('#settings-body .set-about')?.innerHTML).toContain('<code>/model</code>');
  });

  it('draws each kind of setting with its own control, from the kind the daemon names', async () => {
    const h = await opened();
    const body = h.el('settings-body');

    // On/off is a switch, in its state.
    const sw = body.querySelector('.set-switch');
    expect(sw?.getAttribute('role')).toBe('switch');
    expect(sw?.getAttribute('aria-checked')).toBe('true');
    expect(sw?.getAttribute('data-btn')).toBe('sts:r:2');
    expect(sw?.closest('.set-item')?.querySelector('.set-label')?.textContent).toBe('Confirm sub-agent starts');

    // Five or fewer short values: a segmented control, the current one checked.
    const seg = Array.from(body.querySelectorAll('.set-seg button'));
    expect(seg.map((b) => [b.textContent, b.getAttribute('aria-checked')])).toEqual([
      ['off', 'false'],
      ['15m', 'true'],
      ['1h', 'false'],
    ]);
    expect(seg[0]?.getAttribute('title')).toBe('never reclaim');

    // Longer values: a select, its options writing directly, the explanation beside the value.
    const selects = Array.from(body.querySelectorAll('select.set-select')) as HTMLSelectElement[];
    expect(selects.map((s) => s.getAttribute('aria-label'))).toEqual(['Default agent', 'Conversation scope']);
    expect(selects[1]!.value).toBe('sts:r:6');
    // The value alone, so a closed select is not a sentence cut in half; the meaning is its title.
    expect(Array.from(selects[1]!.options).map((o) => o.textContent)).toEqual(['per_thread', 'per_channel', 'per_user', 'shared']);
    expect(selects[1]!.options[0]!.title).toBe('a topic is its own conversation');

  });

  it('draws a model as a row that opens its own screen, and says when a change lands', async () => {
    const h = await opened();
    const body = h.el('settings-body');
    // Named by its agent, its value in full.
    const oc = body.querySelector('button.set-open[data-btn="stg:r:2"]');
    expect(oc?.querySelector('.set-label span')?.textContent).toBe('oc');
    expect(oc?.querySelector('.set-kind')?.textContent).toBe('OpenCode');
    expect(oc?.querySelector('.set-badge.here')?.textContent).toBe('this topic');
    expect(oc?.querySelector('.set-v')?.textContent).toBe(LONG_MODEL);
    expect(oc?.textContent).not.toContain('…');
    // Unset reads as a placeholder, not as a model called "(harness default)".
    const cc = body.querySelector('button.set-open[data-btn="stg:r:1"] .set-v');
    expect(cc?.textContent).toBe('harness default');
    expect(cc?.classList.contains('unset')).toBe(true);

    // When a change lands is a badge only where it is not "now", with the sentence behind it.
    const badges = Array.from(body.querySelectorAll('.set-badge.restart'));
    expect(badges.map((b) => [b.textContent, b.getAttribute('title')])).toEqual([
      ['after restart', 'takes effect when the daemon restarts'],
    ]);
    expect(text(h, '#settings-body .set-gnote')).toEqual(['What each agent starts a new session with.']);
    // The scheduled tasks are a way elsewhere: a row and a chevron, no value.
    const link = body.querySelector('button.set-open[data-btn="sco:r:0"]');
    expect(link?.querySelector('.set-v')).toBeNull();
    // Its name comes with the chat button's ⏰, which a font without emoji draws as a box: the
    // page draws its own clock instead, and the words after it are kept.
    const name = link?.querySelector('.set-label > span');
    expect(face(name)).toBe('[clock] Scheduled tasks · 1 active');
    expect(name?.textContent).not.toContain('⏰');
    expect(face(link?.querySelector('.set-chev'))).toBe('[chevronRight]');
    // One column of sections: no grid of rows left over from the two-column layout.
    expect(body.querySelector('.set-rows')).toBeNull();
  });

  /** Pick an option of a select the way a person does: the value, then the change event. */
  const choose = async (h: Harness, sel: string, value: string): Promise<HTMLSelectElement> => {
    const el = h.doc.querySelector(sel) as HTMLSelectElement;
    el.value = value;
    el.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await tick();
    return el;
  };

  /** Open one agent's card the way a person does: a tap on its summary. */
  const openCard = async (h: Harness, id: string): Promise<Element> => {
    await h.click(`#settings-body .ag-card[data-ag="${id}"] .ag-top`);
    return h.doc.querySelector(`#settings-body .ag-card[data-ag="${id}"]`)!;
  };
  const body = (card: Element): HTMLElement => card.querySelector('.ag-body') as HTMLElement;

  it('draws each agent as a card of its own: a summary, shut until it is tapped', async () => {
    const h = await opened(agentList());
    // No table: no header row, no column of cells.
    expect(h.doc.querySelector('#settings-body .ag-head, #settings-body .ag-cell')).toBeNull();
    const cards = Array.from(h.doc.querySelectorAll('#settings-body .ag-list > .ag-card'));
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['cc', 'oc@box']);
    // The default agent's own row stays above them, in a card of its own.
    expect(text(h, '#settings-body .set-sec > .set-card > .set-item .set-label > span')).toEqual(['Default agent']);
    expect(h.doc.querySelector('#settings-body .set-card .ag-card')).toBeNull();

    // Who it is and whether it answers this topic; what it is, its model and its level, in one line.
    const cc = cards[0]!;
    expect(cc.querySelector('.ag-name')?.textContent).toBe('cc');
    expect(cc.querySelector('.set-badge.here')?.textContent).toBe('this topic');
    expect(text(h, '#settings-body .ag-card[data-ag="cc"] .ag-sum > span:not(.ag-sep)')).toEqual(['Claude Code', 'harness default', 'ask']);
    // Not set is in italics, in the summary as on the controls, and the title says so.
    const sum = Array.from(cc.querySelectorAll('.ag-sum .unset'));
    expect(sum.map((s) => s.getAttribute('title'))).toEqual(['Model: harness default (not set)', 'Permissions: ask (not set)']);
    expect(cc.querySelector('.ag-kind')?.textContent).toBe('Claude Code');

    // Shut: the summary is a button that says so, and the settings are not shown.
    const top = cc.querySelector('.ag-top')!;
    expect(top.getAttribute('aria-expanded')).toBe('false');
    expect(top.getAttribute('aria-controls')).toBe(body(cc).id);
    expect(body(cc).hidden).toBe(true);
    expect(face(top.querySelector('.ag-chev'))).toBe('[chevronDown]');
    // Every control on a card is a redraw-surviving focus target.
    for (const el of Array.from(cc.querySelectorAll('button, select'))) expect(el.getAttribute('data-fk'), el.outerHTML).toBeTruthy();
    expect(text(h, '#settings-body .set-group')).toEqual(['Agents']);
    // Nothing was posted by drawing it.
    expect(clicks(h)).toEqual([]);
  });

  it('opens one card at a time, and posts nothing for it', async () => {
    const h = await opened(agentList());
    const cc = await openCard(h, 'cc');
    expect(cc.classList.contains('open')).toBe(true);
    expect(cc.querySelector('.ag-top')?.getAttribute('aria-expanded')).toBe('true');
    expect(body(cc).hidden).toBe(false);
    // Another card shuts the first.
    const oc = await openCard(h, 'oc@box');
    expect(body(oc).hidden).toBe(false);
    expect(body(h.doc.querySelector('.ag-card[data-ag="cc"]')!).hidden).toBe(true);
    expect(h.doc.querySelector('.ag-card[data-ag="cc"] .ag-top')?.getAttribute('aria-expanded')).toBe('false');
    // And a second tap shuts it.
    await openCard(h, 'oc@box');
    expect(h.doc.querySelectorAll('#settings-body .ag-card.open')).toHaveLength(0);
    expect(clicks(h)).toEqual([]);
  });

  it('keeps the open card open through the daemon’s answer, and forgets it when the page closes', async () => {
    const h = await opened(agentList());
    await openCard(h, 'oc@box');
    await h.emit({ t: 'msg', msg: agentList() });
    expect(h.doc.querySelector('#settings-body .ag-card.open')?.getAttribute('data-ag')).toBe('oc@box');
    await h.click('#settings-close');
    await h.emit({ t: 'msg', msg: agentList('m2') });
    expect(h.el('settings-page').hidden).toBe(false);
    expect(h.doc.querySelectorAll('#settings-body .ag-card.open')).toHaveLength(0);
  });

  it('lays an open card out as a label and a control per setting', async () => {
    const h = await opened(agentList());
    const cc = await openCard(h, 'cc');
    expect(Array.from(body(cc).querySelectorAll('.ag-field > .ag-lab')).map((l) => l.textContent)).toEqual(['Model', 'Permissions']);

    // Model is a value that opens its own screen, with a placeholder when nothing is set.
    const model = cc.querySelector('button.ag-open');
    expect(model?.getAttribute('data-btn')).toBe('stg:m:0');
    expect(model?.querySelector('.set-v')?.textContent).toBe('harness default');
    expect(model?.querySelector('.set-v')?.classList.contains('unset')).toBe(true);
    expect(face(model?.querySelector('.set-chev'))).toBe('[chevronRight]');

    // Five short levels side by side — the card has the width a table column did not — the current
    // one checked, and what it does said under them, with "not set" where it was never set.
    const seg = Array.from(cc.querySelectorAll('.set-seg button'));
    expect(seg.map((b) => [b.textContent, b.getAttribute('aria-checked')])).toEqual([
      ['plan', 'false'],
      ['ask', 'true'],
      ['edits', 'false'],
      ['auto', 'false'],
      ['full', 'false'],
    ]);
    expect(cc.querySelector('.set-seg')?.getAttribute('aria-label')).toBe('cc · Permissions');
    expect(Array.from(cc.querySelectorAll('.ag-field')[1]!.querySelectorAll('.ag-note > span:not([aria-hidden])')).map((s) => s.textContent)).toEqual([
      'asks before each step',
      'not set',
    ]);

    // A level that does not fit beside the others turns the control into a select.
    const oc = await openCard(h, 'oc@box');
    expect(oc.querySelector('.set-seg')).toBeNull();
    const sel = oc.querySelector('select.set-select') as HTMLSelectElement;
    expect(sel.value).toBe('sts:p:1:0');
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(['plan', 'ask', 'edits', 'auto', 'full', 'bypass permissions']);
    // A pod's model says where it comes from, on a line under it; the value is whole.
    expect(oc.querySelector('button.ag-open .set-v')?.textContent).toBe(LONG_MODEL);
    expect(oc.querySelector('.ag-field .ag-note')?.textContent).toBe('pod.yaml');
  });

  it('says where a level that is not set comes from', async () => {
    const pinned = agentList();
    const field = (pinned.settings as { rows: Array<Record<string, any>> }).rows[1]!.control.fields[1];
    field.valueNote = 'not set · from its pinned mode';
    const h = await opened(pinned);
    const cc = await openCard(h, 'cc');
    const note = cc.querySelectorAll('.ag-field')[1]!.querySelector('.ag-note');
    expect(Array.from(note!.querySelectorAll('span:not([aria-hidden])')).map((s) => s.textContent)).toEqual([
      'asks before each step',
      'not set · from its pinned mode',
    ]);
  });

  it('shows the only level an agent is offered as text, not as a control', async () => {
    const one = agentList();
    const rows = (one.settings as { rows: Array<Record<string, any>> }).rows;
    rows.push(agentRow('ag-api', 'fleetherd', { buttonId: 'stg:m:2', value: 'gemini' }, permissions('2', 0, ['auto'], { unset: true })));
    const h = await opened(one);
    const api = await openCard(h, 'ag-api');
    expect(api.querySelector('select, .set-seg')).toBeNull();
    expect(api.querySelector('.ag-fixed')?.textContent).toBe('auto');
    expect(api.querySelector('.ag-fixed')?.classList.contains('unset')).toBe(true);
  });

  it('opens an agent’s model from its card, by the field’s own button id', async () => {
    const h = await opened(agentList());
    await openCard(h, 'cc');
    await h.click('#settings-body .ag-card[data-ag="cc"] button.ag-open[data-btn="stg:m:0"]');
    expect(clicks(h)).toEqual([{ topic: A, messageId: 'm1', buttonId: 'stg:m:0' }]);
    expect(h.doc.querySelector('#settings-body button.ag-open[data-btn="stg:m:0"]')?.classList.contains('busy')).toBe(true);
  });

  it('comes back from a model’s screen to the card it left, open, on the control that left it', async () => {
    const h = await opened(agentList());
    await openCard(h, 'oc@box');
    await h.click('#settings-body .ag-card[data-ag="oc@box"] button.ag-open');
    await h.emit({ t: 'msg', msg: values() });
    expect(h.doc.querySelector('#settings-body .ag-card')).toBeNull();
    // The daemon sends the list again, as the back button or a picked model does.
    await h.emit({ t: 'msg', msg: agentList() });
    const oc = h.doc.querySelector('#settings-body .ag-card[data-ag="oc@box"]')!;
    expect(oc.classList.contains('open')).toBe(true);
    expect(h.doc.activeElement).toBe(oc.querySelector('button.ag-open'));
  });

  it('writes a permission level from the agent’s card, by the option’s button id', async () => {
    const h = await opened(agentList());
    await openCard(h, 'cc');
    await h.click('#settings-body .ag-card[data-ag="cc"] .set-seg button[data-btn="sts:p:0:3"]');
    expect(clicks(h)).toEqual([{ topic: A, messageId: 'm1', buttonId: 'sts:p:0:3' }]);
    // The level moves at once; the daemon's answer redraws it from what was written.
    expect(h.doc.querySelector('.ag-card[data-ag="cc"] .set-seg button[aria-checked="true"]')?.textContent).toBe('auto');
    const answered = agentList();
    const field = (answered.settings as { rows: Array<Record<string, any>> }).rows[1]!.control.fields[1];
    field.control.options.forEach((o: { current: boolean }, i: number) => (o.current = i === 3));
    field.value = 'auto';
    delete field.unset;
    delete field.valueNote;
    await h.emit({ t: 'msg', msg: answered });
    const cc = h.doc.querySelector('#settings-body .ag-card[data-ag="cc"]')!;
    expect(cc.querySelector('.set-seg button[aria-checked="true"]')?.textContent).toBe('auto');
    expect(cc.querySelector('.ag-sum .unset')?.textContent).toBe('harness default');
    // From the select too, where the levels do not fit side by side.
    await openCard(h, 'oc@box');
    await choose(h, '#settings-body .ag-card[data-ag="oc@box"] select.set-select', 'sts:p:1:5');
    expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'sts:p:1:5' });
  });

  it('groups the cards by the machine they run on, and marks the default agent', async () => {
    const m = agentList();
    const rows = (m.settings as { rows: Array<Record<string, any>> }).rows;
    rows[1]!.place = 'this machine';
    rows[1]!.defaultAgent = true;
    rows[2]!.place = 'box';
    rows.push({ ...agentRow('cx@box', 'Codex', { buttonId: 'stg:m:2', value: 'gpt' }, permissions('2', 3)), place: 'box' });
    const h = await opened(m);
    expect(text(h, '#settings-body .ag-place > span:first-child')).toEqual(['this machine', 'box']);
    expect(text(h, '#settings-body .ag-place .ag-count')).toEqual(['1', '2']);
    expect(Array.from(h.doc.querySelectorAll('#settings-body .ag-list > *')).map((e) => e.getAttribute('data-ag') ?? e.textContent)).toEqual([
      'this machine1',
      'cc',
      'box2',
      'oc@box',
      'cx@box',
    ]);
    expect(h.doc.querySelector('.ag-card[data-ag="cc"] .set-badge.def')?.textContent).toBe('default');
    expect(h.doc.querySelectorAll('#settings-body .set-badge.def')).toHaveLength(1);
    // One machine needs no heading.
    const one = await opened(agentList());
    expect(one.doc.querySelector('#settings-body .ag-place')).toBeNull();
  });

  it('colours each card by its harness, the same harness the same colour', async () => {
    const m = agentList();
    const rows = (m.settings as { rows: Array<Record<string, any>> }).rows;
    rows.push(agentRow('cc2', 'Claude Code', { buttonId: 'stg:m:2', value: 'x' }, permissions('2', 3)));
    const h = await opened(m);
    const hue = (id: string) => (h.doc.querySelector(`.ag-card[data-ag="${id}"]`) as HTMLElement).style.getPropertyValue('--ag-h');
    expect(hue('cc')).toBe(hue('cc2'));
    expect(hue('cc')).not.toBe(hue('oc@box'));
    // The built-in harnesses' names land on hues of their own.
    const hues = ['Claude Code', 'Codex', 'OpenCode', 'Antigravity', 'Gemini CLI', 'DeepSeek Harness'].map((kind) => {
      const one = agentList();
      (one.settings as { rows: Array<Record<string, any>> }).rows[1]!.targetKind = kind;
      return one;
    });
    const seen = new Set<string>();
    for (const msg of hues) {
      await h.emit({ t: 'msg', msg });
      seen.add(hue('cc'));
    }
    expect(seen.size).toBe(6);
  });

  it('lists the files an agent reads on its card: the shared ones, then its own', async () => {
    const h = await opened(agentList(), {
      instructions: true,
      replies: { 'api/instructions': INSTR, 'api/instructions/refs?agent=cc': INSTR_REFS },
    });
    // The list answers after the screen is drawn: the files join the card without a reopen.
    await until('the files', () => Boolean(h.doc.querySelector('#settings-body .ag-card[data-ag="cc"] [data-instr-agent]')));
    const cc = await openCard(h, 'cc');
    const files = Array.from(cc.querySelectorAll('.ag-instr .ag-file'));
    expect(files.map((f) => [f.getAttribute('data-instr-file'), f.querySelector('.ag-fname')?.textContent, f.querySelector('.ag-fsub')?.textContent])).toEqual([
      ['g:common.md', 'common.md', 'every agent · 1 reads it'],
      [null, 'Its own files', '@ references in ~/.claude/CLAUDE.md · box'],
    ]);
    expect(Array.from(files[1]!.querySelectorAll('code')).map((c) => c.textContent)).toEqual(['@', '~/.claude/CLAUDE.md']);
    for (const f of files) expect(f.getAttribute('data-fk')).toBeTruthy();
    expect(files[0]!.getAttribute('aria-label')).toBe('cc · common.md');
    // An agent whose harness reads nothing the gateway knows of is told so, with nothing to tap.
    const oc = await openCard(h, 'oc@box');
    expect(oc.querySelector('[data-instr-agent]')).toBeNull();
    expect(oc.querySelector('.ag-instr .ag-none')?.textContent).toBe('Its harness reads no instruction file the gateway knows of.');
    // No section of its own any more.
    expect(h.doc.querySelector('.instr-sec')).toBeNull();
    expect(text(h, '#settings-body .set-group')).toEqual(['Agents']);

    // Its own files open the window on that agent, with no file picked.
    await h.click('#settings-body .ag-card[data-ag="cc"] .ag-file:not([data-instr-file])');
    await until('the editor', () => h.el('files').hidden === false);
    expect(h.el('files-title').textContent).toBe('cc · instructions');
    await until('its files', () => h.calls.some((c) => c.path === 'api/instructions/refs?agent=cc'));
  });

  it('shows an instruction card as not delivering, and keeps its own files openable', async () => {
    const off = {
      ...INSTR,
      agents: [
        { id: 'cc', harness: 'claude', host: 'box', own: '`@` references in `~/.claude/CLAUDE.md`' },
        {
          id: 'oc@box',
          harness: 'opencode',
          host: 'local',
          file: '~/.config/opencode/AGENTS.md',
          own: 'the `instructions` list in `~/.config/opencode/opencode.json`',
          notDelivered: true,
        },
      ],
    };
    const h = await opened(agentList(), { instructions: true, replies: { 'api/instructions': off } });
    await until('the files', () => Boolean(h.doc.querySelector('#settings-body .ag-card[data-ag="cc"] [data-instr-agent]')));
    const oc = await openCard(h, 'oc@box');
    expect(oc.querySelector('[data-instr-file]')).toBeNull();
    expect(oc.querySelector('.ag-instr .ag-none')?.textContent).toBe(
      'Not delivering: its instruction file is already delivered to another agent on the same machine with a different layer.'
    );
    expect(oc.querySelector('.ag-file:not([data-instr-file])')?.textContent).toContain('Its own files');
  });

  it('names every control with the agent it belongs to, for a screen reader', async () => {
    const h = await opened(agentList(), { instructions: true, replies: { 'api/instructions': INSTR } });
    await until('the files', () => Boolean(h.doc.querySelector('#settings-body [data-instr-agent]')));
    expect(h.doc.querySelector('.ag-card[data-ag="cc"]')?.getAttribute('role')).toBe('group');
    expect(h.doc.querySelector('button.ag-open[data-fk="r1f0"]')?.getAttribute('aria-label')).toBe('cc · Model: harness default');
    expect(h.doc.querySelector('.ag-card[data-ag="cc"] .set-seg')?.getAttribute('aria-label')).toBe('cc · Permissions');
    expect(h.doc.querySelector('.ag-card[data-ag="oc@box"] select')?.getAttribute('aria-label')).toBe('oc@box · Permissions');
    expect(h.doc.querySelector('.ag-card[data-ag="cc"] .ag-file:not([data-instr-file])')?.getAttribute('aria-label')).toBe('cc · its own files');
  });

  it('does not redraw under a control still waiting on the daemon', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const h = await opened(agentList(), {
      instructions: true,
      replies: { 'api/instructions': INSTR },
      held: { 'api/instructions': held },
    });
    await openCard(h, 'oc@box');
    const tapped = await choose(h, '#settings-body .ag-card[data-ag="oc@box"] select.set-select', 'sts:p:1:3');
    expect(tapped.classList.contains('busy')).toBe(true);

    // The list arrives while that change is still out: the control keeps its state, and the
    // files wait for the answer that redraws the list anyway.
    release();
    await tick();
    await tick();
    expect(h.doc.querySelector('#settings-body .ag-card[data-ag="oc@box"] select.set-select')).toBe(tapped);
    expect(tapped.classList.contains('busy')).toBe(true);
    expect(tapped.disabled).toBe(true);
    expect(tapped.value).toBe('sts:p:1:3');
    expect(h.doc.querySelector('#settings-body [data-instr-agent]')).toBeNull();

    await h.emit({ t: 'msg', msg: agentList() });
    expect(h.doc.querySelector('#settings-body .ag-card[data-ag="cc"] [data-instr-agent="cc"]')).not.toBeNull();
  });

  it('keeps focus where it was when the instruction list arrives late', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const h = await opened(agentList(), {
      instructions: true,
      replies: { 'api/instructions': INSTR },
      held: { 'api/instructions': held },
    });
    await openCard(h, 'cc');
    const model = h.doc.querySelector('#settings-body button.ag-open[data-fk="r1f0"]') as HTMLButtonElement;
    model.focus();
    expect(h.doc.activeElement).toBe(model);

    release();
    await until('the files', () => Boolean(h.doc.querySelector('#settings-body [data-instr-agent]')));
    // The card is new markup; it is still open, and focus is back on the same control, by its key.
    expect(h.doc.querySelector('.ag-card[data-ag="cc"]')?.classList.contains('open')).toBe(true);
    expect(h.doc.activeElement?.getAttribute('data-fk')).toBe('r1f0');
    expect(h.doc.activeElement).not.toBe(model);
  });

  it('flips a switch in one tap, showing the new state before the daemon answers', async () => {
    const h = await opened();
    await h.click('#settings-body .set-switch');
    expect(clicks(h)).toEqual([{ topic: A, messageId: 'm1', buttonId: 'sts:r:2' }]);
    const sw = h.el('settings-body').querySelector('.set-switch');
    expect(sw?.getAttribute('aria-checked')).toBe('false');
    expect(sw?.classList.contains('busy')).toBe(true);

    // The daemon's answer redraws the row from what it wrote, with a banner saying so.
    const answered = withScreen((s) => {
      s.rows[3]!.control = { kind: 'switch', on: false, set: 'sts:r:2' };
      s.notice = { tone: 'ok', text: '✓ Confirm sub-agent starts → off\nSaved to config.yaml · in effect now.' };
    });
    await h.emit({ t: 'msg', msg: answered });
    const after = h.el('settings-body').querySelector('.set-switch');
    expect(after?.getAttribute('aria-checked')).toBe('false');
    expect(after?.classList.contains('busy')).toBe(false);
    const banner = h.el('settings-body').querySelector('.set-notice');
    expect(banner?.classList.contains('ok')).toBe(true);
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.textContent).toContain('Confirm sub-agent starts → off');
  });

  it('flips a switch from anywhere on its row, the label included', async () => {
    const h = await opened();
    await h.click('#settings-body .set-item.sw .set-label');
    expect(clicks(h)).toEqual([{ topic: A, messageId: 'm1', buttonId: 'sts:r:2' }]);
  });

  it('writes a segment and a select value straight from the row', async () => {
    const h = await opened();
    await h.click('#settings-body .set-seg button[data-btn="sts:r:5"]');
    expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'sts:r:5' });
    expect(h.doc.querySelector('#settings-body .set-seg button[data-btn="sts:r:5"]')?.getAttribute('aria-checked')).toBe('true');
    expect(h.doc.querySelector('#settings-body .set-seg button[data-btn="sts:r:4"]')?.getAttribute('aria-checked')).toBe('false');

    await h.emit({ t: 'msg', msg: list() });
    const scope = h.doc.querySelectorAll('#settings-body select.set-select')[1] as HTMLSelectElement;
    scope.value = 'sts:r:8';
    scope.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await tick();
    expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'sts:r:8' });
    expect(scope.disabled).toBe(true);
  });

  it('shows a value no option names in the select, rather than a wrong one', async () => {
    const h = await opened(
      withScreen((s) => {
        s.rows[0]!.value = 'gone · claude';
        s.rows[0]!.control.options.forEach((o: { current: boolean }) => (o.current = false));
      })
    );
    const agent = h.doc.querySelector('#settings-body select.set-select') as HTMLSelectElement;
    expect(agent.selectedOptions[0]?.textContent).toBe('gone · claude');
    expect(agent.selectedOptions[0]?.disabled).toBe(true);
  });

  it('says why when the daemon refuses a value, in a banner of its own', async () => {
    const h = await opened(
      withScreen((s) => {
        s.notice = { tone: 'error', text: 'Could not save Idle reclaim: `config.yaml` is read-only' };
      })
    );
    const banner = h.el('settings-body').querySelector('.set-notice');
    expect(banner?.classList.contains('error')).toBe(true);
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.innerHTML).toBe('Could not save Idle reclaim: <code>config.yaml</code> is read-only');
    // It stays where it can be seen however far down the control was, and does not fade.
    expect(renderPage('Chat', false)).toMatch(/\.set-notice\{position:sticky;top:-14px/);
    await new Promise((r) => setTimeout(r, 50));
    expect(banner?.classList.contains('faded')).toBe(false);
  });

  it('escapes what the daemon says before keeping its code spans', async () => {
    const h = await opened(
      withScreen((s) => {
        s.notice = { tone: 'info', text: '<img src=x onerror=alert(1)> `<b>`' };
      })
    );
    const banner = h.el('settings-body').querySelector('.set-notice');
    expect(banner?.querySelector('img')).toBeNull();
    expect(banner?.innerHTML).toBe('&lt;img src=x onerror=alert(1)&gt; <code>&lt;b&gt;</code>');
  });

  it('puts a switch back and says so when the request cannot reach the daemon', async () => {
    const h = await opened(list(), { hang: ['api/click'], shortenLong: true });
    await h.click('#settings-body .set-switch');
    expect(h.el('settings-body').querySelector('.set-switch')?.getAttribute('aria-checked')).toBe('false');
    // Three attempts, each cut at the page's own limit rather than waiting for ever.
    await new Promise((r) => setTimeout(r, 2000));
    expect(h.longTimers).toContain(15000);
    const sw = h.el('settings-body').querySelector('.set-switch');
    expect(sw?.getAttribute('aria-checked')).toBe('true');
    expect((sw as HTMLButtonElement).disabled).toBe(false);
    const banner = h.el('settings-body').querySelector('.set-notice.error');
    expect(banner?.textContent).toContain('Could not reach the daemon, so nothing was changed');
    // The next screen from the daemon replaces the page's own line.
    await h.emit({ t: 'msg', msg: list() });
    expect(h.el('settings-body').querySelector('.set-notice')).toBeNull();
  });

  it('says the page is out of date when the daemon no longer has its message', async () => {
    const h = await opened(list(), { status: { 'api/click': 409 } });
    await h.click('#settings-body .set-seg button[data-btn="sts:r:3"]');
    const banner = h.el('settings-body').querySelector('.set-notice.error');
    expect(banner?.textContent).toContain('out of date');
    // Redrawn from what it had: 15m is still the one checked.
    expect(h.doc.querySelector('#settings-body .set-seg button[aria-checked="true"]')?.textContent).toBe('15m');
  });

  it('keeps focus on the control that was used when the answer redraws the page', async () => {
    const h = await opened();
    const sw = h.el('settings-body').querySelector('.set-switch') as HTMLButtonElement;
    sw.focus();
    await h.click('#settings-body .set-switch');
    await h.emit({ t: 'msg', msg: list() });
    expect(h.doc.activeElement?.classList.contains('set-switch')).toBe(true);
  });

  it('marks the current value in the value list, under a head that says what the setting is', async () => {
    const h = await opened(values());
    expect(h.doc.querySelector('.btns')).toBeNull();

    const current = h.doc.querySelector('#settings-body .set-opt.on');
    expect(current?.getAttribute('data-btn')).toBe('stv:r:1');
    expect(current?.getAttribute('aria-current')).toBe('true');
    expect(face(current?.querySelector('.set-check'))).toBe('[check]');
    expect(current?.querySelector('.set-opt-label')?.textContent).toBe('15m');

    const off = h.doc.querySelector('#settings-body button[data-btn="stv:r:0"]');
    expect(off?.classList.contains('on')).toBe(false);
    expect(face(off?.querySelector('.set-check'))).toBe('');
    expect(off?.querySelector('.set-opt-detail')?.textContent).toBe('never reclaim');

    expect(h.doc.querySelector('#settings-body .set-head h3')?.textContent).toBe('Idle reclaim');
    expect(h.doc.querySelector('#settings-body .set-now')?.textContent).toBe('Now: 15m');
    expect(h.doc.querySelector('#settings-body .set-when')?.textContent).toBe('Changes in effect now.');
    // Back is at the top, where a settings sub-page keeps it.
    expect(h.el('settings-body').firstElementChild?.getAttribute('data-btn')).toBe('stb:r:0');
  });

  it('opens a model by posting its row id, and the daemon’s edit turns the list into values', async () => {
    const h = await opened();

    await h.click('#settings-body button[data-btn="stg:r:2"]');
    expect(clicks(h)).toEqual([{ topic: A, messageId: 'm1', buttonId: 'stg:r:2' }]);

    await h.emit({ t: 'msg', msg: values() });
    expect(h.doc.querySelector('#settings-body .set-opt')).not.toBeNull();
    expect(h.doc.querySelector('#settings-body .set-sec')).toBeNull();
  });

  it('writes the value the row names, and the list comes back with the new value on it', async () => {
    const h = await opened(values());

    await h.click('#settings-body button[data-btn="stv:r:2"]');
    expect(clicks(h)).toEqual([{ topic: A, messageId: 'm1', buttonId: 'stv:r:2' }]);

    const updated = withScreen((s) => {
      s.rows[2]!.value = 'newapi/glm-5';
    });
    await h.emit({ t: 'msg', msg: updated });
    expect(h.doc.querySelector('#settings-body .set-opt')).toBeNull();
    expect(h.doc.querySelector('#settings-body button[data-btn="stg:r:2"] .set-v')?.textContent).toBe('newapi/glm-5');
  });

  it('posts the Back id, which is how the daemon puts the list back on the same message', async () => {
    const h = await opened(values());

    await h.click('#settings-body button[data-btn="stb:r:0"]');
    expect(clicks(h)).toEqual([{ topic: A, messageId: 'm1', buttonId: 'stb:r:0' }]);
  });

  it('pages with the ids the daemon drew, and shows which page this is', async () => {
    const paged = values();
    paged.settings = {
      level: 'values',
      options: [
        { buttonId: 'stv:r:2', label: '1h', current: false },
        { buttonId: 'stv:r:3', label: '4h', current: false },
      ],
      nav: { page: 2, pageCount: 3, prev: 'stp:r:0', next: 'stp:r:2', back: 'stb:r:0' },
    };
    const h = await opened(paged);

    expect(h.doc.querySelector('#settings-body .set-page')?.textContent).toBe('2 / 3');
    await h.click('#settings-body button[data-btn="stp:r:2"]');
    expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'stp:r:2' });

    // A repaint re-enables the button, as every other menu relies on.
    await h.emit({ t: 'msg', msg: paged });
    await h.click('#settings-body button[data-btn="stp:r:0"]');
    expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'stp:r:0' });
  });

  it('asks the daemon quietly from the Settings menu, and never posts a bubble for it', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A, B]));

    await h.click('#opts-toggle');
    await h.click('#settings-open');

    // The page is up before the answer, so a slow daemon reads as loading rather than as nothing.
    expect(h.el('settings-page').hidden).toBe(false);
    expect(h.el('settings-body').textContent).toContain('Loading settings');

    const sent = h.calls.find((c) => c.path === 'api/send');
    expect(sent?.body.text).toBe('/setting');
    expect(sent?.body.topic).toBe(A);
    // A control the operator pressed must not become a message they never wrote.
    expect(sent?.body.quiet).toBe(true);
    expect(h.painted()).toBe(0);

    await h.emit({ t: 'msg', msg: list() });
    expect(text(h, '#settings-body .set-group')).toContain('Agents');
    expect(h.painted()).toBe(0);
  });

  it('opens on a typed /setting too, and leaves only the command in the transcript', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));

    const input = h.el('input') as HTMLTextAreaElement;
    input.value = '/setting';
    await h.click('#composer button[type="submit"]');

    const sent = h.calls.find((c) => c.path === 'api/send');
    expect(sent?.body.text).toBe('/setting');
    expect(sent?.body.quiet).toBeUndefined();
    // The operator's own command is their message and stays; the screen does not.
    expect(h.painted()).toBe(1);

    await h.emit({ t: 'msg', msg: list() });
    expect(h.el('settings-page').hidden).toBe(false);
    expect(h.painted()).toBe(1);
    expect(h.doc.querySelector('#log .set-card')).toBeNull();
  });

  it('keeps a retired screen out of the transcript, and a new one replaces the page', async () => {
    const h = await opened();

    // The daemon retires a menu by editing it with no buttons; room.revise marks it so a reload
    // cannot turn its farewell line into a chat message.
    const retired = { ...list(), buttons: [], wasSettings: true } as Record<string, unknown>;
    delete retired.settings;
    await h.emit({ t: 'msg', msg: retired });
    expect(h.painted()).toBe(0);
    // The page stays up: the menu was retired because a new one is about to arrive.
    expect(h.el('settings-page').hidden).toBe(false);

    await h.emit({ t: 'msg', msg: values('m2') });
    expect(h.doc.querySelector('#settings-body .set-opt')).not.toBeNull();
    expect(h.painted()).toBe(0);

    // A message restored from another run is history: it is not a message on screen either.
    await h.emit(sync(A, [{ ...list('m3'), g: 2 }], [A]));
    expect(h.painted()).toBe(0);
    expect(h.doc.querySelector('#log .set-card')).toBeNull();
  });

  it('closes on the ×, on Escape, on the backdrop, and when the topic changes', async () => {
    const h = await opened();
    const shut = (): boolean => h.el('settings-page').hidden;

    await h.click('#settings-close');
    expect(shut()).toBe(true);

    await h.emit({ t: 'msg', msg: list('m2') });
    expect(shut()).toBe(false);
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();
    expect(shut()).toBe(true);

    await h.emit({ t: 'msg', msg: list('m3') });
    h.doc.getElementById('settings-page')!.click();
    await tick();
    expect(shut()).toBe(true);

    await h.emit({ t: 'msg', msg: list('m4') });
    expect(shut()).toBe(false);
    await h.click('[data-topic="' + B + '"]');
    expect(shut()).toBe(true);
  });

  it('does not reopen a page the operator closed when the daemon edits that message', async () => {
    const h = await opened();
    await h.click('#settings-close');
    expect(h.el('settings-page').hidden).toBe(true);

    // An edit of the same message (a value list, say) is not a new /setting: it stays closed.
    await h.emit({ t: 'msg', msg: values() });
    expect(h.el('settings-page').hidden).toBe(true);
    expect(h.painted()).toBe(0);
  });

  it('does not reopen a page closed while it was still Loading — and a new request still opens', async () => {
    const h = await open();
    await h.emit(sync(A, [], [A]));

    await h.click('#opts-toggle');
    await h.click('#settings-open');
    expect(h.el('settings-page').hidden).toBe(false);
    expect(h.el('settings-body').textContent).toContain('Loading settings');
    await h.click('#settings-close');
    expect(h.el('settings-page').hidden).toBe(true);

    // The answer to the request that was cancelled on the way out must not reopen the page.
    await h.emit({ t: 'msg', msg: list('m1') });
    expect(h.el('settings-page').hidden).toBe(true);
    expect(h.painted()).toBe(0);

    // A later request has a later token, so its answer does open.
    await h.click('#opts-toggle');
    await h.click('#settings-open');
    await h.emit({ t: 'msg', msg: list('m2') });
    expect(h.el('settings-page').hidden).toBe(false);
    expect(text(h, '#settings-body .set-group')).toContain('Agents');
  });

  it('does not let a cancelled request in one topic swallow an answer in another', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A, B]));

    await h.click('#opts-toggle');
    await h.click('#settings-open');
    await h.click('#settings-close');

    // Another topic, and a /setting the operator typed there: its answer is not the one the
    // cancelled request in A is waiting for.
    await h.click('[data-topic="' + B + '"]');
    const input = h.el('input') as HTMLTextAreaElement;
    input.value = '/setting';
    await h.click('#composer button[type="submit"]');
    await h.emit({ t: 'msg', msg: list('mB') });

    expect(h.el('settings-page').hidden).toBe(false);
    expect(h.el('settings-topic').title).toBe('Opened from the topic “Topic ' + B + '”');
    // And its controls post into B, where its message is.
    await h.click('#settings-body .set-switch');
    expect(clicks(h).at(-1)).toEqual({ topic: B, messageId: 'mB', buttonId: 'sts:r:2' });
  });

  it('says the daemon did not answer instead of sitting on Loading for ever', async () => {
    const h = await open({ shortenLong: true });
    await h.emit(sync(A, [], [A]));

    await h.click('#opts-toggle');
    await h.click('#settings-open');
    expect(h.el('settings-body').textContent).toContain('Loading settings');

    await new Promise((r) => setTimeout(r, 60));
    expect(h.el('settings-body').textContent).toContain('did not answer');
    // The wait is the send's own patience, and it is a real timer rather than a permanent state.
    expect(h.longTimers).toContain(15000);
  });

  it('puts the page away when the message becomes the scheduled-task menu', async () => {
    const h = await opened();
    await h.click('#settings-body button[data-btn="sco:r:0"]');
    expect(clicks(h)).toEqual([{ topic: A, messageId: 'm1', buttonId: 'sco:r:0' }]);
    // The daemon hands the settings message to the task list: buttons, no screen. That is a menu
    // again, so the page goes and the menu is painted in the transcript.
    await h.emit({
      t: 'msg',
      msg: { ...message('m1', '<p>Scheduled tasks</p>'), buttons: [{ id: 'sct:r:0', label: 'Morning CI' }] },
    });
    expect(h.el('settings-page').hidden).toBe(true);
    expect(h.painted()).toBe(1);
    expect(h.doc.querySelector('#log button[data-btn="sct:r:0"]')).not.toBeNull();
  });

  describe('a model’s own screen', () => {
    const models = Array.from({ length: 12 }, (_, i) => ({
      buttonId: 'stv:r:' + i,
      label: i === 3 ? 'newapi/kimi-k3' : 'opencode/model-' + i,
      ...(i === 3 ? { detail: 'Kimi K3' } : {}),
      current: i === 0,
    }));
    const modelScreen = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      ...message('m1', '<p>Default model</p>'),
      buttons: [],
      settings: {
        level: 'values',
        head: {
          label: 'Default model',
          target: 'oc@box',
          targetKind: 'OpenCode',
          value: 'opencode/model-0',
          description: 'The model `oc@box` starts its sessions with.',
          effect: 'Takes effect from oc@box’s next agent session.',
          source: "From box's pod.yaml. A model chosen here is kept in the gateway's config.yaml and wins over the pod's.",
        },
        typed: { buttonId: 'stt:r:0', placeholder: 'Or type a model name' },
        options: models,
        nav: { page: 1, pageCount: 1, back: 'stb:r:0' },
        ...over,
      },
    });

    it('says whose value it is, and filters a long list as it is typed into', async () => {
      const h = await opened(modelScreen());
      expect(h.doc.querySelector('#settings-body .set-src')?.textContent).toContain("From box's pod.yaml");
      const field = h.doc.querySelector('#settings-body .set-type') as HTMLInputElement;
      expect(field.placeholder).toBe('Filter, or type a model name');
      field.value = 'kimi';
      field.dispatchEvent(new h.window.Event('input', { bubbles: true }));
      const shown = Array.from(h.doc.querySelectorAll('#settings-body .set-opt')).filter((o) => !(o as HTMLElement).hidden);
      // Matched on the name under the id too.
      expect(shown.map((o) => o.getAttribute('data-btn'))).toEqual(['stv:r:3']);
      expect((h.doc.querySelector('#settings-body .set-nomatch') as HTMLElement).hidden).toBe(true);
      field.value = 'zzz';
      field.dispatchEvent(new h.window.Event('input', { bubbles: true }));
      expect((h.doc.querySelector('#settings-body .set-nomatch') as HTMLElement).hidden).toBe(false);
    });

    it('takes a typed name with Use or Enter, carried as the click’s value', async () => {
      const h = await opened(modelScreen());
      const field = h.doc.querySelector('#settings-body .set-type') as HTMLInputElement;
      field.value = '  opencode/unlisted  ';
      await h.click('#settings-body .set-use');
      expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'stt:r:0', value: 'opencode/unlisted' });

      await h.emit({ t: 'msg', msg: modelScreen() });
      const again = h.doc.querySelector('#settings-body .set-type') as HTMLInputElement;
      again.value = 'glm';
      again.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
      expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'stt:r:0', value: 'glm' });
      // Nothing typed: nothing posted.
      const n = clicks(h).length;
      await h.emit({ t: 'msg', msg: modelScreen() });
      (h.doc.querySelector('#settings-body .set-type') as HTMLInputElement).value = ' ';
      await h.click('#settings-body .set-use');
      expect(clicks(h)).toHaveLength(n);
    });

    it('shows the list being asked for, and keeps what was typed when it arrives', async () => {
      const h = await opened(
        modelScreen({ loading: true, options: [], head: { label: 'Default model', target: 'oc@box', value: 'harness default', unset: true, description: 'd', effect: 'e', hint: 'Asking oc@box for its models… A name can be typed meanwhile.' } })
      );
      const box = h.doc.querySelector('#settings-body .set-hintbox');
      expect(box?.classList.contains('loading')).toBe(true);
      expect(box?.querySelector('.set-spin')).not.toBeNull();
      const field = h.doc.querySelector('#settings-body .set-type') as HTMLInputElement;
      field.value = 'kimi';
      field.dispatchEvent(new h.window.Event('input', { bubbles: true }));

      await h.emit({ t: 'msg', msg: modelScreen() });
      expect(h.doc.querySelector('#settings-body .set-hintbox')).toBeNull();
      expect((h.doc.querySelector('#settings-body .set-type') as HTMLInputElement).value).toBe('kimi');
      const shown = Array.from(h.doc.querySelectorAll('#settings-body .set-opt')).filter((o) => !(o as HTMLElement).hidden);
      expect(shown).toHaveLength(1);
    });

    it('marks a pod agent’s value on the list with where it comes from', async () => {
      const h = await opened(
        withScreen((s) => {
          s.rows[2]!.valueNote = 'pod.yaml';
        })
      );
      expect(h.doc.querySelector('#settings-body button[data-btn="stg:r:2"] .set-vnote')?.textContent).toBe('pod.yaml');
      expect(h.doc.querySelector('#settings-body button[data-btn="stg:r:1"] .set-vnote')).toBeNull();
    });
  });

  describe('on a phone', () => {
    const narrow = (): string => {
      const html = renderPage('Chat', false);
      const at = html.indexOf('@media(max-width:640px){');
      let depth = 0;
      for (let i = html.indexOf('{', at); i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
      }
      throw new Error('unclosed');
    };

    it('takes the whole screen, and puts a control under its text rather than beside it', () => {
      const css = narrow();
      expect(css).toContain('#settings-box{width:100%;height:100%');
      // One column per row; a switch alone keeps its place on the right, where a thumb looks for it.
      expect(css).toContain('.set-item{grid-template-columns:minmax(0,1fr);');
      expect(css).toContain('.set-item.sw{grid-template-columns:minmax(0,1fr) auto}');
      expect(css).toContain('.set-seg{display:flex;width:100%}');
      // A model's value goes under its agent instead of fighting it for the width.
      expect(css).toContain('.set-open>.set-vv{grid-column:1;grid-row:2;');
      // And none of that leaks onto the desktop.
      const desktop = renderPage('Chat', false).replace(css, '');
      expect(desktop).not.toContain('.set-item{grid-template-columns:minmax(0,1fr);');
    });

    it('keeps every control a finger target, and a select at 16px so Safari does not zoom', () => {
      const css = narrow();
      expect(css).toMatch(/\.set-switch\{[^}]*height:44px/);
      expect(css).toMatch(/\.set-select\{[^}]*min-height:44px[^}]*font-size:16px/);
      expect(css).toMatch(/\.set-seg button\{[^}]*min-height:40px/);
      expect(css).toMatch(/#settings-close\{[^}]*min-width:44px;height:44px/);
      expect(css).toMatch(/\.set-back\{min-height:44px\}/);
      const html = renderPage('Chat', false);
      expect(html).toMatch(/\.set-opt\{[^}]*min-height:44px/);
      expect(html).toMatch(/\.set-nav button\{[^}]*min-height:44px/);
    });

    it('stacks an open card’s labels over their controls, at the height a thumb needs', () => {
      const css = narrow();
      // One column inside an open card: the label on top, the control the card's whole width.
      expect(css).toContain('.ag-field{grid-template-columns:minmax(0,1fr);row-gap:6px}');
      expect(css).toContain('.ag-val>.set-select,.ag-open,.ag-files{max-width:none}');
      expect(css).toMatch(/\.ag-open,\.ag-fixed\{min-height:44px\}/);
      expect(css).toMatch(/\.ag-file\{min-height:44px/);
      expect(css).toMatch(/\.ag-top\{min-height:56px/);
      // None of that leaks onto the desktop, which keeps a label column beside the controls.
      const desktop = renderPage('Chat', false).replace(css, '');
      expect(desktop).toContain('.ag-field{display:grid;grid-template-columns:104px minmax(0,1fr)');
      expect(desktop).not.toContain('.ag-field{grid-template-columns:minmax(0,1fr)');
      // The cards stand apart at every width: a gap between them, each with an edge of its own.
      expect(desktop).toMatch(/\.ag-list\{[^}]*gap:8px/);
      expect(desktop).toMatch(/\.ag-card\{[^}]*border-left:3px solid var\(--ag\)/);
    });

    it('works the same controls at phone width', async () => {
      const h = await opened(list(), { width: 390, height: 844 });
      await h.click('#settings-body .set-item.sw .set-hint');
      expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'sts:r:2' });
      await h.click('#settings-body .set-seg button[data-btn="sts:r:5"]');
      expect(clicks(h).at(-1)).toEqual({ topic: A, messageId: 'm1', buttonId: 'sts:r:5' });
    });
  });
});

describe('webui page: the command list above the composer', () => {
  // As registerCommands hands them over: `/super` carries its argument as the one required option
  // (core/command-translate.ts genericCommandSpecs), `/new` carries none.
  const commands = [
    { name: 'new', description: 'Start a fresh conversation (clears context)' },
    { name: 'stop', description: 'Stop the current turn' },
    {
      name: 'super',
      description: 'Split a job across agents working in parallel (sub-agents)',
      options: [{ name: 'job', description: 'The job to split up', type: 'string', required: true }],
    },
  ];
  async function typed(h: Awaited<ReturnType<typeof open>>, value: string): Promise<void> {
    const input = h.el('input') as HTMLTextAreaElement;
    input.value = value;
    input.dispatchEvent(new h.window.Event('input'));
    await tick();
  }

  it('says what a command takes once it is chosen, and stops at the first character of it', async () => {
    const h = await open();
    await h.emit({ ...sync('a1b2c3d4', [], ['a1b2c3d4']), commands });
    await typed(h, '/su');
    expect(Array.from(h.el('hints').querySelectorAll('button')).map((b) => b.textContent)).toEqual(['/super']);

    await h.click('#hints button[data-cmd="super"]');
    expect((h.el('input') as HTMLTextAreaElement).value).toBe('/super ');
    // The list it was picked from is gone, and so is the button title that was the only place the
    // description showed — never, on a phone. The row now says what comes next.
    expect(h.el('hints').hidden).toBe(false);
    expect(h.el('hints').querySelector('button')).toBeNull();
    expect(h.el('hints').textContent).toBe('/super <job> — Split a job across agents working in parallel (sub-agents)');

    await typed(h, '/super s');
    expect(h.el('hints').hidden).toBe(true);
  });

  it('shows nothing after a command that takes nothing, as before', async () => {
    const h = await open();
    await h.emit({ ...sync('a1b2c3d4', [], ['a1b2c3d4']), commands });
    await typed(h, '/ne');
    await h.click('#hints button[data-cmd="new"]');
    expect((h.el('input') as HTMLTextAreaElement).value).toBe('/new ');
    expect(h.el('hints').hidden).toBe(true);
  });

  it('offers only what the daemon registered here, which on a chat platform has no /super', async () => {
    const h = await open();
    await h.emit({ ...sync('a1b2c3d4', [], ['a1b2c3d4']), commands: commands.filter((c) => c.name !== 'super') });
    await typed(h, '/s');
    expect(Array.from(h.el('hints').querySelectorAll('button')).map((b) => b.textContent)).toEqual(['/stop']);
    await typed(h, '/super ');
    expect(h.el('hints').hidden).toBe(true);
  });
});

describe('webui page: the sidebar width', () => {
  it('follows a drag of its edge, within bounds, keeps it, and goes back on a double-click', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    const sidebar = h.el('sidebar');
    const handle = h.el('sidebar-resize');
    const drag = async (x: number): Promise<void> => {
      // MouseEvent under the pointer names: jsdom's sidebar sits at left 0, so x is the width.
      handle.dispatchEvent(new h.window.MouseEvent('pointerdown', { bubbles: true, clientX: 240 }));
      h.doc.dispatchEvent(new h.window.MouseEvent('pointermove', { bubbles: true, clientX: x }));
      h.doc.dispatchEvent(new h.window.MouseEvent('pointerup', { bubbles: true, clientX: x }));
      await tick();
    };

    await drag(400);
    expect(sidebar.style.getPropertyValue('--pw')).toBe('400px');
    expect(h.window.localStorage.getItem('aa_sb_w')).toBe('400');

    await drag(40);
    expect(sidebar.style.getPropertyValue('--pw')).toBe('180px');

    handle.dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true }));
    expect(sidebar.style.getPropertyValue('--pw')).toBe('');
    expect(h.window.localStorage.getItem('aa_sb_w')).toBeNull();
  });

  it('comes back at the width it was left at', async () => {
    const h = await open({ storage: { aa_sb_w: '320' } });
    expect(h.el('sidebar').style.getPropertyValue('--pw')).toBe('320px');
  });
});

