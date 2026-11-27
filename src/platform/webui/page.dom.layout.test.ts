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

describe('webui page: workbench responsive layout (desktop, tablet, mobile)', () => {
  it('mounts the three-part workbench shell by default on desktop (>= 1024px) without any dev flag', async () => {
    const h = await open({ width: 1280, height: 800 });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>')], ['a1b2c3d4', 'b2c3d4e5']));

    const root = h.el('workbench-root');
    expect(root.hidden).toBe(false);
    expect(root.dataset.wbMode).toBe('desktop');
    expect(h.doc.documentElement.dataset.workbench).toBeUndefined();
    expect(h.doc.querySelector('.wb-shell')).not.toBeNull();
    expect((h.doc.querySelector('.wb-shell') as HTMLElement).hidden).toBe(false);
    expect(h.doc.querySelector('.wb-activity-bar')).not.toBeNull();
    expect(h.doc.querySelector('.wb-sidebar')).not.toBeNull();
    expect(h.doc.querySelector('.wb-editor-area')).not.toBeNull();
    expect(h.doc.querySelector('.wb-status-bar')).not.toBeNull();
    expect(h.el('log').textContent).toContain('hello');
    expect(h.rows()).toBe(2);
    expect(h.doc.activeElement).toBe(h.el('input'));
  });

  it('uses drawer mode with backdrop on tablet (640-1023px) and closes drawer on backdrop click', async () => {
    const h = await open({ width: 800, height: 900 });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>tablet</p>')], ['a1b2c3d4']));

    expect(h.el('workbench-root').dataset.wbMode).toBe('tablet');
    const backdrop = h.doc.querySelector('.wb-drawer-backdrop') as HTMLElement;
    expect(backdrop).not.toBeNull();
    expect(backdrop.hidden).toBe(true);
    expect((h.doc.querySelector('.wb-sidebar') as HTMLElement).hidden).toBe(true);

    await h.click('.wb-activity-item[data-activity-id="topics"]');
    expect(backdrop.hidden).toBe(false);

    backdrop.click();
    await tick();
    expect(backdrop.hidden).toBe(true);
    expect((h.doc.querySelector('.wb-sidebar') as HTMLElement).hidden).toBe(true);
  });

  it('uses slide-out sidebar drawer on mobile (< 640px) with topic view as main screen', async () => {
    const h = await open({ width: 390, height: 844 });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>mobile</p>')], ['a1b2c3d4', 'b2c3d4e5']));

    const root = h.el('workbench-root');
    expect(root.dataset.wbMode).toBe('mobile');
    const shellEl = h.doc.querySelector('.wb-shell') as HTMLElement;
    expect(shellEl.hidden).toBe(false);
    expect(h.doc.querySelector('.wb-stack')).toBeNull();
    expect(h.el('log').textContent).toContain('mobile');
    expect(h.doc.activeElement).not.toBe(h.el('input'));

    const backdrop = h.doc.querySelector('.wb-drawer-backdrop') as HTMLElement;
    expect(backdrop.hidden).toBe(true);
    expect(shellEl.classList.contains('is-sidebar-open')).toBe(false);

    await h.click('#expand-sidebar');
    expect(shellEl.classList.contains('is-sidebar-open')).toBe(true);
    expect(backdrop.hidden).toBe(false);
    const tabBar = h.doc.querySelector('.wb-stack-tabbar') as HTMLElement;
    expect(tabBar).not.toBeNull();
    expect(tabBar.hidden).toBe(false);
    const tabIds = Array.from(tabBar.querySelectorAll('.wb-stack-tab')).map((el) =>
      el.getAttribute('data-tab-id'),
    );
    expect(tabIds).toEqual(['topics', 'history', 'reviews', 'more']);
    expect((h.doc.querySelector('.wb-activity-bar') as HTMLElement).inert).toBe(true);

    // Topics actions (+, mark all read, clear) live in the drawer title bar, not a separate row.
    const headActionIds = Array.from(
      h.doc.querySelectorAll('.wb-sidebar-head > .wb-part-actions button[data-action-id]'),
    ).map((el) => el.getAttribute('data-action-id'));
    expect(headActionIds).toEqual(['topics.new', 'topics.markAllRead', 'topics.clearUnstarred']);
    expect((h.doc.querySelector('.wb-topics-head') as HTMLElement).hidden).toBe(true);

    await h.click('.wb-stack-tab[data-tab-id="more"]');
    expect(h.doc.querySelector('.wb-stack-more [data-group-item="reviews"]')).toBeNull();
    expect(h.doc.querySelector('.wb-stack-more [data-group-item="review-prefs"]')).not.toBeNull();
    expect(h.doc.querySelector('.wb-stack-more [data-group-item="skills"]')).not.toBeNull();
    expect(h.doc.querySelector('.wb-stack-more [data-group-item="schedules"]')).not.toBeNull();
    expect(h.doc.querySelector('.wb-stack-more [data-group-item="settings"]')).not.toBeNull();
    await h.click('.wb-stack-tab[data-tab-id="topics"]');

    await h.click('.wb-sidebar [data-topic="b2c3d4e5"]');
    expect(shellEl.classList.contains('is-sidebar-open')).toBe(false);
    expect(backdrop.hidden).toBe(true);
    expect(h.doc.activeElement).not.toBe(h.el('input'));

    await h.click('#expand-sidebar');
    expect(shellEl.classList.contains('is-sidebar-open')).toBe(true);
    backdrop.click();
    await tick();
    expect(shellEl.classList.contains('is-sidebar-open')).toBe(false);
    expect(backdrop.hidden).toBe(true);
  });
});

describe('webui page: workbench activity bar and built-in views', () => {
  it('populates the activity bar from ContributionRegistry and switches sidebar views', async () => {
    const h = await open({
      width: 1280,
      height: 800,
      replies: {
        'api/history': { enabled: true, sessions: [], more: false },
        'api/schedules': { enabled: true, tasks: [] },
        'api/reviews': { enabled: true, reviews: [], pending: [] },
        'api/skills': { enabled: true, skills: [] },
      },
    });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    const items = Array.from(h.doc.querySelectorAll('.wb-activity-item')).map((el) =>
      el.getAttribute('data-activity-id'),
    );
    expect(items).toEqual(['topics', 'history', 'reviews', 'skills', 'schedules', 'settings']);

    const topicsBtn = h.doc.querySelector('.wb-activity-item[data-activity-id="topics"]') as HTMLElement;
    const historyBtn = h.doc.querySelector('.wb-activity-item[data-activity-id="history"]') as HTMLElement;
    expect(topicsBtn.classList.contains('is-active')).toBe(true);

    historyBtn.click();
    await tick();
    expect(historyBtn.classList.contains('is-active')).toBe(true);
    expect(topicsBtn.classList.contains('is-active')).toBe(false);

    // Clicking the active activity again collapses the sidebar.
    historyBtn.click();
    await tick();
    expect((h.doc.querySelector('.wb-sidebar') as HTMLElement).hidden).toBe(true);

    // Clicking Topics re-opens the sidebar on the Topics view.
    topicsBtn.click();
    await tick();
    expect((h.doc.querySelector('.wb-sidebar') as HTMLElement).hidden).toBe(false);
    expect(topicsBtn.classList.contains('is-active')).toBe(true);
  });
});

describe('webui page: topic row menu via ContributionRegistry', () => {
  it('opens the row menu on ⋯ click, stars a topic, and deletes a topic after confirmation', async () => {
    const h = await open({ width: 1280, height: 800 });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5']));

    await h.click('[data-rm="topic:a1b2c3d4"]');
    const menu = h.doc.querySelector('.wb-topic-row-menu');
    expect(menu).not.toBeNull();
    const labels = Array.from(menu!.querySelectorAll('[role="menuitem"]')).map((n) => n.textContent?.trim());
    expect(labels.some((l) => l?.includes('Star'))).toBe(true);
    expect(labels.some((l) => l?.includes('Delete'))).toBe(true);

    const starBtn = Array.from(menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) =>
      b.textContent?.includes('Star'),
    );
    expect(starBtn).toBeTruthy();
    starBtn!.click();
    await tick();
    expect(h.calls.some((c) => c.path === 'api/topics/star')).toBe(true);

    await h.click('[data-rm="topic:b2c3d4e5"]');
    const delBtn = Array.from(h.doc.querySelectorAll<HTMLButtonElement>('.wb-topic-row-menu [role="menuitem"]')).find(
      (b) => b.textContent?.includes('Delete'),
    );
    expect(delBtn).toBeTruthy();
    delBtn!.click();
    await tick();
    const confirmBtn = h.doc.querySelector<HTMLButtonElement>('.fh-dialog .fh-btn--danger');
    expect(confirmBtn).not.toBeNull();
    confirmBtn!.click();
    await tick();
    expect(h.calls.some((c) => c.path === 'api/topics/delete')).toBe(true);
  });
});

describe('webui page: terminal topic tool in bottom panel', () => {
  it('hides the terminal tool when terminal is disabled and toggles bottom panel when enabled', async () => {
    const off = await open({ width: 1280, height: 800, terminal: false });
    await off.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    expect(off.doc.querySelector('.wb-topic-tools [data-tool-id="terminal"]')).toBeNull();

    const on = await open({ width: 1280, height: 800, terminal: true });
    await on.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    const termBtn = on.doc.querySelector<HTMLButtonElement>('.wb-topic-tools [data-tool-id="terminal"]');
    expect(termBtn).not.toBeNull();
    expect((on.doc.querySelector('.wb-panel') as HTMLElement).hidden).toBe(true);

    termBtn!.click();
    await tick();
    expect((on.doc.querySelector('.wb-panel') as HTMLElement).hidden).toBe(false);
    expect(on.doc.querySelector('.wb-terminal-panel, .wb-panel .wb-lazy-host')).not.toBeNull();

    termBtn!.click();
    await tick();
    expect((on.doc.querySelector('.wb-panel') as HTMLElement).hidden).toBe(true);
  });
});

describe('webui page: the narrow-screen stylesheet', () => {
  const blockAt = (start: string): string => {
    const html = renderPage('Chat', false);
    const at = html.indexOf(start);
    if (at < 0) throw new Error(`there is no ${start} block in the stylesheet`);
    let depth = 0;
    for (let i = html.indexOf('{', at); i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
    }
    throw new Error(`the ${start} block is never closed`);
  };
  const narrowBlock = (): string => blockAt('@media(max-width:640px){');

  it('gives a code block\'s Wrap and Copy a finger-sized target on a phone, and only there', () => {
    expect(narrowBlock()).toContain('.cb-b{width:36px;height:32px;font-size:16px}');
    const outside = renderPage('Chat', false).replace(narrowBlock(), '');
    expect(outside).not.toContain('.cb-b{width:36px');
    expect(outside).toContain('width:26px;height:24px');
  });

  it('includes mobile slide-out drawer and safe-area rules in the served stylesheet', () => {
    const html = renderPage('Chat', false);
    expect(html).toContain('.wb-root[data-wb-mode="mobile"] .wb-sidebar');
    expect(html).toContain('.wb-root[data-wb-mode="mobile"] .wb-topic-menu');
    expect(html).toContain('.wb-stack-tabbar');
    expect(html).toContain('@supports not selector(::-webkit-scrollbar)');
    expect(html).toContain('env(safe-area-inset-bottom');
    expect(html).toContain('100dvh');
    expect(narrowBlock()).toContain('#input,#secret{font-size:16px}');
  });
});

describe('webui page: recording a voice message', () => {
  const recording = async (mic: { types: string[]; deny?: boolean }): Promise<Harness> => {
    const h = await open({ mic });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    return h;
  };
  const sends = (h: Harness) => h.calls.filter((c) => c.path === 'api/send');

  it('is hidden where the browser cannot record', async () => {
    const h = await open();
    expect(h.el('mic').hidden).toBe(true);
  });

  it('records, and sends the recording on its own the moment it stops', async () => {
    const h = await recording({ types: ['audio/webm;codecs=opus'] });
    expect(h.el('mic').hidden).toBe(false);
    expect(face(h.el('mic'))).toBe('[mic]');
    await h.click('#mic');
    await tick();
    expect(h.recorders).toHaveLength(1);
    expect(h.recorders[0]!.mimeType).toBe('audio/webm;codecs=opus');
    expect(h.el('mic').classList.contains('rec')).toBe(true);
    expect(face(h.el('mic'))).toBe('[stop] 0:00');

    h.recorders[0]!.feed('pretend-opus');
    await h.click('#mic');
    await until('the recording is sent', () => sends(h).length === 1);

    const body = sends(h)[0]!.body as { text: string; files: Array<{ name: string; mime: string; data: string }> };
    expect(body.text).toBe('');
    expect(body.files).toHaveLength(1);
    // The container, without the codec parameter: that is what the daemon sniffs and types.
    expect(body.files[0]).toMatchObject({ name: 'voice-1.webm', mime: 'audio/webm' });
    expect(atob(body.files[0]!.data)).toBe('pretend-opus');
    expect(h.recorders[0]!.tracksStopped()).toBe(true); // the microphone is let go
    expect(h.el('mic').classList.contains('rec')).toBe(false);
    expect(face(h.el('mic'))).toBe('[mic]');
  });

  it('leaves a half-typed draft in the composer, unsent', async () => {
    const h = await recording({ types: ['audio/webm;codecs=opus'] });
    const input = h.el('input') as HTMLTextAreaElement;
    input.value = 'draft I have not sent';
    await h.click('#mic');
    await tick();
    h.recorders[0]!.feed('x');
    await h.click('#mic');
    await until('the recording is sent', () => sends(h).length === 1);
    expect((sends(h)[0]!.body as { text: string }).text).toBe('');
    expect(input.value).toBe('draft I have not sent');
  });

  it('prefers Ogg where the browser offers it, and names Safari’s MP4 as m4a', async () => {
    const ogg = await recording({ types: ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus'] });
    await ogg.click('#mic');
    await tick();
    expect(ogg.recorders[0]!.mimeType).toBe('audio/ogg;codecs=opus');

    const safari = await recording({ types: ['audio/mp4'] });
    await safari.click('#mic');
    await tick();
    safari.recorders[0]!.feed('aac');
    await safari.click('#mic');
    await until('the recording is sent', () => sends(safari).length === 1);
    expect((sends(safari)[0]!.body as { files: Array<{ name: string }> }).files[0]!.name).toBe('voice-1.m4a');
  });

  it('Esc throws the recording away and sends nothing', async () => {
    const h = await recording({ types: ['audio/webm;codecs=opus'] });
    await h.click('#mic');
    await tick();
    h.recorders[0]!.feed('never mind');
    const win = h.doc.defaultView as Window & typeof globalThis;
    h.doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    await tick();
    expect(sends(h)).toHaveLength(0);
    expect(h.recorders[0]!.tracksStopped()).toBe(true);
    expect(h.el('mic').classList.contains('rec')).toBe(false);
  });

  it('says why when the microphone is refused, instead of doing nothing', async () => {
    const h = await recording({ types: ['audio/webm;codecs=opus'], deny: true });
    await h.click('#mic');
    await tick();
    expect(h.el('note').textContent).toContain('Could not record: Permission denied');
    expect(h.recorders).toHaveLength(0);
  });

  it('fills the composer input with cleaned dictation when /api/voice/transcribe is configured', async () => {
    const h = await open({
      mic: { types: ['audio/webm;codecs=opus'] },
      replies: {
        'api/voice/transcribe': {
          ok: true,
          text: '那个帮我重启一下服务',
          cleaned: '帮我重启一下服务。',
          model: 'groq-whisper-large-v3-turbo',
          latencyMs: 1200,
        },
      },
    });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    const input = h.el('input') as HTMLTextAreaElement;
    input.value = '前缀';
    await h.click('#mic');
    await tick();
    h.recorders[0]!.feed('opus-bytes');
    await h.click('#mic');
    await until('dictation fills composer', () => input.value.includes('帮我重启一下服务。'));

    expect(input.value).toBe('前缀 帮我重启一下服务。');
    expect(sends(h)).toHaveLength(0);
    expect(h.el('note').textContent).toContain('1.2s');
    expect(h.el('note').textContent).toContain('那个帮我重启一下服务');
  });

  it('shows a no-speech notice without sending when dictation hears nothing', async () => {
    const h = await open({
      mic: { types: ['audio/webm;codecs=opus'] },
      replies: {
        'api/voice/transcribe': { ok: false, reason: 'no speech recognized', noSpeech: true },
      },
    });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    await h.click('#mic');
    await tick();
    h.recorders[0]!.feed('silence');
    await h.click('#mic');
    await until('no-speech note shown', () => (h.el('note').textContent ?? '').includes('No speech'));
    expect((h.el('input') as HTMLTextAreaElement).value).toBe('');
    expect(sends(h)).toHaveLength(0);
  });

  it('uploads WebM recordings directly without transcoding to WAV', async () => {
    const h = await open({
      mic: { types: ['audio/webm;codecs=opus'] },
      replies: {
        'api/voice/transcribe': { ok: true, text: '测试', model: 'whisper', latencyMs: 500 },
      },
    });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    await h.click('#mic');
    await tick();
    h.recorders[0]!.feed('fake-webm');
    await h.click('#mic');
    await until('transcribe called', () => h.calls.some((c) => c.path === 'api/voice/transcribe'));
    const call = h.calls.find((c) => c.path === 'api/voice/transcribe')!;
    const body = call.body as { mime: string; data: string };
    expect(body.mime).toBe('audio/webm');
    const raw = Buffer.from(body.data, 'base64');
    expect(raw.toString('utf8')).toBe('fake-webm');
  });
});
