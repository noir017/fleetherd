import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import type { SettingsScreen } from '../../../../../types.js';
import { createSettingsFeature } from './controller.js';
import type { SettingsFeatureDeps, SettingsWebMessage } from './types.js';

function makeHarness(overrides: Partial<SettingsFeatureDeps> = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <button id="settings-open"></button>
      <div id="settings-page" hidden>
        <span id="settings-topic"></span>
        <button id="settings-close"></button>
        <div id="settings-body"></div>
      </div>
    </body></html>`,
  );
  const doc = dom.window.document;
  let currentTopic = 'topic-a';
  const postCalls: Array<{ path: string; body: unknown; tries?: number; limit?: number }> = [];
  let postImpl = async (_path: string, _body: unknown): Promise<Response> =>
    new Response('{}', { status: 200 });

  const closeMenus = vi.fn();
  const ensure = vi.fn();
  const feature = createSettingsFeature({
    settingsPage: doc.getElementById('settings-page')!,
    settingsBody: doc.getElementById('settings-body')!,
    settingsTopicEl: doc.getElementById('settings-topic')!,
    settingsClose: doc.getElementById('settings-close')!,
    settingsOpenBtn: doc.getElementById('settings-open')!,
    instrOk: true,
    getTopic: () => currentTopic,
    getTopics: () => [
      { id: 'topic-a', title: 'Alpha' },
      { id: 'topic-b', title: 'Beta' },
    ],
    getEpoch: () => 1,
    closeMenus,
    instructions: {
      ensure,
      renderOrphans: () => '',
      renderAgent: () => '',
    },
    post: (path, body, tries, limit) => {
      postCalls.push({ path, body, tries, limit });
      return postImpl(path, body);
    },
    doc,
    fadeMs: 50,
    waitMs: 100,
    ...overrides,
  });

  return {
    dom,
    doc,
    feature,
    closeMenus,
    ensure,
    postCalls,
    setTopic: (t: string) => {
      currentTopic = t;
    },
    setPostImpl: (fn: (path: string, body: unknown) => Promise<Response>) => {
      postImpl = fn;
    },
  };
}

function baseMsg(overrides: Partial<SettingsWebMessage> & { id: string }): SettingsWebMessage {
  return { own: false, html: '', at: 0, buttons: [], reactions: [], ...overrides };
}

function listMessage(id = 'm1'): SettingsWebMessage {
  const settings: SettingsScreen = {
    level: 'list',
    groups: [{ name: 'General' }, { name: 'Agents' }],
    rows: [
      {
        group: 'General',
        label: 'Feature',
        buttonId: 'sw:1',
        control: { kind: 'switch', on: false, set: 'sts:1:1' },
      },
      {
        group: 'Agents',
        label: 'cc',
        target: 'cc',
        targetKind: 'Claude Code',
        buttonId: 'stg:cc',
        control: {
          kind: 'agent',
          fields: [{ label: 'Model', buttonId: 'stg:cc:m', value: 'sonnet', control: { kind: 'list' } }],
        },
      },
    ],
  };
  return baseMsg({ id, settings });
}

function valuesMessage(id = 'm1'): SettingsWebMessage {
  const settings: SettingsScreen = {
    level: 'values',
    head: { label: 'Model', value: 'sonnet', description: 'Model', effect: 'Next session' },
    typed: { buttonId: 'typed:m', placeholder: 'Model id' },
    options: [
      { buttonId: 'stv:1', label: 'sonnet', detail: 'Fast', current: true },
      { buttonId: 'stv:2', label: 'opus', detail: 'Deep', current: false },
    ],
    nav: { page: 1, pageCount: 1, back: 'stg:back' },
  };
  return baseMsg({ id, settings });
}

describe('features/settings/controller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens loading state from menu button, sends quiet /setting, and handles answer', async () => {
    const h = makeHarness();
    h.doc.getElementById('settings-open')!.click();
    expect(h.closeMenus).toHaveBeenCalledTimes(1);
    expect(h.feature.isOpen()).toBe(true);
    expect(h.doc.getElementById('settings-body')!.textContent).toBeTruthy();
    expect(h.postCalls).toHaveLength(1);
    expect(h.postCalls[0]!.path).toBe('api/send');
    expect(h.postCalls[0]!.body).toMatchObject({ topic: 'topic-a', text: '/setting', quiet: true });

    expect(h.feature.handleMessage(listMessage('m1'))).toBe(true);
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.doc.querySelector('.set-switch')).not.toBeNull();
    h.feature.dispose();
  });

  it('shows timeout message if daemon never answers while loading', () => {
    vi.useFakeTimers();
    const h = makeHarness({ waitMs: 50 });
    h.feature.open();
    vi.advanceTimersByTime(60);
    expect(h.doc.getElementById('settings-body')!.textContent).toContain('did not answer');
    h.feature.dispose();
  });

  it('drops late answers to requests closed while loading, but opens later requests', () => {
    const h = makeHarness();
    h.feature.open();
    h.feature.close();
    expect(h.feature.isOpen()).toBe(false);

    h.feature.take(listMessage('m1'));
    expect(h.feature.isOpen()).toBe(false);

    h.feature.open();
    h.feature.take(listMessage('m2'));
    expect(h.feature.isOpen()).toBe(true);
    h.feature.dispose();
  });

  it('keeps closed message closed on edit, and closes when edited into non-settings menu', () => {
    const h = makeHarness();
    h.feature.take(listMessage('m1'));
    expect(h.feature.isOpen()).toBe(true);

    // Non-settings edit of same message id closes the page and lets transcript handle it
    expect(h.feature.handleMessage(baseMsg({ id: 'm1', html: '<p>Schedules</p>' }))).toBe(false);
    expect(h.feature.isOpen()).toBe(false);

    // Closed message id does not reopen when edited
    h.feature.take(listMessage('m1'));
    expect(h.feature.isOpen()).toBe(false);
    expect(h.feature.handleMessage(baseMsg({ id: 'm9', wasSettings: true }))).toBe(true);
    h.feature.dispose();
  });

  it('toggles agent card accordion and preserves open card across redraws until closed', () => {
    const h = makeHarness();
    h.feature.take(listMessage('m1'));
    const top = h.doc.querySelector<HTMLButtonElement>('.ag-top')!;
    expect(top.getAttribute('aria-expanded')).toBe('false');
    top.click();
    expect(top.getAttribute('aria-expanded')).toBe('true');

    // In-place redraw keeps card open
    h.feature.take(listMessage('m1'));
    expect(h.doc.querySelector('.ag-top')!.getAttribute('aria-expanded')).toBe('true');

    h.feature.close();
    h.feature.take(listMessage('m2'));
    expect(h.doc.querySelector('.ag-top')!.getAttribute('aria-expanded')).toBe('false');
    h.feature.dispose();
  });

  it('optimistically toggles switch and rolls back with error banner on 409', async () => {
    const h = makeHarness();
    h.setPostImpl(async () => new Response('', { status: 409 }));
    h.feature.take(listMessage('m1'));

    const sw = h.doc.querySelector<HTMLButtonElement>('.set-switch')!;
    sw.click();
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.disabled).toBe(true);
    expect(sw.classList.contains('busy')).toBe(true);

    await vi.waitFor(() => {
      expect(h.doc.querySelector('.set-notice.error')).not.toBeNull();
    });
    expect(h.doc.querySelector('.set-switch')!.getAttribute('aria-checked')).toBe('false');
    h.feature.dispose();
  });

  it('filters options locally and submits typed value on Enter', () => {
    const h = makeHarness();
    h.feature.take(valuesMessage('m1'));
    const input = h.doc.querySelector<HTMLInputElement>('.set-type')!;
    input.value = 'opus';
    input.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));

    const opts = h.doc.querySelectorAll<HTMLElement>('.set-opt');
    expect(opts[0]!.hidden).toBe(true);
    expect(opts[1]!.hidden).toBe(false);

    input.value = 'claude-custom';
    input.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.postCalls).toHaveLength(1);
    expect(h.postCalls[0]!.body).toEqual({
      topic: 'topic-a',
      messageId: 'm1',
      buttonId: 'typed:m',
      value: 'claude-custom',
    });
    h.feature.dispose();
  });

  it('reloads open settings screen on locale change and skips when hidden', () => {
    const h = makeHarness();
    h.feature.onLocaleChange();
    expect(h.postCalls).toHaveLength(0);

    h.feature.take(listMessage('m1'));
    h.feature.onLocaleChange();
    expect(h.postCalls).toHaveLength(1);
    expect(h.postCalls[0]!.path).toBe('api/send');
    h.feature.dispose();
  });
});
