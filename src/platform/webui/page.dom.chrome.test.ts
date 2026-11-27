import { describe, it, expect, vi } from 'vitest';
import {
  renderPage,
  renderWebMarkdown,
  renderWebToolLines,
  webMessageHtml,
  tick,
  saved,
  until,
  within,
  opens,
  sync,
  message,
  face,
  open,
  type Harness,
} from './page.dom.test-helpers.js';

describe('webui page: the model switch in the status line', () => {
  const T = 'a1b2c3d4';
  const OTHER = 'b2c3d4e5';
  const OC = { agent: 'oc@p', model: 'opencode/glm-5', effort: 'high' };
  const LIST = {
    ok: true,
    agent: 'oc@p',
    current: 'opencode/glm-5',
    configured: 'opencode/big-pickle',
    options: [
      { value: 'opencode/big-pickle', name: 'Big Pickle' },
      { value: 'opencode/glm-5', name: 'GLM-5' },
      ...Array.from({ length: 10 }, (_, i) => ({ value: `newapi/model-${i}`, name: `Model ${i}` })),
      { value: 'newapi/kimi-k3', name: 'Kimi K3' },
    ],
  };
  const URL_T = `api/models?t=${T}`;
  const chip = (h: Harness) => h.doc.querySelector('#status .st-model') as HTMLButtonElement | null;
  const pop = (h: Harness) => h.el('model-pop');
  const rows = (h: Harness) => Array.from(h.doc.querySelectorAll('#mp-list .mp-opt')) as HTMLButtonElement[];

  async function ready(o: Parameters<typeof open>[0] = {}): Promise<Harness> {
    const h = await open({ ...o, replies: { [URL_T]: LIST, 'api/models': { ok: true, model: 'newapi/kimi-k3', text: 'Model set to `newapi/kimi-k3` for this conversation.' }, ...(o.replies ?? {}) } });
    await h.emit(sync(T, [message('m1', '<p>hi</p>')], [T, OTHER]));
    await h.emit({ t: 'status', status: OC });
    return h;
  }

  it('makes the model in the status line a button, without changing what the line says', async () => {
    const h = await ready();
    expect(chip(h)?.textContent).toBe('opencode/glm-5');
    expect(h.el('status').textContent).toContain('oc@p · opencode/glm-5 · high');
    expect(chip(h)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the list the agent offers, with the one in use ticked and the default marked', async () => {
    const h = await ready();
    await h.click('#status .st-model');
    expect(pop(h).hidden).toBe(false);
    // A tap on the switch is not a tap on the line: it does not open the line's details.
    expect(h.el('status').classList.contains('open')).toBe(false);
    expect(h.calls.find((c) => c.path === URL_T)).toBeTruthy();
    await tick();
    expect(h.el('mp-agent').textContent).toBe('oc@p');
    expect(rows(h)).toHaveLength(13);
    const on = rows(h).find((r) => r.classList.contains('on'));
    expect(on?.getAttribute('data-v')).toBe('opencode/glm-5');
    expect(on?.getAttribute('aria-selected')).toBe('true');
    const def = rows(h).find((r) => r.querySelector('.mp-tag'));
    expect(def?.getAttribute('data-v')).toBe('opencode/big-pickle');
    expect(def?.querySelector('.mp-n')?.textContent).toBe('Big Pickle');
    expect(chip(h)?.getAttribute('aria-expanded')).toBe('true');
  });

  it('says it is asking while a cold agent starts', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const h = await ready({ held: { [URL_T]: held } });
    await h.click('#status .st-model');
    expect(h.el('mp-list').textContent).toContain('Asking the agent for its models');
    expect(h.el('mp-list').querySelector('.set-spin')).not.toBeNull();
    release();
    await tick();
    await tick();
    expect(rows(h)).toHaveLength(13);
  });

  it('filters a long list as it is typed into', async () => {
    const h = await ready();
    await h.click('#status .st-model');
    await tick();
    expect(h.el('mp-filter').hidden).toBe(false);
    const f = h.el('mp-filter') as HTMLInputElement;
    f.value = 'kimi';
    f.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect(rows(h).filter((r) => !r.hidden).map((r) => r.getAttribute('data-v'))).toEqual(['newapi/kimi-k3']);
    // By name too.
    f.value = 'pickle';
    f.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect(rows(h).filter((r) => !r.hidden).map((r) => r.getAttribute('data-v'))).toEqual(['opencode/big-pickle']);
  });

  it('switches with a tap, as /model does, and the line says the new model at once', async () => {
    const h = await ready();
    await h.click('#status .st-model');
    await tick();
    await h.click('#mp-list .mp-opt[data-v="newapi/kimi-k3"]');
    await tick();
    expect(h.calls.find((c) => c.path === 'api/models')?.body).toEqual({ topic: T, value: 'newapi/kimi-k3' });
    expect(pop(h).hidden).toBe(true);
    expect(chip(h)?.textContent).toBe('newapi/kimi-k3');
    // /model's own sentence, as plain text.
    expect(h.el('note').textContent).toBe('Model set to newapi/kimi-k3 for this conversation.');
  });

  it('keeps the list open with /model’s reason when the switch is refused', async () => {
    const h = await ready({
      status: { 'api/models': 409 },
      replies: { 'api/models': { ok: false, text: '`newapi/kimi-k3` is no longer offered by this agent. Run /model again for the current list.' } },
    });
    await h.click('#status .st-model');
    await tick();
    await h.click('#mp-list .mp-opt[data-v="newapi/kimi-k3"]');
    await tick();
    expect(pop(h).hidden).toBe(false);
    const err = h.el('mp-list').querySelector('.mp-msg.err');
    expect(err?.innerHTML).toContain('<code>newapi/kimi-k3</code> is no longer offered');
    expect(chip(h)?.textContent).toBe('opencode/glm-5');
  });

  it('says why there is no list for a harness that offers none', async () => {
    const h = await ready({ replies: { [URL_T]: { ok: false, agent: 'cbc@p', reason: 'none', text: 'This agent offers no model selector.' } } });
    await h.click('#status .st-model');
    await tick();
    expect(rows(h)).toHaveLength(0);
    expect(h.el('mp-list').textContent).toContain('This agent offers no model selector.');
    expect(h.el('mp-agent').textContent).toBe('cbc@p');
  });

  it('says so when the list cannot be fetched, rather than spinning for ever', async () => {
    const h = await ready({ hang: [URL_T], shortenLong: true });
    await h.click('#status .st-model');
    await new Promise((r) => setTimeout(r, 120));
    expect(h.longTimers).toContain(45000);
    expect(h.el('mp-list').textContent).toContain('Could not reach the daemon for the list');
  });

  it('closes on Escape, on the ×, on a click outside, and with the topic', async () => {
    const h = await ready();
    const shut = () => pop(h).hidden;
    await h.click('#status .st-model');
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(shut()).toBe(true);
    await h.click('#status .st-model');
    await h.click('#mp-close');
    expect(shut()).toBe(true);
    await h.click('#status .st-model');
    await h.click('#log');
    expect(shut()).toBe(true);
    await h.click('#status .st-model');
    expect(shut()).toBe(false);
    await h.click('[data-topic="' + OTHER + '"]');
    expect(shut()).toBe(true);
  });

  it('drops a list that arrives after the switch was closed', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const h = await ready({ held: { [URL_T]: held } });
    await h.click('#status .st-model');
    await h.click('#mp-close');
    release();
    await tick();
    await tick();
    expect(pop(h).hidden).toBe(true);
    expect(rows(h)).toHaveLength(0);
  });

  it('offers the switch in a topic with a conversation but no status yet, and not in a new one', async () => {
    const h = await open({ replies: { [URL_T]: LIST } });
    await h.emit(sync(T, [message('m1', '<p>hi</p>')], [T]));
    expect(h.el('status').hidden).toBe(false);
    expect(chip(h)?.textContent).toBe('Model');
    // A new topic offers its agents instead; the switch would commit it to the default one.
    await h.emit(sync(T, [], [T], { agents: { groups: [{ name: '', agents: [{ id: 'oc@p', kind: 'OpenCode' }] }], current: 'oc@p' } }));
    expect(chip(h)).toBeNull();
  });

  it('offers the switch as soon as an agent is chosen, before the first message and its status', async () => {
    // Reported 2026-11-05: the switch waited on the sync's snapshot of the empty room, which no
    // event after the tap replaces, so it stayed away until the first reply reported a status —
    // too late to choose the model that first message goes to.
    const agents = { groups: [{ name: '', agents: [{ id: 'oc@p', harness: 'opencode', kind: 'OpenCode' }] }], current: 'oc@p' };
    const h = await open({
      replies: {
        [URL_T]: LIST,
        'api/topics/setup': { ok: true, agent: 'oc@p', cwd: '/work' },
        [`api/options?peek=1&t=${T}`]: {
          agent: 'oc@p',
          model: 'm1',
          options: [{ id: 'account', name: 'Account', value: 'work' }],
        },
        [`api/options?t=${T}`]: {
          ok: true,
          agent: 'oc@p',
          options: [
            {
              id: 'account',
              name: 'Account',
              current: 'work',
              options: [
                { value: 'work', name: 'work' },
                { value: 'home', name: 'home' },
              ],
            },
          ],
        },
      },
    });
    await h.emit(sync(T, [], [T], { agents }));
    expect(chip(h)).toBeNull();

    await h.click('.agent-card[data-agent="oc@p"]');
    expect(h.calls.filter((c) => c.path === 'api/topics/setup').map((c) => c.body)).toEqual([
      { topic: T, agent: 'oc@p' },
    ]);
    expect(h.calls.filter((c) => c.path === 'api/send')).toHaveLength(0);
    // No status has arrived and no sync followed: the tap alone puts it up, and it works while the launcher stays open.
    expect(chip(h)?.textContent).toBe('m1');
    await h.click('#status .st-model');
    expect(h.calls.find((c) => c.path === URL_T)).toBeTruthy();
    await tick();
    expect(rows(h)).toHaveLength(13);
    // Peek populates the chosen agent's model and custom settings (e.g. Account) right away.
    await tick();
    const optBtn = h.doc.querySelector('#status .st-opt[data-opt="account"]') as HTMLButtonElement | null;
    expect(optBtn).not.toBeNull();
    expect(optBtn?.textContent).toContain('Account');
    await h.click('#status .st-opt[data-opt="account"]');
    await tick();
    expect(rows(h).map((r) => r.getAttribute('data-v'))).toEqual(['work', 'home']);
  });

  it('takes the switch away again when a failed send empties the room and the choice comes back', async () => {
    const agents = { groups: [{ name: '', agents: [{ id: 'oc@p', harness: 'opencode', kind: 'OpenCode' }] }], current: 'oc@p' };
    const h = await open();
    await h.emit(sync(T, [], [T], { agents }));
    await h.emit({ t: 'msg', msg: message('w1', '<p>a scheduled task said this</p>') });
    expect(chip(h)?.textContent).toBe('Model');
    await h.emit({ t: 'del', id: 'w1' });
    expect(h.el('log').querySelector('.launch')).not.toBeNull();
    expect(chip(h)).toBeNull();
  });

  it('is a finger target on a phone, and does not zoom the page when filtering', () => {
    const html = renderPage('Chat', false);
    const at = html.indexOf('@media(max-width:640px){');
    let depth = 0;
    let css = '';
    for (let i = html.indexOf('{', at); i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) {
        css = html.slice(at, i + 1);
        break;
      }
    }
    expect(css).toMatch(/\.st-model\{min-height:44px/);
    expect(css).toMatch(/#mp-filter\{min-height:44px;font-size:16px\}/);
    expect(css).toMatch(/#mp-close\{min-width:44px;min-height:44px\}/);
    expect(css).toMatch(/#model-pop\{left:8px;right:8px;width:auto/);
  });

  it('does not take the keyboard on a phone when it opens', async () => {
    const h = await ready({ width: 390, height: 844 });
    await h.click('#status .st-model');
    await tick();
    expect(h.doc.activeElement?.id).not.toBe('mp-filter');
  });
});

describe('webui page: the agent’s own settings in the status line', () => {
  // A setting the agent defines itself (an ACP select option in a `_` category) — here an account,
  // the way a web agent driver reports one: every account while the conversation can still move,
  // only the current one once it cannot.
  const T = 'a1b2c3d4';
  const ACCOUNTS = [
    { value: 'work', name: 'work' },
    { value: 'home', name: 'home', description: '5-hour limit used up; resets 18:55 GMT+8' },
  ];
  const OPEN = { id: 'account', name: 'Account', current: 'work', options: ACCOUNTS };
  const LIST = { ok: true, agent: 'browser', options: [OPEN] };
  const STATUS = { agent: 'browser', model: 'm1', options: [{ id: 'account', name: 'Account', value: 'work' }] };
  const LOCKED = { agent: 'browser', model: 'm1', options: [{ id: 'account', name: 'Account', value: 'work', fixed: true }] };
  const URL_O = `api/options?t=${T}`;
  const PEEK = `api/options?peek=1&t=${T}`;
  const opt = (h: Harness) => h.doc.querySelector('#status .st-opt') as HTMLButtonElement | null;
  const rows = (h: Harness) => Array.from(h.doc.querySelectorAll('#mp-list .mp-opt')) as HTMLButtonElement[];
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 450));

  async function ready(status: Record<string, unknown>, o: Parameters<typeof open>[0] = {}): Promise<Harness> {
    const h = await open({ ...o, replies: { [URL_O]: LIST, ...(o.replies ?? {}) } });
    await h.emit(sync(T, [message('m1', '<p>hi</p>')], [T]));
    await h.emit({ t: 'status', status });
    return h;
  }

  it('draws each setting beside the model, named, with its current value', async () => {
    const h = await ready(STATUS);
    expect(h.el('status').textContent).toContain('browser · m1 · Account work');
    expect(opt(h)?.disabled).toBe(false);
    expect(opt(h)?.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('opens the choices, each with its description as a second line, and sets one with a tap', async () => {
    const h = await ready(STATUS, {
      replies: { 'api/options': { ok: true, options: [{ ...OPEN, current: 'home' }], text: 'Account set to home for this conversation.' } },
    });
    await h.click('#status .st-opt');
    expect(h.calls.find((c) => c.path === URL_O)).toBeTruthy();
    await tick();
    expect(h.el('model-pop').hidden).toBe(false);
    expect(h.el('mp-heading').textContent).toBe('Account for this topic');
    expect(rows(h).map((r) => r.getAttribute('data-v'))).toEqual(['work', 'home']);
    expect(rows(h).find((r) => r.classList.contains('on'))?.getAttribute('data-v')).toBe('work');
    expect(rows(h)[1]!.querySelector('.mp-n')?.textContent).toBe('5-hour limit used up; resets 18:55 GMT+8');
    // The model switch's own marks are not here: no models were asked for.
    expect(h.calls.some((c) => c.path.startsWith('api/models'))).toBe(false);

    await h.click('#mp-list .mp-opt[data-v="home"]');
    await tick();
    expect(h.calls.find((c) => c.path === 'api/options')?.body).toEqual({ topic: T, id: 'account', value: 'home' });
    expect(h.el('model-pop').hidden).toBe(true);
    expect(h.el('note').textContent).toBe('Account set to home for this conversation.');
  });

  it('keeps the list open with the agent’s own sentence when it refuses', async () => {
    const h = await ready(STATUS, {
      status: { 'api/options': 409 },
      replies: { 'api/options': { ok: false, text: 'This conversation already started on work; its account cannot change.' } },
    });
    await h.click('#status .st-opt');
    await tick();
    await h.click('#mp-list .mp-opt[data-v="home"]');
    await tick();
    expect(h.el('model-pop').hidden).toBe(false);
    expect(h.el('mp-list').querySelector('.mp-msg.err')?.textContent).toBe('This conversation already started on work; its account cannot change.');
  });

  it('draws a setting with a single choice dim and inert, showing only its value', async () => {
    const h = await ready(LOCKED);
    expect(opt(h)?.disabled).toBe(true);
    expect(opt(h)?.classList.contains('fixed')).toBe(true);
    expect(opt(h)?.querySelector('.st-mtext')?.textContent).toBe('work');
    expect(opt(h)?.getAttribute('title')).toBe('Account: work — fixed for this conversation');
    expect(opt(h)?.hasAttribute('aria-haspopup')).toBe(false);
    await h.click('#status .st-opt');
    expect(h.el('model-pop').hidden).toBe(true);
    expect(h.calls.some((c) => c.path.startsWith('api/options'))).toBe(false);
  });

  it('puts the agent’s note on the current value in the title', async () => {
    const h = await ready({ ...LOCKED, options: [{ ...LOCKED.options[0], note: 'Quota used up' }] });
    expect(opt(h)?.getAttribute('title')).toBe('Account: work — fixed for this conversation\nQuota used up');
  });

  it('asks which settings to draw in a topic with no status yet, and opening one starts its agent', async () => {
    const h = await open({
      replies: { [URL_O]: LIST, [PEEK]: { agent: 'browser', model: 'Thinking', options: [{ id: 'account', name: 'Account', value: 'work' }] } },
    });
    await h.emit(sync(T, [message('m1', '<p>/agent browser</p>')], [T]));
    await settle();
    expect(h.calls.filter((c) => c.path === PEEK)).toHaveLength(1);
    expect(h.el('status').textContent).toContain('browser · Thinking · Account work');
    expect(opt(h)?.disabled).toBe(false);
    await h.click('#status .st-opt');
    await tick();
    expect(h.calls.find((c) => c.path === URL_O)).toBeTruthy();
    expect(rows(h)).toHaveLength(2);
    // The list started the session, so the line asks again and can now say what it is set to.
    expect(h.calls.filter((c) => c.path === PEEK)).toHaveLength(2);
  });

  it('disambiguates multi-account quota chips when more than one account is present', async () => {
    const h = await ready({
      agent: 'browser',
      model: 'Thinking',
      quota: [
        { id: 'gemini-5h', remaining: 0.88, account: 'alice@example.com' },
        { id: 'gemini-5h', remaining: 0.99, account: 'bob@example.com' },
      ],
    });
    expect(h.el('status').textContent).toContain('alice Gemini 5h 88%');
    expect(h.el('status').textContent).toContain('bob Gemini 5h 99%');
  });

  it('asks again when a message arrives, since a /cd or /new ends the session it described', async () => {
    const h = await open({ replies: { [PEEK]: { agent: 'browser', options: [{ id: 'account', name: 'Account', value: 'home' }] } } });
    await h.emit(sync(T, [message('m1', '<p>/agent browser</p>')], [T]));
    await settle();
    expect(opt(h)?.textContent).toBe('Account home');
    await h.emit({ t: 'msg', msg: message('m2', '<p>Working in ~/src</p>') });
    await settle();
    expect(h.calls.filter((c) => c.path === PEEK)).toHaveLength(2);
  });

  it('does not ask while a status is up, nor draw anything for an agent with no settings', async () => {
    const h = await ready({ agent: 'cc', model: 'opus' });
    await settle();
    expect(h.calls.some((c) => c.path.startsWith('api/options'))).toBe(false);
    expect(opt(h)).toBeNull();
  });
});

describe('webui page: the agent status strip', () => {
  const T = 'a1b2c3d4';
  const OTHER = 'b2c3d4e5';
  const CC = {
    agent: 'cc',
    model: 'claude-opus-5-5',
    effort: 'high',
    context: { used: 230_000, size: 1_000_000 },
    cost: { amount: 1.2391, currency: 'USD' },
  };
  const strip = (h: Harness): HTMLElement => h.el('status');

  it('stays hidden until the daemon has something to say, and shows what it says', async () => {
    const h = await open();
    await h.emit(sync(T, [], [T]));
    // A topic whose agent has not reported since the daemon started: nothing, not a row of zeros.
    expect(strip(h).hidden).toBe(true);

    await h.emit({ t: 'status', status: CC });
    expect(strip(h).hidden).toBe(false);
    const text = strip(h).textContent ?? '';
    expect(text).toContain('cc · claude-opus-5-5 · high');
    expect(text).toContain('23%');
    // The same units as the footer under every reply, so the two can be compared.
    expect(text).toContain('230k/1M');
    expect(text).toContain('$1.24');
  });

  it('colours the context as it fills, at the same thresholds as the agy status line', async () => {
    const h = await open();
    await h.emit(sync(T, [], [T]));
    const ctx = (used: number) => ({ ...CC, context: { used, size: 1000 } });
    const cls = () => strip(h).querySelectorAll('.st')[1]?.className;
    await h.emit({ t: 'status', status: ctx(100) });
    expect(cls()).toBe('st');
    await h.emit({ t: 'status', status: ctx(600) });
    expect(cls()).toBe('st warn');
    await h.emit({ t: 'status', status: ctx(850) });
    expect(cls()).toBe('st bad');
  });

  it('counts the cache down here, from the one expiry the daemon sent', async () => {
    const h = await open();
    const now = Date.now();
    await h.emit(sync(T, [], [T], { status: { ...CC, cacheExpiresAt: now + 41 * 60_000 + 30_000 } }));
    expect(strip(h).textContent).toContain('cache 41m');

    await h.emit({ t: 'status', status: { ...CC, cacheExpiresAt: now + 3 * 60_000 } });
    const cache = [...strip(h).querySelectorAll('.st')].find((s) => s.textContent?.startsWith('cache'));
    // Under five minutes is the moment it is worth sending the next message to keep it.
    expect(cache?.className).toBe('st warn');

    await h.emit({ t: 'status', status: { ...CC, cacheExpiresAt: now - 1000 } });
    expect(strip(h).textContent).toContain('cache expired');
  });

  it('shows the pools being spent from, and every pool once tapped open', async () => {
    const h = await open();
    const agy = {
      agent: 'agy',
      model: 'Claude Opus 5.5 (Medium)',
      quota: [
        { id: '3p-5h', remaining: 1, resetsAt: Date.now() + 5 * 3600_000, active: true },
        { id: '3p-weekly', remaining: 0.3, resetsAt: Date.now() + 2 * 86_400_000 + 3 * 3600_000 + 60_000, active: true },
        { id: 'gemini-weekly', remaining: 1, active: false },
      ],
    };
    await h.emit(sync(T, [], [T], { status: agy }));
    const text = () => strip(h).textContent ?? '';
    expect(text()).toContain('3P 5h 100%');
    // A reset time only once something has been spent; colour once it runs low.
    expect(text()).not.toContain('3P 5h 100% (');
    expect(text()).toContain('3P wk 30% (2d 3h)');
    expect(text()).not.toContain('Gemini');

    await h.click('#status');
    expect(strip(h).classList.contains('open')).toBe(true);
    expect(text()).toContain('Gemini wk 100%');
    expect(strip(h).querySelector('.st.off')?.textContent).toBe('Gemini wk 100%');
  });

  it('wraps the status strip by default so trailing quota pools are never clipped on narrow screens', () => {
    const html = renderPage('Chat', false);
    expect(html).toContain('#status{display:flex;flex-wrap:wrap;');
    expect(html).not.toContain('#status{display:flex;align-items:center;margin:-3px 0 7px;font-size:11.5px;line-height:1.5;color:var(--dim);white-space:nowrap;overflow:hidden;');
    expect(html).toContain('.st-who{color:var(--fg-muted);flex-wrap:wrap;row-gap:1px;max-width:100%}');
  });

  it('escapes what it is sent — a model name is the agent’s to choose', async () => {
    const h = await open();
    await h.emit(sync(T, [], [T], { status: { agent: 'cc', model: '<img src=x onerror=alert(1)>' } }));
    expect(strip(h).querySelector('img')).toBeNull();
    expect(strip(h).textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('clears when the daemon clears it, and on the way into another topic', async () => {
    const h = await open();
    await h.emit(sync(T, [], [T, OTHER], { status: CC }));
    expect(strip(h).hidden).toBe(false);
    await h.emit({ t: 'status' });
    expect(strip(h).hidden).toBe(true);

    await h.emit({ t: 'status', status: CC });
    // Switching: the strip described the topic being left, and must not sit over the next one
    // while its sync is on the way.
    await h.click(`[data-topic="${OTHER}"]`);
    expect(strip(h).hidden).toBe(true);
    await h.emit(sync(OTHER, [], [T, OTHER], { status: { agent: 'agy' } }));
    // No model reported yet: the switch is there all the same, under its own name.
    expect(strip(h).textContent).toBe('agy · Model');
  });

  it('runs its countdown timer only while there is a countdown on screen', async () => {
    const h = await open();
    const set = vi.spyOn(h.window, 'setInterval');
    const clear = vi.spyOn(h.window, 'clearInterval');
    await h.emit(sync(T, [], [T], { status: CC }));
    expect(set).not.toHaveBeenCalled();
    await h.emit({ t: 'status', status: { ...CC, cacheExpiresAt: Date.now() + 3_600_000 } });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[1]).toBe(30_000);
    await h.emit({ t: 'status', status: CC });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('drops the token counts on a narrow screen until tapped open', () => {
    const html = renderPage('Chat', false);
    const at = html.indexOf('@media(max-width:640px){');
    expect(html.slice(at)).toContain('#status:not(.open) .st-x{display:none}');
    // …and not on the desktop, where there is room.
    expect(html.slice(0, at)).not.toContain('.st-x{display:none}');
  });
});

describe('webui page: tool bubbles fold and open', () => {
  const T = 'a1b2c3d4';
  const CMD = 'cd /home/user/workspace/project-scripts/dividend-backtest && python3 fetch_prices.py --since 2018';

  /** A tool bubble in the shape `index.ts` posts one: the server's own line markup, and the kind. */
  function bubble(id: string, lines: string[]): Record<string, unknown> {
    return { ...message(id, webMessageHtml('tools', lines.join('\n'))), kind: 'tools' };
  }

  const rows = (h: Harness): HTMLElement[] => Array.from(h.doc.querySelectorAll<HTMLElement>('#log .tl'));
  const openRows = (h: Harness): boolean[] => rows(h).map((r) => r.classList.contains('open'));
  const toggle = (h: Harness): HTMLElement | null => h.doc.querySelector<HTMLElement>('#log [data-tl-all]');

  it('draws each tool on a row of its own, folded, with a way to open them all', async () => {
    const h = await open();
    await h.emit(sync(T, [bubble('m1', [`💻 Bash: "${CMD}" ✓ 1.2s`, '📖 Read: "a.md"']), message('m2', '<p>prose</p>')], [T]));

    expect(rows(h)).toHaveLength(2);
    expect(openRows(h)).toEqual([false, false]);
    // The whole command is in the row, folded by the stylesheet — not cut by the server.
    expect(rows(h)[0]?.textContent).toContain('--since 2018');
    expect(toggle(h)?.textContent).toBe('Show all');
    // Only a tool bubble offers it: a reply has nothing folded to open.
    expect(h.doc.querySelectorAll('#log [data-tl-all]')).toHaveLength(1);
  });

  it('opens one row on a click, and folds it on the next', async () => {
    const h = await open();
    await h.emit(sync(T, [bubble('m1', [`💻 Bash: "${CMD}"`, '📖 Read: "a.md"'])], [T]));

    rows(h)[1]!.click();
    await tick();
    expect(openRows(h)).toEqual([false, true]);
    // Answered in the page: opening a line is not a click on the message for the daemon.
    expect(h.calls.filter((c) => c.path === 'api/click')).toEqual([]);

    rows(h)[1]!.click();
    await tick();
    expect(openRows(h)).toEqual([false, false]);
  });

  it('"Show all" opens every row, and the rows the agent adds after it', async () => {
    const h = await open();
    await h.emit(sync(T, [bubble('m1', [`💻 Bash: "${CMD}"`])], [T]));

    await h.click('#log [data-tl-all]');
    expect(openRows(h)).toEqual([true]);
    expect(toggle(h)?.textContent).toBe('Collapse');

    // The bubble is still live: the next tool arrives as an edit of the same message.
    await h.emit({ t: 'msg', msg: bubble('m1', [`💻 Bash: "${CMD}" ✓ 1.2s`, '📖 Read: "a.md"']) });
    expect(openRows(h)).toEqual([true, true]);

    await h.click('#log [data-tl-all]');
    expect(openRows(h)).toEqual([false, false]);
    expect(toggle(h)?.textContent).toBe('Show all');
  });

  it('keeps an opened row open while the bubble goes on being edited', async () => {
    // The reason the state lives in the script and not on the element: every edit rewrites the
    // bubble's markup, and a class set on the old row would snap shut under the reader at the ✓.
    const h = await open();
    await h.emit(sync(T, [bubble('m1', [`💻 Bash: "${CMD}"`])], [T]));
    rows(h)[0]!.click();
    await tick();

    await h.emit({ t: 'msg', msg: bubble('m1', [`💻 Bash: "${CMD}" ✓ 1.2s`, '📖 Read: "a.md"']) });
    expect(openRows(h)).toEqual([true, false]);
    expect(face(rows(h)[0])).toContain('[check] 1.2s');
  });

  it('draws the tool, a sub-agent and the finish mark as icons, and an emoji it has none for as itself', async () => {
    const h = await open();
    await h.emit(
      sync(T, [bubble('m1', [`💻 Bash: "${CMD}" ✓ 1.2s`, '↳ fix tests · ✏️ Edit: "a.ts" ✗ 832ms', '↳ 🦀 Cargo: "build"'])], [T])
    );

    expect(rows(h).map(face)).toEqual([
      `[terminal] Bash: "${CMD}" [check] 1.2s`,
      '[subagent] fix tests · [pencil] Edit: "a.ts" [cross] 832ms',
      '[subagent] 🦀 Cargo: "build"',
    ]);
    // The finish mark is still the part that stays in view when the command folds.
    expect(face(rows(h)[1]?.querySelector('.tl-s'))).toBe(' [cross] 832ms');
  });

  it('a click that ends a selection leaves the row as it was', async () => {
    // Selecting part of a command to copy it is the other thing done with these rows. Toggling
    // on that click would repaint the bubble and throw the selection away.
    const h = await open();
    await h.emit(sync(T, [bubble('m1', [`💻 Bash: "${CMD}"`])], [T]));
    const range = h.doc.createRange();
    range.selectNodeContents(rows(h)[0]!);
    // Replacing whatever is there: addRange is a no-op on a selection that already holds a range.
    const sel = h.window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(String(sel)).toContain('python3');

    rows(h)[0]!.click();
    await tick();
    expect(openRows(h)).toEqual([false]);
  });

  it('folds by the stylesheet: the command cut with an ellipsis, the mark kept, wrapping once opened', () => {
    // Asserted as served text, not through the CSSOM (see the README): without these rules a
    // "folded" row is just a long line, and every assertion above would pass on a page that
    // folds nothing. Whether the mark really stays in view is layout, checked in real Chromium.
    const html = renderPage('Chat', false, true, false);
    expect(html).toContain('.tl-c{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}');
    expect(html).toContain('.tl-s{flex:none;white-space:pre}');
    expect(html).toContain('.tl.open{display:block;white-space:pre-wrap;overflow-wrap:anywhere}');
  });
});

/**
 * A subagent's card (kind `subagent`, markup.ts subagentCard): the server draws its header and rows,
 * the page builds the card — the count and state in the reader's language, and a fold to the newest
 * row that the header opens.
 */
describe('webui page: subagent cards', () => {
  const T = 'a1b2c3d4';

  function card(id: string, text: string): Record<string, unknown> {
    return { ...message(id, webMessageHtml('subagent', text)), kind: 'subagent' };
  }

  const head = (h: Harness): HTMLElement | null => h.doc.querySelector<HTMLElement>('#log .sa-h');
  /** The rows the stylesheet leaves in view: a folded card hides all but its last (asserted below). */
  const shown = (h: Harness): string[] =>
    Array.from(h.doc.querySelectorAll<HTMLElement>('#log .sa .tl'))
      .filter((r) => !(r.closest('.sa')?.classList.contains('open') === false && r !== r.parentElement?.lastElementChild))
      .map(face);

  it('names the subagent, counts its tools, and shows the newest one while it runs', async () => {
    const h = await open();
    await h.emit(sync(T, [card('m1', '↳ back end\n💻 Bash: "grep 401" ✓ 1.2s\n📖 Read: "auth.go"')], [T]));

    expect(face(head(h))).toBe('[subagent]back end2 toolsRunning[chevronDown]');
    expect(head(h)?.getAttribute('aria-expanded')).toBe('false');
    expect(shown(h)).toEqual(['[book] Read: "auth.go"']);
    expect(h.doc.querySelector('#log .sa-more')?.textContent).toBe('1 earlier — tap the name to show all');
    // The card folds by its header, so the tool bubble's own "Show all" is not offered on it.
    expect(h.doc.querySelector('#log [data-tl-all]')).toBeNull();
  });

  it('opens to every row on a tap of the header, and stays open as the card is edited', async () => {
    const h = await open();
    await h.emit(sync(T, [card('m1', '↳ back end\n💻 Bash: "grep 401" ✓ 1.2s\n📖 Read: "auth.go"')], [T]));

    await h.click('#log .sa-h');
    expect(head(h)?.getAttribute('aria-expanded')).toBe('true');
    expect(shown(h)).toEqual(['[terminal] Bash: "grep 401" [check] 1.2s', '[book] Read: "auth.go"']);
    expect(h.doc.querySelector('#log .sa-more')).toBeNull();
    // Answered in the page, as a row's fold is.
    expect(h.calls.filter((c) => c.path === 'api/click')).toEqual([]);

    await h.emit({ t: 'msg', msg: card('m1', '↳ back end ✓ 13.0s\n💻 Bash: "grep 401" ✓ 1.2s\n📖 Read: "auth.go" ✓ 90ms') });
    expect(h.doc.querySelector('#log .sa')?.className).toBe('sa st-ok open');
    expect(face(head(h))).toBe('[subagent]back end2 tools · 13.0s[check]Done[chevronDown]');

    await h.click('#log .sa-h');
    expect(shown(h)).toEqual(['[book] Read: "auth.go" [check] 90ms']);
  });

  it('says a subagent that ended badly did not finish', async () => {
    const h = await open();
    await h.emit(sync(T, [card('m1', '↳ back end ✗ 3.0s\n💻 Bash: "go test"')], [T]));
    expect(h.doc.querySelector('#log .sa')?.classList.contains('st-err')).toBe(true);
    expect(face(head(h))).toBe('[subagent]back end1 tool · 3.0s[cross]Did not finish[chevronDown]');
  });

  it('folds by the stylesheet: a closed card shows its newest row only', () => {
    // Served text, not the CSSOM (see the README); without the rule `shown` above would be a fiction.
    const html = renderPage('Chat', false, true, false);
    expect(html).toContain('.sa:not(.open) .tl:not(:last-child){display:none}');
  });
});

/**
 * A reply's code blocks (web-markdown.ts codeBlock, page.ts "Code blocks"): the bar's Copy and Wrap,
 * and the colours the code view's grammars put on once a message has stopped changing.
 *
 * The highlighter is a fake behind `window.__fhCodeView` — jsdom cannot import the real bundle — that
 * colours `const`, `return` and double-quoted strings, and writes down every language it was asked
 * for and every text it coloured, which is how "asked once" and "not parsed again" are seen.
 */
describe('webui page: code blocks in a reply', () => {
  const T = 'c0de0b1c';
  const FENCE = '```ts\nconst a = "x";\nreturn a;\n```';
  const CODE = 'const a = "x";\nreturn a;';
  /** A reply as the daemon posts one: the server's own markup. */
  const reply = (id: string, md: string): Record<string, unknown> => message(id, webMessageHtml(undefined, md));
  /** A sync of T whose turn is still running, so its newest message is the one being written. */
  const running = (messages: Array<Record<string, unknown>>): Record<string, unknown> =>
    sync(T, messages, [T], { topics: [{ id: T, title: 'Topic', lastAt: 1000, running: true, msgCount: messages.length }] });

  interface HlLog {
    asked: string[];
    ran: string[];
  }
  function fakeCodeView(log: HlLog, fail = false) {
    return {
      editor() {
        throw new Error('a reply never asks for an editor');
      },
      diff() {
        throw new Error('a reply never asks for a diff');
      },
      highlighter(lang: string) {
        log.asked.push(lang);
        if (fail) return Promise.reject(new Error('the chunk is gone'));
        if (lang !== 'ts') return Promise.resolve(null);
        return Promise.resolve((code: string) => {
          log.ran.push(code);
          return Array.from(code.matchAll(/\b(?:const|return)\b|"[^"]*"/g), (m) => [
            m.index ?? 0,
            (m.index ?? 0) + m[0].length,
            m[0].startsWith('"') ? 'tok-str' : 'tok-kw',
          ]);
        });
      },
    };
  }
  const codes = (h: Harness, root = '#log'): HTMLElement[] => Array.from(h.doc.querySelectorAll<HTMLElement>(`${root} .cb pre>code`));
  /** A code element's coloured runs, as `class:text`. */
  const runs = (el: Element | undefined): string[] =>
    Array.from(el?.querySelectorAll('span') ?? [], (s) => `${s.className}:${s.textContent ?? ''}`);
  const TS_RUNS = ['tok-kw:const', 'tok-str:"x"', 'tok-kw:return'];
  /** Longer than the page waits after a write (HL_IDLE_MS) before it looks at waiting blocks again. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 400));

  it('frames a fence with its language, and Copy takes the code with a check for a moment', async () => {
    const h = await open();
    await h.emit(sync(T, [reply('m1', `Here:\n\n${FENCE}`)], [T]));

    expect(h.doc.querySelector('#log .cb-lang')?.textContent).toBe('ts');
    await h.click('#log .cb-b[data-cb="copy"]');
    expect(h.clipboard).toEqual([CODE]);
    const btn = h.doc.querySelector<HTMLElement>('#log .cb-b[data-cb="copy"]');
    expect(face(btn)).toBe('[check]');
    expect(btn?.title).toBe('Copied');
    // Answered in the page: nothing about a copy is the daemon's business.
    expect(h.calls.filter((c) => c.path === 'api/click')).toEqual([]);
    await within('the copy icon back', 2500, () => face(btn) === '[copy]');
    expect(btn?.getAttribute('aria-label')).toBe('Copy code');
  });

  it('wraps on a tap, keeps it through the message being written again, and unwraps on the next', async () => {
    const h = await open();
    await h.emit(sync(T, [reply('m1', `${FENCE}\n\nmore`)], [T]));

    await h.click('#log .cb-b[data-cb="wrap"]');
    const frame = (): Element | null => h.doc.querySelector('#log .cb');
    expect(frame()?.classList.contains('wrap')).toBe(true);
    expect(h.doc.querySelector('#log .cb-b[data-cb="wrap"]')?.getAttribute('aria-pressed')).toBe('true');

    // An edit of the same message rewrites its HTML: a new frame, and still wrapped.
    const before = frame();
    await h.emit({ t: 'msg', msg: reply('m1', `${FENCE}\n\nmore, and more`) });
    expect(frame()).not.toBe(before);
    expect(frame()?.classList.contains('wrap')).toBe(true);
    expect(h.doc.querySelector('#log .cb-b[data-cb="wrap"]')?.getAttribute('aria-pressed')).toBe('true');

    await h.click('#log .cb-b[data-cb="wrap"]');
    expect(frame()?.classList.contains('wrap')).toBe(false);
    expect(renderPage('Chat', false)).toContain('.b .cb.wrap pre{white-space:pre-wrap;overflow-wrap:anywhere}');
  });

  it('colours a finished reply with the code view, keeping its text — and Copy still takes that text', async () => {
    const log: HlLog = { asked: [], ran: [] };
    const h = await open({ codeView: fakeCodeView(log) });
    await h.emit(sync(T, [reply('m1', FENCE)], [T]));

    await within('the code coloured', 1000, () => runs(codes(h)[0]).length > 0);
    expect(runs(codes(h)[0])).toEqual(TS_RUNS);
    expect(codes(h)[0]?.textContent).toBe(CODE);
    expect(log.asked).toEqual(['ts']);
    await h.click('#log .cb-b[data-cb="copy"]');
    expect(h.clipboard).toEqual([CODE]);
  });

  it('builds the colours as text, so markup in the code stays text', async () => {
    const log: HlLog = { asked: [], ran: [] };
    const h = await open({ codeView: fakeCodeView(log) });
    await h.emit(sync(T, [reply('m1', '```ts\nconst s = "<img src=x onerror=alert(1)>";\n```')], [T]));

    await within('the code coloured', 1000, () => runs(codes(h)[0]).length > 0);
    expect(h.doc.querySelector('#log img')).toBeNull();
    expect(runs(codes(h)[0])).toContain('tok-str:"<img src=x onerror=alert(1)>"');
  });

  it('asks for each language once, and leaves one with no grammar — or a patch — as it came', async () => {
    const log: HlLog = { asked: [], ran: [] };
    const h = await open({ codeView: fakeCodeView(log) });
    await h.emit(
      sync(T, [reply('m1', `${FENCE}\n\n\`\`\`zig\nconst x = 1;\n\`\`\``), reply('m2', `${FENCE}\n\n\`\`\`diff\n+const b\n\`\`\``)], [T])
    );

    await within('both ts blocks coloured', 1000, () => runs(codes(h)[0]).length > 0 && runs(codes(h)[2]).length > 0);
    await settle();
    expect([...log.asked].sort()).toEqual(['ts', 'zig']);
    expect(runs(codes(h)[1])).toEqual([]);
    // The patch keeps the line colours the server gave it, and no grammar is asked about it.
    expect(runs(codes(h)[3])).toEqual(['pa:+const b']);
  });

  it('keeps the reply a running turn is still writing plain, and colours it when the turn ends', async () => {
    const log: HlLog = { asked: [], ran: [] };
    const h = await open({ codeView: fakeCodeView(log) });
    await h.emit(running([reply('m1', FENCE)]));

    await settle();
    expect(runs(codes(h)[0])).toEqual([]);
    expect(log.ran).toEqual([]);

    await h.emit({ t: 'typing', on: false });
    await within('the code coloured', 1000, () => runs(codes(h)[0]).length > 0);
    expect(runs(codes(h)[0])).toEqual(TS_RUNS);
  });

  it('colours the reply a newer message has followed, while the turn goes on writing the newer one', async () => {
    const log: HlLog = { asked: [], ran: [] };
    const h = await open({ codeView: fakeCodeView(log) });
    await h.emit(running([reply('m1', FENCE)]));
    await settle();
    expect(runs(codes(h)[0])).toEqual([]);

    await h.emit({ t: 'msg', msg: reply('m2', FENCE.replace('"x"', '"y"')) });
    await within('the first reply coloured', 1000, () => runs(codes(h)[0]).length > 0);
    await settle();
    // The newest is the one still being written.
    expect(runs(codes(h)[1])).toEqual([]);
  });

  it('puts the colours back in the same task when a re-render leaves a block as it was — no flash, no second parse', async () => {
    const log: HlLog = { asked: [], ran: [] };
    const h = await open({ codeView: fakeCodeView(log) });
    await h.emit(sync(T, [reply('m1', FENCE)], [T]));
    await within('the code coloured', 1000, () => runs(codes(h)[0]).length > 0);
    const first = codes(h)[0];

    // Delivered and read back with no await in between: whatever is on screen after the handler
    // returns is what the browser would paint next.
    h.live().onmessage?.({ data: JSON.stringify({ t: 'msg', msg: reply('m1', `${FENCE}\n\nand a note under it`) }) });
    expect(codes(h)[0]).not.toBe(first);
    expect(runs(codes(h)[0])).toEqual(TS_RUNS);
    expect(log.ran).toEqual([CODE]);

    // A block that did change, in a message no turn is writing, is coloured in the same task too:
    // the grammar is loaded, so there is nothing to wait for.
    h.live().onmessage?.({ data: JSON.stringify({ t: 'msg', msg: reply('m1', FENCE.replace('a;', 'b;')) }) });
    expect(runs(codes(h)[0])).toEqual(TS_RUNS);
    expect(log.ran).toHaveLength(2);
  });

  it('leaves code plain when a grammar will not load, and says so once however many fail', async () => {
    const log: HlLog = { asked: [], ran: [] };
    const h = await open({ codeView: fakeCodeView(log, true) });
    await h.emit(sync(T, [reply('m1', FENCE), reply('m2', '```py\nreturn "z"\n```')], [T]));

    await within('both grammars asked for', 1000, () => log.asked.length === 2);
    await settle();
    expect(codes(h).map((c) => runs(c))).toEqual([[], []]);
    expect(codes(h)[0]?.textContent).toBe(CODE);
    expect([...log.asked].sort()).toEqual(['py', 'ts']);
    expect(h.warnings.filter((w) => w.includes('a code language failed to load'))).toHaveLength(1);
  });

  it('leaves code plain, and says nothing, on a page with no code view at all', async () => {
    const h = await open();
    await h.emit(sync(T, [reply('m1', FENCE)], [T]));
    await settle();
    expect(runs(codes(h)[0])).toEqual([]);
    expect(h.warnings).toEqual([]);
  });

  it('colours, copies and wraps a code block in the file reader the same way', async () => {
    const log: HlLog = { asked: [], ran: [] };
    const h = await open({
      codeView: fakeCodeView(log),
      replies: { 'view/aa': { name: 'plan.md', size: 40, shown: 40, html: renderWebMarkdown(`# Plan\n\n${FENCE.replace('a;', 'b;')}`) } },
    });
    await h.emit(sync(T, [reply('m0', FENCE), { ...message('m1', ''), file: { name: 'plan.md', url: 'f/aa', view: 'view/aa' } }], [T]));
    // The grammar is in by now, so the reader's block is coloured as its HTML is written — well
    // before the sweep that runs a quarter of a second after the last write would get to it.
    await within('the transcript coloured', 1000, () => runs(codes(h)[0]).length > 0);
    await settle();
    await h.click('#log a[data-view]');

    await until('the reader coloured as it was written', () => runs(codes(h, '.wb-reader-editor')[0]).length > 0);
    expect(runs(codes(h, '.wb-reader-editor')[0])).toEqual(TS_RUNS);
    await h.click('.wb-reader-editor .cb-b[data-cb="copy"]');
    expect(h.clipboard).toEqual([CODE.replace('a;', 'b;')]);
    await h.click('.wb-reader-editor .cb-b[data-cb="wrap"]');
    expect(h.doc.querySelector('.wb-reader-editor .cb')?.classList.contains('wrap')).toBe(true);
  });

  it('frames a table to scroll on its own, and draws a task box where the bullet was', async () => {
    const h = await open();
    await h.emit(sync(T, [reply('m1', '| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] open')], [T]));
    expect(h.doc.querySelector('#log .b .tbl>table')).not.toBeNull();
    expect(Array.from(h.doc.querySelectorAll('#log li.task'), (li) => face(li))).toEqual(['[boxOn]done', '[boxOff]open']);
    const css = renderPage('Chat', false);
    expect(css).toContain('.b .tbl{overflow-x:auto;margin:.6em 0;max-width:100%;overflow-wrap:normal}');
    expect(css).toContain('.b .tbl>table{display:table');
    expect(css).toContain('.b li.task{list-style:none}');
  });
});

describe('webui page: sub-agent bubbles', () => {
  const T = 'a1b2c3d4';
  const at = `http://localhost:8787/?t=${T}`;
  /** A message in the shape `index.ts` posts one: rendered html, and the kind it was sent with. */
  const sub = (
    id: string,
    html: string,
    kind: 'dispatch' | 'report' | 'aside'
  ): Record<string, unknown> => ({ ...message(id, html), kind });
  const tag = (h: Harness, cls: string): string | null =>
    h.doc.querySelector(`#log .m.${cls} .sub-k`)?.textContent ?? null;

  it('draws a dispatch and a report apart, and leaves an ordinary reply alone', async () => {
    const h = await open({ url: at });
    await h.emit(
      sync(T, [sub('m1', '<p>a task</p>', 'dispatch'), sub('m2', renderWebToolLines('🔔 a — done.'), 'report'), message('m3', '<p>a reply</p>')], [T])
    );

    expect(h.doc.querySelectorAll('#log .m.dispatch')).toHaveLength(1);
    expect(h.doc.querySelectorAll('#log .m.report')).toHaveLength(1);
    // The tag is what says which is which before the body is read.
    expect(tag(h, 'dispatch')).toBe('Sub-agent task');
    expect(tag(h, 'report')).toBe('Sub-agent report');
    // A plain reply gets neither mark.
    expect(h.doc.querySelectorAll('#log .m:not(.dispatch):not(.report)')).toHaveLength(1);
    expect(h.doc.querySelectorAll('#log .sub-k')).toHaveLength(2);
  });

  it('folds a report like a tool bubble, and leaves a dispatch unfolded prose', async () => {
    const h = await open({ url: at });
    await h.emit(
      sync(
        T,
        [
          sub('m1', '<p>do the thing</p>', 'dispatch'),
          sub('m2', renderWebToolLines('🔔 a — done.\n🔔 b — waiting on a question.'), 'report'),
        ],
        [T]
      )
    );

    // The report's lines are rows, folded, with the same control a tool bubble offers.
    expect(h.doc.querySelectorAll('#log .m.report .tl')).toHaveLength(2);
    expect(Array.from(h.doc.querySelectorAll('#log .m.report .tl')).map((r) => r.classList.contains('open'))).toEqual([
      false,
      false,
    ]);
    expect(h.doc.querySelector('#log .m.report [data-tl-all]')?.textContent).toBe('Show all');
    // A dispatch is the card or the task text itself: prose, nothing to fold.
    expect(h.doc.querySelectorAll('#log .m.dispatch .tl')).toHaveLength(0);
    expect(h.doc.querySelector('#log .m.dispatch [data-tl-all]')).toBeNull();

    await h.click('#log .m.report [data-tl-all]');
    expect(Array.from(h.doc.querySelectorAll('#log .m.report .tl')).map((r) => r.classList.contains('open'))).toEqual([
      true,
      true,
    ]);
  });

  it('keeps the report a report while it is edited', async () => {
    // The card is edited in place as the burst it gathers grows, before it settles.
    const h = await open({ url: at });
    await h.emit(sync(T, [sub('m1', renderWebToolLines('🔔 a — done.'), 'report')], [T]));
    await h.emit({ t: 'msg', msg: sub('m1', renderWebToolLines('🔔 a — done.\n🔔 b — failed.'), 'report') });

    expect(h.doc.querySelectorAll('#log .m.report')).toHaveLength(1);
    expect(h.doc.querySelectorAll('#log .m.report .tl')).toHaveLength(2);
    expect(tag(h, 'report')).toBe('Sub-agent report');
  });

  it('keeps both markings across a reload', async () => {
    // The transcript cache is what paints before the daemon answers, so the marking has to be in
    // the message it kept — not in markup only the previous page remembered.
    const first = await open({ url: at });
    const messages = [
      sub('m1', '<p>a task</p>', 'dispatch'),
      sub('m2', renderWebToolLines('🔔 a — done.'), 'report'),
    ];
    await first.emit(sync(T, messages, [T]));
    await saved();
    first.window.close();

    const again = await open({ url: at, idb: first.idb });
    // The cache paints before the daemon answers, so this half is the message it kept — not the
    // sync repeating itself.
    await until('the cached transcript is painted', () => again.painted() === 2);
    expect(again.doc.querySelectorAll('#log .m.dispatch')).toHaveLength(1);
    expect(again.doc.querySelectorAll('#log .m.report')).toHaveLength(1);
    expect(tag(again, 'dispatch')).toBe('Sub-agent task');
    expect(tag(again, 'report')).toBe('Sub-agent report');
    expect(again.doc.querySelectorAll('#log .m.report .tl')).toHaveLength(1);

    await again.emit(sync(T, messages, [T]));
    expect(again.doc.querySelectorAll('#log .m.dispatch')).toHaveLength(1);
    expect(again.doc.querySelectorAll('#log .m.report')).toHaveLength(1);
    expect(again.doc.querySelectorAll('#log .m.report .tl')).toHaveLength(1);
  });

  it('styles both kinds with variables, a rail and a tag, so another palette moves no rule', () => {
    // jsdom does not evaluate the cascade (see the README); the assertion is on what is served.
    const html = renderPage('Chat', false, true, false);
    expect(html).toContain('.m.dispatch{background:var(--disp);border-left:3px solid var(--disp-edge)');
    expect(html).toContain('.m.report{background:var(--rep);border-left:3px solid var(--rep-edge)');
    expect(html).toContain('--disp:#1a1622;');
    expect(html).toContain('--disp-edge:#8b6cc1;');
    expect(html).toContain('--rep:#14201a;');
    expect(html).toContain('--rep-edge:#3f8f6b;');
    expect(html).toContain('.sub-k{');
  });

  it('marks a side answer that names no question apart from the reply it lands in, while it streams', async () => {
    // An answer kept from before answers were replies to their /btw: nothing pairs it with a
    // question, so it stays in the transcript, where the rail and tag keep it from reading as the
    // reply's next paragraph. (One that is paired is read in a card: see "side questions" below.)
    const h = await open({ url: at });
    await h.emit(sync(T, [message('m1', '<p>working on it</p>'), sub('m2', '<p>↪ btw: which branch?</p>', 'aside')], [T]));
    // Edited in place as the answer streams, like any reply: the marking has to survive the edit.
    await h.emit({ t: 'msg', msg: sub('m2', '<p>↪ btw: which branch?</p><p>feat/x</p>', 'aside') });
    await h.emit({ t: 'msg', msg: message('m1', '<p>working on it — tests pass</p>') });

    expect(h.doc.querySelectorAll('#log .m.aside')).toHaveLength(1);
    expect(tag(h, 'aside')).toBe('Side question');
    expect(h.doc.querySelector('#log .m.aside .b')?.textContent).toContain('feat/x');
    // The reply around it stays a plain reply.
    expect(h.doc.querySelectorAll('#log .m:not(.aside)')).toHaveLength(1);
    expect(h.doc.querySelectorAll('#log .sub-k')).toHaveLength(1);
    expect(h.el('btw').hidden).toBe(true);
  });

  it('gives a kind it has no tag for no tag, even one named like a property of every object', async () => {
    const h = await open({ url: at });
    await h.emit(sync(T, [{ ...message('m1', '<p>a reply</p>'), kind: 'constructor' }], [T]));
    expect(h.doc.querySelectorAll('#log .sub-k')).toHaveLength(0);
    expect(h.doc.querySelector('#log .m')?.className).toBe('m');
  });

  it('styles a side answer like the other marked kinds, from variables', () => {
    const html = renderPage('Chat', false, true, false);
    expect(html).toContain('.m.aside{background:var(--aside);border-left:3px dashed var(--aside-edge)');
    expect(html).toContain('--aside:#151c1f;');
    expect(html).toContain('--aside-edge:#4f8a99');
  });
});

describe('webui page: side questions (/btw)', () => {
  const T = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const at = `http://localhost:8787/?t=${T}`;
  /** The operator's /btw as room.ts posts it: escaped text, whole, in a .raw. */
  const asked = (id: string, q: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...message(id, `<div class="raw">/btw ${q}</div>`, true),
    ...extra,
  });
  /** A message of the answer, as sendAside → index.ts replyMessage posts it: a reply naming the question. */
  const answer = (id: string, to: string, html: string): Record<string, unknown> => ({
    ...message(id, html),
    kind: 'aside',
    quote: { html: '<div class="raw">/btw …</div>', id: to },
  });
  const line = (h: Harness): HTMLElement | null => h.doc.querySelector('#log .m.btw-q');
  const card = (h: Harness): HTMLElement => h.el('btw');
  const escape = (h: Harness): void => {
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
  };

  it('keeps the question and its answer out of the transcript: a line where it was asked, the answer in a card', async () => {
    const h = await open({ url: at });
    await h.emit(sync(T, [message('w1', '<p>working on it</p>')], [T]));
    (h.el('input') as HTMLTextAreaElement).value = '/btw which branch?';
    await h.click('#composer button[type="submit"]');

    // At once, before the daemon has said anything: the line, and the card saying it is being asked.
    expect(face(line(h))).toContain('which branch?');
    expect(face(line(h))).toContain('Waiting');
    expect(card(h).hidden).toBe(false);
    expect(h.el('btw-q').textContent).toBe('which branch?');
    expect(h.el('btw-body').textContent).toContain('Asking a copy of this conversation');

    const nonce = h.calls.find((c) => c.path === 'api/send')?.body.nonce as string;
    await h.emit({ t: 'msg', msg: asked('w2', 'which branch?', { nonce }) });
    // The echo takes over the line, and the card goes with it.
    expect(h.doc.querySelectorAll('#log .m.btw-q')).toHaveLength(1);
    expect(card(h).hidden).toBe(false);

    // The answer opens with its header, which the card's title already says, then streams.
    await h.emit({ t: 'msg', msg: answer('w3', 'w2', '<p>↪ btw: which branch?</p>') });
    expect(h.el('btw-body').textContent).toContain('Asking a copy of this conversation');
    await h.emit({ t: 'msg', msg: message('w1', '<p>working on it — tests pass</p>') });
    await h.emit({
      t: 'msg',
      msg: answer('w3', 'w2', '<p>↪ btw: which branch?</p><p>feat/x</p><p>side question — not kept in this conversation</p>'),
    });
    await h.emit({ t: 'msg', msg: message('w4', '<p>all green</p>') });

    expect(h.el('btw-body').textContent).toContain('feat/x');
    expect(h.el('btw-body').textContent).not.toContain('↪ btw');
    // The closing line is small print.
    expect(h.el('btw-body').querySelector('.btw-foot')?.textContent).toBe('side question — not kept in this conversation');
    // The transcript reads as the conversation: the reply, the line, the reply's next message.
    const log = h.el('log');
    expect(log.textContent).not.toContain('feat/x');
    expect(log.querySelectorAll('.m.aside')).toHaveLength(0);
    expect(log.querySelector('[data-k="1:w3"]')?.className).toBe('m aside-held');
    expect(log.querySelector('[data-k="1:w3"]')?.innerHTML).toBe('');
    expect(face(line(h))).toContain('Answer');
    expect(line(h)?.querySelector('.btw-chip')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('stays shut while the answer arrives once closed by hand, and its line opens it again', async () => {
    const h = await open({ url: at });
    await h.emit(sync(T, [asked('w1', 'which branch?'), answer('w2', 'w1', '<p>↪ btw: which branch?</p><p>feat</p>')], [T]));
    // A sync is not an arrival: nothing pops up over a topic being opened.
    expect(card(h).hidden).toBe(true);
    expect(face(line(h))).toContain('Answer');

    await h.click('#log .btw-chip');
    expect(card(h).hidden).toBe(false);
    expect(h.el('btw-body').textContent).toContain('feat');
    await h.click('#btw-close');
    expect(card(h).hidden).toBe(true);
    expect(line(h)?.querySelector('.btw-chip')?.getAttribute('aria-expanded')).toBe('false');

    await h.emit({ t: 'msg', msg: answer('w2', 'w1', '<p>↪ btw: which branch?</p><p>feat/x</p>') });
    expect(card(h).hidden).toBe(true);

    // The line toggles, and Escape puts it away without touching the panels behind it.
    await h.click('#log .btw-chip');
    expect(h.el('btw-body').textContent).toContain('feat/x');
    await h.click('#log .btw-chip');
    expect(card(h).hidden).toBe(true);
    await h.click('#log .btw-chip');
    const sbHidden = (h.doc.querySelector('.wb-sidebar') as HTMLElement).hidden;
    escape(h);
    expect(card(h).hidden).toBe(true);
    expect((h.doc.querySelector('.wb-sidebar') as HTMLElement).hidden).toBe(sbHidden);
  });

  it('opens on an answer that arrives while it is shut, if nobody shut it', async () => {
    // A reload while the answer was being worked out: the card is not up, and the answer is news.
    const h = await open({ url: at });
    await h.emit(sync(T, [asked('w1', 'which branch?')], [T]));
    expect(card(h).hidden).toBe(true);
    expect(face(line(h))).toContain('Waiting');

    await h.emit({ t: 'msg', msg: answer('w2', 'w1', '<p>↪ btw: which branch?</p><p>feat/x</p>') });
    expect(card(h).hidden).toBe(false);
    expect(h.el('btw-body').textContent).toContain('feat/x');
  });

  it('shows a refusal as the answer', async () => {
    const h = await open({ url: at });
    await h.emit(sync(T, [asked('w1', 'q')], [T]));
    await h.emit({ t: 'msg', msg: answer('w2', 'w1', '<p>agy does not support /btw.</p>') });
    expect(h.el('btw-body').textContent).toBe('agy does not support /btw.');
    expect(h.el('log').textContent).not.toContain('does not support');
  });

  it('draws an answer in the transcript again when its question is no longer held', async () => {
    // The ring keeps the newest 1000 messages, so a question can age out before its answer does.
    // An answer with no line to open it must not become unreachable.
    const h = await open({ url: at });
    await h.emit(sync(T, [asked('w1', 'which branch?'), answer('w2', 'w1', '<p>↪ btw: which branch?</p><p>feat/x</p>')], [T]));
    await h.click('#log .btw-chip');
    expect(h.doc.querySelectorAll('#log .m.aside')).toHaveLength(0);

    await h.emit(sync(T, [answer('w2', 'w1', '<p>↪ btw: which branch?</p><p>feat/x</p>')], [T]));
    expect(line(h)).toBeNull();
    expect(card(h).hidden).toBe(true);
    expect(h.doc.querySelectorAll('#log .m.aside')).toHaveLength(1);
    expect(h.doc.querySelector('#log .m.aside .b')?.textContent).toContain('feat/x');
  });

  it('keeps the pairing across a reload, from the cache', async () => {
    const messages = [asked('w1', 'which branch?'), answer('w2', 'w1', '<p>↪ btw: which branch?</p><p>feat/x</p>'), message('w3', '<p>next</p>')];
    const first = await open({ url: at });
    await first.emit(sync(T, messages, [T]));
    await saved();
    first.window.close();

    const again = await open({ url: at, idb: first.idb });
    await until('the cached transcript is painted', () => again.painted() === 3);
    expect(face(line(again))).toContain('Answer');
    expect(again.doc.querySelectorAll('#log .m.aside')).toHaveLength(0);
    await again.click('#log .btw-chip');
    expect(again.el('btw-body').textContent).toContain('feat/x');
  });

  it('is put away with the topic it belongs to', async () => {
    const h = await open({ url: at });
    await h.emit(sync(T, [asked('w1', 'q'), answer('w2', 'w1', '<p>yes</p>')], [T, B]));
    await h.click('#log .btw-chip');
    expect(card(h).hidden).toBe(false);
    await h.click(`[data-topic="${B}"]`);
    expect(card(h).hidden).toBe(true);
  });

  it('leaves a message that only starts like one alone', async () => {
    const h = await open({ url: at });
    await h.emit(sync(T, [message('w1', '<div class="raw">/btwx not a side question</div>', true)], [T]));
    expect(line(h)).toBeNull();
    expect(h.doc.querySelectorAll('#log .m.own')).toHaveLength(1);
  });

  it('is over the composer, inside the bar, and a finger target on a phone', async () => {
    const html = renderPage('Chat', false);
    expect(html).toContain('#btw{position:absolute;left:16px;right:16px;bottom:calc(100% + 6px)');
    const h = await open();
    expect(h.el('btw').parentElement?.id).toBe('bar');
    const at640 = html.indexOf('@media(max-width:640px){');
    let depth = 0;
    let css = '';
    for (let i = html.indexOf('{', at640); i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) {
        css = html.slice(at640, i + 1);
        break;
      }
    }
    expect(css).toContain('#btw{left:8px;right:8px;max-height:min(55dvh,480px)}');
    expect(css).toContain('#btw-close{min-width:44px;min-height:44px}');
    expect(css).toContain('.btw-chip{min-height:44px}');
  });
});

describe('webui page: what needs you, and sub-agent topics', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const C = 'c3d4e5f6';
  const D = 'd15a7c40';
  const rows = (h: Harness): Array<string | null> =>
    Array.from(h.el('topics').querySelectorAll('[data-topic]')).map((r) => r.getAttribute('data-topic'));
  /** The rows marked as needing you, in order, with what each says on hover. */
  const needs = (h: Harness): Array<[string | null, string | null]> =>
    Array.from(h.el('topics').querySelectorAll('.topic-item.needs')).map((r) => [r.getAttribute('data-topic'), r.getAttribute('title')]);
  const list = (extra: Record<string, Record<string, unknown>>): Array<Record<string, unknown>> =>
    [A, B, C, D].map((id, i) => ({ id, title: `T ${id}`, lastAt: 1000 - i, msgCount: 0, stage: 'idle', ...(extra[id] ?? {}) }));

  it('puts what needs you first, in green — questions, then failures, then unread replies — and nothing else', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    expect(needs(h)).toEqual([]);

    await h.emit({
      t: 'topics',
      topics: list({
        A: {},
        [B]: { stage: 'review', line: 'Done: shipped 2.18.0' },
        [C]: { stage: 'failed', line: 'upstream 503' },
        [D]: { stage: 'answer', line: 'Merge now?' },
      }),
    });
    expect(needs(h)).toEqual([
      [D, 'Waiting on your answer: Merge now?'],
      [C, 'Failed: upstream 503'],
      [B, 'Finished: Done: shipped 2.18.0'],
    ]);
    // Each topic once: the rows themselves move up, with a line under them, rather than a second
    // copy of each in a block of their own (which read as two conversations).
    expect(rows(h)).toEqual([D, C, B, A]);
    expect(h.doc.querySelector(`#topics [data-topic="${A}"]`)?.classList.contains('after-needs')).toBe(true);
    expect(h.doc.getElementById('needs')).toBeNull();
    // The dot still says which of the three it is.
    expect(h.doc.querySelector(`#topics [data-topic="${B}"] .topic-dot`)?.className).toBe('topic-dot review');

    // Working, retrying and idle take no room; and the topic on screen is not listed as news.
    await h.emit({ t: 'topics', topics: list({ [A]: { stage: 'review' }, [B]: { stage: 'working' }, [C]: { stage: 'retrying' } }) });
    expect(needs(h)).toEqual([]);
    expect(rows(h)).toEqual([A, B, C, D]);
  });

  it('opens a topic that needs you like any other row', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: list({ [C]: { stage: 'failed', line: 'x' } }) });
    await h.click(`#topics .topic-item.needs[data-topic="${C}"]`);
    await opens(h, `api/events?t=${C}`);
  });

  it('offers Stop over a topic whose sub-agents still work after its own turn ended', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    const stop = h.el('stop-turn') as HTMLButtonElement;
    await h.emit({ t: 'topics', topics: list({ [B]: { parent: A } , [C]: { parent: B, running: true } }) });
    expect(stop.hidden).toBe(false);
    expect(stop.title).toContain('sub-agents it started');
    await h.click('#stop-turn');
    expect(h.calls.find((c) => c.path === 'api/send')?.body.text).toBe('/stop');

    await h.emit({ t: 'topics', topics: list({ [B]: { parent: A }, [C]: { parent: B } }) });
    expect(stop.hidden).toBe(true);
  });

  it('nests a sub-agent’s topic under the one that opened it, folded a level at a time', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: list({ [B]: { parent: D }, [C]: { parent: B }, [D]: { starred: true, live: true } }) });
    // Folded on first sight: the column lists conversations, not the working detail behind one.
    expect(rows(h)).toEqual([D, A]);
    expect(face(h.doc.querySelector(`#topics [data-fold="${D}"]`))).toBe('[chevronRight] 1');
    await h.click(`#topics [data-fold="${D}"]`);
    // Opening one level does not open the next.
    expect(rows(h)).toEqual([D, B, A]);
    expect(face(h.doc.querySelector(`#topics [data-fold="${B}"]`))).toBe('[chevronRight] 1');
    await h.click(`#topics [data-fold="${B}"]`);
    expect(rows(h)).toEqual([D, B, C, A]);
    const row = (id: string): Element => h.doc.querySelector(`#topics [data-topic="${id}"]`)!;
    expect(row(D).className).not.toMatch(/\bsub\b/);
    expect(row(B).className).toMatch(/\bsub d1\b/);
    expect(row(C).className).toMatch(/\bsub d2\b/);
    expect(face(row(D).querySelector('[data-fold]'))).toBe('[chevronDown] 1');
    expect(row(A).querySelector('[data-fold]')).toBeNull();
    // A child is a topic like any other: its row carries the same ⋯ menu, with star and delete.
    expect(row(B).querySelector('[data-rm]')).not.toBeNull();
  });

  it('folds a parent’s sub-agents away by default — remembered, colour kept, and without switching to it', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    const topics = list({ [B]: { parent: D }, [C]: { parent: D, running: true } });
    await h.emit({ t: 'topics', topics });
    // Folded on first sight, and the pill takes the colour of what it hides.
    expect(rows(h)).toEqual([D, A]);
    const pill = h.doc.querySelector(`#topics [data-fold="${D}"]`)!;
    expect(face(pill)).toBe('[chevronRight] 2');
    expect(pill.className).toContain('running');
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    // Opening is the operator's choice, and it is kept as one.
    await h.click(`#topics [data-fold="${D}"]`);
    expect(rows(h)).toEqual([D, B, C, A]);
    expect(JSON.parse(h.window.localStorage.getItem('plugin:topics:folded') ?? '{}')).toEqual({ [D]: false });
    await opens(h, `api/events?t=${A}`);
    await h.click(`#topics [data-fold="${D}"]`);
    expect(rows(h)).toEqual([D, A]);
    expect(JSON.parse(h.window.localStorage.getItem('plugin:topics:folded') ?? '{}')).toEqual({ [D]: true });
  });

  it('never folds away the topic on screen, even under the default fold', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${C}` });
    await h.emit(sync(C, [], [C]));
    await h.emit({ t: 'topics', topics: list({ [C]: { parent: D } }) });
    expect(rows(h)).toEqual([A, B, D, C]);
    expect(face(h.doc.querySelector(`#topics [data-fold="${D}"]`))).toBe('[chevronDown] 1');
  });

  it('draws a topic whose sub-agents work as running, not idle', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: list({ [B]: { parent: A }, [C]: { parent: B, running: true } }) });
    const row = (): Element => h.doc.querySelector(`#topics [data-topic="${A}"]`)!;
    // Its own turn ended long ago; the job did not, so the row and the header both say running.
    expect(row().className).toMatch(/\brunning\b/);
    expect(row().querySelector('.topic-dot')?.className).toBe('topic-dot running');
    expect(h.doc.querySelector(`.topic-item[data-topic="${A}"]`)?.classList.contains('running')).toBe(true);
    expect((h.el('stop-turn') as HTMLButtonElement).hidden).toBe(false);
    // And it is not offered for closing as an idle agent either.
    expect(h.doc.querySelector('[data-status-id="status.idle"]')?.getAttribute('data-count')).toBe('0');

    await h.emit({ t: 'topics', topics: list({ [B]: { parent: A }, [C]: { parent: B } }) });
    expect(row().className).not.toMatch(/\brunning\b/);
    expect((h.el('stop-turn') as HTMLButtonElement).hidden).toBe(true);
  });

  it('orders the list by state: a decision, then working, then resident, then no agent', async () => {
    const E = 'e6f7a8b9';
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        // The daemon's order, deliberately the reverse of the one these states belong in.
        { id: A, title: 'stopped', lastAt: 1000, msgCount: 0, stage: 'idle' },
        { id: D, title: 'resident', lastAt: 999, msgCount: 0, stage: 'idle', live: true },
        { id: B, title: 'decision', lastAt: 998, msgCount: 0, stage: 'answer', asking: true, running: true, live: true },
        { id: C, title: 'working', lastAt: 997, msgCount: 0, stage: 'working', running: true, live: true },
        { id: E, title: 'resident, starred', lastAt: 996, msgCount: 0, stage: 'idle', live: true, starred: true },
      ],
    });
    // A star leads its unstarred peers inside a state, and the daemon's order holds below that.
    expect(rows(h)).toEqual([B, C, E, D, A]);
    expect(h.doc.querySelector(`#topics [data-topic="${C}"]`)?.classList.contains('after-needs')).toBe(true);
  });

  it('puts a topic with no title yet below what needs you and above every state', async () => {
    const U = 'a9b8c7d6';
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: [
        // The daemon's order, deliberately the reverse of the one these states belong in.
        { id: A, title: 'stopped', lastAt: 1000, msgCount: 0, stage: 'idle' },
        { id: D, title: 'resident', lastAt: 999, msgCount: 0, stage: 'idle', live: true },
        { id: C, title: 'working', lastAt: 998, msgCount: 0, stage: 'working', running: true, live: true },
        { id: B, title: 'decision', lastAt: 997, msgCount: 0, stage: 'answer', asking: true, running: true, live: true },
        // Opened a moment ago: nothing said in it yet, so no title and no agent behind it.
        { id: U, title: '', lastAt: 996, msgCount: 0, stage: 'idle' },
      ],
    });
    expect(rows(h)).toEqual([B, U, C, D, A]);
    // The line under the needs-you group falls before the untitled row, which is the first of
    // the ordinary ones.
    expect(h.doc.querySelector(`#topics [data-topic="${U}"]`)?.classList.contains('after-needs')).toBe(true);

    // Untitled is a place in the list, not a state: it leads even a working topic.
    await h.emit({
      t: 'topics',
      topics: [
        { id: C, title: 'working', lastAt: 1000, msgCount: 0, stage: 'working', running: true, live: true },
        { id: U, title: '', lastAt: 999, msgCount: 0, stage: 'working', running: true, live: true },
      ],
    });
    expect(rows(h)).toEqual([U, C]);

    // And a sub-agent's topic stays its parent's, untitled or not.
    await h.emit({
      t: 'topics',
      topics: [
        { id: D, title: 'parent', lastAt: 1000, msgCount: 0, stage: 'idle', live: true },
        { id: U, title: '', lastAt: 999, msgCount: 0, stage: 'idle', parent: D },
        { id: C, title: 'working', lastAt: 998, msgCount: 0, stage: 'working', running: true, live: true },
      ],
    });
    expect(rows(h)).toEqual([C, D]);
    await h.click(`#topics [data-fold="${D}"]`);
    expect(rows(h)).toEqual([C, D, U]);
  });

  it('puts a sub-agent’s topic first only for a question of its own', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({
      t: 'topics',
      topics: list({
        [B]: { parent: A, stage: 'review', line: 'done' },
        [C]: { parent: A, stage: 'answer', asking: true, line: 'Which branch?' },
        [D]: { parent: A, stage: 'failed', line: 'boom' },
      }),
    });
    expect(needs(h)).toEqual([[C, 'Waiting on your answer: Which branch?']]);
    expect(rows(h)[0]).toBe(C);
    // The parent is folded, and its pill carries the question it is hiding.
    expect(h.doc.querySelector(`#topics [data-fold="${A}"]`)?.className).toContain('asking');
  });

  it('keeps a sub-agent’s finished dot grey, and lights only the topic that opened it', async () => {
    // The current topic is the sub-agent's, so its row is painted even though it is nested: its
    // parent is an ancestor and is drawn open. B has a parent; C is an ordinary topic.
    const h = await open({ url: `http://localhost:8787/?t=${B}` });
    await h.emit(sync(B, [], [B]));
    const dot = (id: string): string | undefined =>
      h.doc.querySelector(`#topics [data-topic="${id}"] .topic-dot`)?.className;

    await h.emit({
      t: 'topics',
      topics: list({ [B]: { parent: A, stage: 'review', line: 'done' }, [C]: { stage: 'review', line: 'done' } }),
    });
    // A finished sub-agent is the news of the agent that opened it, not of the person: no green
    // "unread reply" dot, just the ordinary idle grey. A root topic keeps the green one.
    expect(dot(B)).toBe('topic-dot');
    expect(dot(C)).toBe('topic-dot review');
    // Resident, the same row is the ordinary online grey — not a green of its own.
    await h.emit({
      t: 'topics',
      topics: list({ [B]: { parent: A, stage: 'review', live: true }, [C]: { stage: 'review', live: true } }),
    });
    expect(dot(B)).toBe('topic-dot live');
    expect(dot(C)).toBe('topic-dot review');
    // Its own work and its own question are unchanged: blue while it runs, amber while it asks.
    await h.emit({
      t: 'topics',
      topics: list({
        [B]: { parent: A, stage: 'working', running: true },
        [C]: { parent: A, stage: 'answer', asking: true, running: true },
      }),
    });
    expect(dot(B)).toBe('topic-dot running');
    expect(dot(C)).toBe('topic-dot asking');
  });

  it('marks a failed topic’s dot red when nothing else is going on', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: list({ [C]: { stage: 'failed' }, [B]: { stage: 'failed', running: true } }) });
    expect(h.doc.querySelector(`#topics [data-topic="${C}"] .topic-dot`)?.className).toBe('topic-dot failed');
    expect(h.doc.querySelector(`#topics [data-topic="${B}"] .topic-dot`)?.className).toBe('topic-dot running');
  });

  it('tells the daemon a reply on screen was read — once, and not while the page is hidden', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    const seen = (): number => h.calls.filter((c) => c.path === 'api/seen').length;

    await h.emit({ t: 'topics', topics: list({ [A]: { stage: 'review' } }) });
    expect(h.calls.find((c) => c.path === 'api/seen')?.body).toEqual({ topic: A });
    await h.emit({ t: 'topics', topics: list({ [A]: { stage: 'review' } }) });
    expect(seen()).toBe(1);

    // Another topic's unread reply is not this page's to mark.
    await h.emit({ t: 'topics', topics: list({ [B]: { stage: 'review' } }) });
    expect(seen()).toBe(1);

    Object.defineProperty(h.doc, 'visibilityState', { value: 'hidden', configurable: true });
    await new Promise((r) => setTimeout(r, 2_100));
    await h.emit({ t: 'topics', topics: list({ [A]: { stage: 'review' } }) });
    expect(seen()).toBe(1);
    Object.defineProperty(h.doc, 'visibilityState', { value: 'visible', configurable: true });
    h.doc.dispatchEvent(new h.window.Event('visibilitychange'));
    await tick();
    expect(seen()).toBe(2);
  });

  it('switches to a topic a message links to, in place', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${D}` });
    await h.emit(
      sync(D, [message('w1', `<p>Done in <a href="?t=${C}" data-goto="${C}">shop-api</a>.</p>`)], [D, A, C])
    );
    const before = h.streams.length;
    await h.click('#log a[data-goto]');
    await opens(h, `api/events?t=${C}`);
    expect(h.streams.length).toBe(before + 1);
    // Not a navigation: the page is the same page.
    expect(h.window.location.search).toBe(`?t=${C}`);
  });

  it('ignores a link to a topic it does not have', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${D}` });
    await h.emit(sync(D, [message('w1', '<p><a href="?t=99999999" data-goto="99999999">gone</a></p>')], [D, A]));
    await h.click('#log a[data-goto]');
    await opens(h, `api/events?t=${D}`);
  });
});

describe('webui page: workbench status bar, calm mode, close-idle, and notifications', () => {
  const T = 'a1b2c3d4';
  const OTHER = 'b2c3d4e5';

  it('renders connection, running, idle, calm, locale, theme, and version items in the status bar', async () => {
    const h = await open({ width: 1280, height: 800 });
    await h.emit(sync(T, [message('m1', '<p>hello</p>')], [T, OTHER]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: T, title: 'Active', lastAt: 2000, running: true, live: true },
        { id: OTHER, title: 'Idle one', lastAt: 1000, running: false, live: true },
      ],
    });
    await tick();

    const bar = h.doc.querySelector('.wb-status-bar');
    expect(bar).not.toBeNull();
    expect(bar?.querySelector('[data-status-id="status.connection"]')?.getAttribute('data-state')).toBe('connected');
    expect(bar?.querySelector('[data-status-id="status.running"]')?.getAttribute('data-count')).toBe('1');
    expect(bar?.querySelector('[data-status-id="status.idle"]')?.textContent).toContain('1');
    expect(bar?.querySelector('[data-status-id="status.calm"]')).not.toBeNull();
    expect(bar?.querySelector('[data-status-id="status.locale"]')).not.toBeNull();
    expect(bar?.querySelector('[data-status-id="status.theme"]')).not.toBeNull();
    expect(bar?.querySelector('[data-status-id="status.version"]')).not.toBeNull();
  });

  it('toggles low-attention (calm) mode from the status bar and persists aa_calm', async () => {
    const h = await open({ width: 1280, height: 800 });
    await h.emit(sync(T, [], [T]));

    const root = h.el('workbench-root');
    expect(root.classList.contains('calm')).toBe(false);

    await h.click('[data-status-id="status.calm"]');
    expect(root.classList.contains('calm')).toBe(true);
    expect(h.window.localStorage.getItem('aa_calm')).toBe('1');

    await h.click('[data-status-id="status.calm"]');
    expect(root.classList.contains('calm')).toBe(false);
    expect(h.window.localStorage.getItem('aa_calm')).toBeNull();
  });

  it('opens the Close Idle confirmation dialog from the status bar and posts api/topics/kill on confirm', async () => {
    const h = await open({
      width: 1280,
      height: 800,
      replies: { 'api/topics/kill': { ok: true, closed: [OTHER], kept: [] } },
    });
    await h.emit(sync(T, [], [T, OTHER]));
    await h.emit({
      t: 'topics',
      topics: [
        { id: T, title: 'Busy', lastAt: 2000, running: true, live: true },
        { id: OTHER, title: 'Idle one', lastAt: 1000, running: false, live: true },
      ],
    });
    await tick();

    await h.click('[data-status-id="status.idle"]');
    const dialog = h.doc.querySelector('.fh-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Idle one');

    const confirmBtn = dialog?.querySelector<HTMLButtonElement>('.fh-btn--primary, .fh-btn--danger');
    expect(confirmBtn).not.toBeNull();
    confirmBtn!.click();
    await tick();
    expect(h.calls.some((c) => c.path.includes('topics/close-idle'))).toBe(true);
  });

  it('toggles language from the status bar without reload and persists fh_lang', async () => {
    const h = await open({ width: 1280, height: 800 });
    await h.emit(sync(T, [], [T]));
    expect(h.doc.documentElement.lang).toBe('en');

    await h.click('[data-status-id="status.locale"]');
    await tick();
    expect(h.doc.documentElement.lang).toBe('zh-CN');
    expect(h.window.localStorage.getItem('fh_lang')).toBe('zh-CN');

    await h.click('[data-status-id="status.locale"]');
    await tick();
    expect(h.doc.documentElement.lang).toBe('en');
  });
});

describe('webui page: Escape belongs to what is in front of it', () => {
  const T = 'a1b2c3d4';
  const esc = (h: Harness, extra: KeyboardEventInit = {}) => {
    const win = h.doc.defaultView as Window & typeof globalThis;
    h.doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, ...extra }));
  };

  it('dismisses command suggestions on Escape without closing the sidebar', async () => {
    const h = await open({ width: 1280, height: 800 });
    await h.emit(sync(T, [], [T], { commands: [{ name: 'new', description: 'start over' }] }));
    const input = h.el('input') as HTMLTextAreaElement;
    input.value = '/';
    input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await tick();
    expect(h.el('hints').hidden).toBe(false);

    esc(h);
    await tick();
    expect(h.el('hints').hidden).toBe(true);
    expect((h.doc.querySelector('.wb-sidebar') as HTMLElement).hidden).toBe(false);
  });

  it('closes the topic row menu on Escape without touching the sidebar', async () => {
    const h = await open({ width: 1280, height: 800 });
    await h.emit(sync(T, [], [T]));
    await h.click(`[data-rm="topic:${T}"]`);
    const menuEl = h.doc.querySelector<HTMLElement>('.wb-topic-row-menu');
    expect(menuEl).not.toBeNull();
    expect(menuEl?.hidden).toBe(false);

    esc(h);
    await tick();
    const after = h.doc.querySelector<HTMLElement>('.wb-topic-row-menu');
    expect(after === null || after.hidden).toBe(true);
    expect((h.doc.querySelector('.wb-sidebar') as HTMLElement).hidden).toBe(false);
  });

  it('closes the Close Idle dialog on Escape without closing the sidebar', async () => {
    const h = await open({ width: 1280, height: 800 });
    await h.emit(sync(T, [], [T]));
    await h.emit({ t: 'topics', topics: [{ id: T, title: 'Idle', lastAt: 1000, running: false, live: true }] });
    await tick();

    await h.click('[data-status-id="status.idle"]');
    expect(h.doc.querySelector('.fh-dialog')).not.toBeNull();

    esc(h);
    await tick();
    expect(h.doc.querySelector('.fh-dialog')).toBeNull();
    expect((h.doc.querySelector('.wb-sidebar') as HTMLElement).hidden).toBe(false);
  });
});
