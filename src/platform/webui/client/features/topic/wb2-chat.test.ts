// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../base/event.js';
import type { TopicInfo } from '../../plugins/api.js';
import {
  buildTopicEditorDom,
  createTopicEditorPanel,
  DEFAULT_TOPIC_EDITOR_ICONS,
  type TopicPanelInitContext,
  type TopicPanelRef,
} from './editor/index.js';
import { statusSegments } from './status/format.js';
import { createTopicStatusController } from './status/index.js';
import { launchHtml } from './transcript/banners.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const STYLES_DIR = path.resolve(THIS_DIR, '../../styles');

function makeInitContext(id: string): TopicPanelInitContext {
  const vis = new Emitter<boolean>();
  const dims = new Emitter<{ readonly width: number; readonly height: number }>();
  const api: TopicPanelRef = {
    id,
    group: 'main',
    params: undefined,
    onDidVisibilityChange: vis.event,
    onDidDimensionsChange: dims.event,
    setTitle: vi.fn(),
    setBadge: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
  };
  return { id, api };
}

describe('wb2-chat topic editor alignment', () => {
  it('builds status row with dir, power button, model sheet grab handle, and responsive send/stop icons', () => {
    const els = buildTopicEditorDom(document, DEFAULT_TOPIC_EDITOR_ICONS);
    expect(els.statusRowEl.contains(els.statusEl)).toBe(true);
    expect(els.statusRowEl.contains(els.dirEl)).toBe(true);
    expect(els.statusRowEl.contains(els.powerBtn)).toBe(true);
    expect(els.modelPop.querySelector('.mp-grab')).not.toBeNull();
    expect(els.sendBtn.querySelector('.wb-send-label')).not.toBeNull();
    expect(els.sendBtn.querySelector('.wb-send-icon svg')).not.toBeNull();
    expect(els.stopBtn.querySelector('.wb-send-label')).not.toBeNull();
    expect(els.stopBtn.querySelector('.wb-send-icon svg')).not.toBeNull();
  });

  it('updates statusRow harness, dir label, power button visibility, and sends /kill on power click', () => {
    const command = vi.fn();
    let topic: TopicInfo = {
      id: 't1',
      title: 'Refactor webui panels',
      lastAt: Date.now(),
      live: true,
      running: true,
      dir: { name: 'fleetherd', path: '~/work/fleetherd' },
      agent: { id: 'claude', harness: 'claude' },
    };

    const panel = createTopicEditorPanel({
      getTopicInfo: () => topic,
      controllers: {
        createComposer: () =>
          ({
            stashDraft: vi.fn(),
            loadDraft: vi.fn(),
            grow: vi.fn(),
            suggest: vi.fn(),
            command,
            copyTopicRef: vi.fn(),
            dispose: vi.fn(),
          }) as unknown as NonNullable<ReturnType<typeof createTopicEditorPanel>['composer']>,
      },
    });
    panel.init('t1', makeInitContext('p1'));

    expect(panel.els.statusRowEl.dataset.harness).toBe('claude');
    expect(panel.els.dirEl.hidden).toBe(false);
    // The chip shows the last folder; the whole path is the title and what a screen reader hears.
    expect(panel.els.dirNameEl.textContent).toBe('fleetherd');
    expect(panel.els.dirEl.style.getPropertyValue('--n')).toBe('9');
    expect(panel.els.dirNameEl.getAttribute('aria-hidden')).toBe('true');
    expect(panel.els.dirEl.title).toBe('~/work/fleetherd');
    expect(panel.els.dirFullEl.textContent).toBe('Working directory: ~/work/fleetherd');
    expect(panel.els.dirFullEl.className).toBe('wb-sr-only');
    expect(panel.els.dirEl.querySelector('svg.ic-folder')).not.toBeNull();
    expect(panel.els.powerBtn.hidden).toBe(false);
    expect(panel.els.composerForm.classList.contains('is-running')).toBe(true);

    panel.els.powerBtn.click();
    expect(command).toHaveBeenCalledWith('/kill');

    // A directory without a short name is cut to its last folder here; one with none stays whole.
    topic = { ...topic, dir: { name: '', path: '/srv/apps/web-store/' } };
    panel.refreshHeader();
    expect(panel.els.dirNameEl.textContent).toBe('web-store');
    expect(panel.els.dirEl.title).toBe('/srv/apps/web-store/');
    topic = { ...topic, dir: { name: '', path: '/' } };
    panel.refreshHeader();
    expect(panel.els.dirNameEl.textContent).toBe('/');

    topic = { ...topic, live: false, running: false, dir: undefined, agent: undefined };
    panel.refreshHeader();
    expect(panel.els.powerBtn.hidden).toBe(true);
    expect(panel.els.dirEl.hidden).toBe(true);
    expect(panel.els.dirFullEl.textContent).toBe('');
    expect(panel.els.statusRowEl.dataset.harness).toBeUndefined();
    expect(panel.els.composerForm.classList.contains('is-running')).toBe(false);
    panel.dispose();
  });

  it('wraps agent name and middot separators in statusSegments for desktop/mobile styling', () => {
    const html = statusSegments(
      { agent: 'claude', model: 'sonnet-5.5', effort: 'high' },
      Date.now(),
      false,
      { fallbackOptions: [], openModel: false, openOptId: null },
    );
    // Its length rides along, for the phone's shrink floor (composer.css).
    expect(html).toContain('<span class="st-agent" style="--n:6">claude</span>');
    expect(html).toContain('<span class="st-sep"> · </span>');
    expect(html).toContain('<button type="button" class="st-model st-opt st-eff" data-effort="1"');
    expect(html).toContain('<span class="st-mtext">high</span>');
  });

  it('renders harness badge and mobile checkmark in new-topic launchHtml', () => {
    const html = launchHtml(
      {
        current: 'claude',
        groups: [
          {
            name: 'gateway',
            agents: [
              { id: 'claude', harness: 'claude', kind: 'Claude Code', model: 'sonnet-5.5' },
              { id: 'custom-a', harness: 'custom', kind: 'node' },
            ],
          },
        ],
      },
      { icon: { check: '<svg class="chk"/>', offline: '<svg class="off"/>' }, mark: {}, reaction: {} },
      { offSince: () => 0, offWhen: () => '', offTitle: () => '' },
    );
    expect(html).toContain('<span class="ac-hc h-claude">claude</span>');
    expect(html).toContain('<span class="ac-check" aria-hidden="true"><svg class="chk"/></span>');
    expect(html).toContain('Claude Code</span><span class="ac-sep" aria-hidden="true"> · </span><span class="ac-model"');
    expect(html).not.toContain('h-custom');
  });

  it('keeps where both phone lines were scrolled when the status repaints', () => {
    const els = buildTopicEditorDom(document, DEFAULT_TOPIC_EDITOR_ICONS);
    document.body.append(els.root);
    const status = createTopicStatusController({
      statusEl: els.statusEl,
      pendingQueueEl: els.pendingQueueEl,
      modelPopEls: els,
      getTopic: () => 't1',
      isSynced: () => true,
      hasLauncher: () => false,
      hasMessages: () => true,
      narrow: () => true,
      getIcons: () => ({ check: '' }) as never,
      inl: (s) => s,
      setNote: vi.fn(),
      onRetireLocalNonce: vi.fn(),
      onRecallContent: vi.fn(),
      now: () => 1_700_000_000_000,
    });
    const base = {
      agent: 'cc',
      model: 'opus',
      context: { used: 50_000, size: 200_000 },
      cost: { amount: 0.25, currency: 'USD' },
    };
    status.setStatus(base);
    const who = els.statusEl.querySelector<HTMLElement>('.st-who')!;
    who.scrollLeft = 120;
    els.statusEl.querySelector<HTMLElement>('.st-info')!.scrollLeft = 40;

    status.setStatus({ ...base, cost: { amount: 0.5, currency: 'USD' } });
    // Repainted: new elements, put back where the reader had them.
    expect(els.statusEl.querySelector('.st-who')).not.toBe(who);
    expect(els.statusEl.querySelector<HTMLElement>('.st-who')!.scrollLeft).toBe(120);
    expect(els.statusEl.querySelector<HTMLElement>('.st-info')!.scrollLeft).toBe(40);
    expect(els.statusEl.textContent).toContain('$0.50');
    status.dispose();
    els.root.remove();
  });

  it('includes mobile duplicate-header suppression, own bubble, and model sheet rules in CSS', () => {
    const transcriptCss = fs.readFileSync(path.join(STYLES_DIR, 'transcript.css'), 'utf8');
    const composerCss = fs.readFileSync(path.join(STYLES_DIR, 'composer.css'), 'utf8');
    const workbenchCss = fs.readFileSync(path.join(STYLES_DIR, 'workbench.css'), 'utf8');
    expect(workbenchCss).toContain('.wb-root[data-wb-mode="mobile"] .wb-shell.is-single-topic .wb-group-head');
    expect(transcriptCss).toContain('border-radius:18px 18px 4px 18px');
    expect(composerCss).toContain('.wb-topic-editor .mp-grab');
    expect(composerCss).toContain('.wb-topic-editor .st-sep{display:none}');
  });

  it('hides touch message action bars by default, reveals on .actions-open/focus-within, and reserves own-bubble spacing only when shown', () => {
    const transcriptCss = fs.readFileSync(path.join(STYLES_DIR, 'transcript.css'), 'utf8');
    const hoverNoneIdx = transcriptCss.indexOf('@media(hover:none){.msg-actions{');
    const mobileStart = transcriptCss.indexOf('@media (max-width: 640px) {');
    expect(hoverNoneIdx).toBeGreaterThan(-1);
    expect(mobileStart).toBeGreaterThan(hoverNoneIdx);

    const hoverNoneLine = transcriptCss.slice(hoverNoneIdx, transcriptCss.indexOf('\n', hoverNoneIdx));
    expect(hoverNoneLine).toContain('opacity:0;pointer-events:none');
    expect(hoverNoneLine).toContain('.m.actions-open>.msg-actions,.m:focus-within>.msg-actions,.msg-actions:focus-within{');

    const mobileBlock = transcriptCss.slice(mobileStart, transcriptCss.indexOf('\n}', mobileStart));
    expect(mobileBlock).toContain(
      '.wb-topic-editor .m.own>.msg-actions{position:absolute;top:calc(100% + 4px);right:0;left:auto;margin-top:0;width:max-content}',
    );
    expect(mobileBlock).not.toContain('.wb-topic-editor .m.own:has(>.msg-actions){margin-bottom:54px}');
    expect(mobileBlock).toContain('.wb-topic-editor .m.own.actions-open:has(>.msg-actions)');
    expect(mobileBlock).toContain('.wb-topic-editor .m.own:focus-within:has(>.msg-actions){margin-bottom:54px}');
    expect(mobileBlock).toContain('flex-wrap:nowrap;white-space:nowrap');
    expect(mobileBlock).toContain('.wb-topic-editor .msg-act-btn{flex:none;width:28px;height:26px}');
    expect(transcriptCss).toContain('.wb-topic-editor .b>.tools{border:1px solid var(--fh-line);');
  });

  it('lays out the phone status row as one sideways-scrolling line of chips over one line of readings', () => {
    const composerCss = fs.readFileSync(path.join(STYLES_DIR, 'composer.css'), 'utf8');
    const statusCss = fs.readFileSync(path.join(STYLES_DIR, 'status.css'), 'utf8');
    expect(statusCss).toContain('.st-info{display:contents}');

    const mobileStart = composerCss.indexOf('@media (max-width: 640px) {');
    expect(mobileStart).toBeGreaterThan(-1);
    let depth = 0;
    let mobileEnd = -1;
    for (let i = composerCss.indexOf('{', mobileStart); i < composerCss.length; i++) {
      if (composerCss[i] === '{') depth++;
      else if (composerCss[i] === '}' && --depth === 0) {
        mobileEnd = i + 1;
        break;
      }
    }
    const mobileBlock = composerCss.slice(mobileStart, mobileEnd);
    const desktop = composerCss.slice(0, mobileStart) + composerCss.slice(mobileEnd);

    // The row still wraps, but only to put the readings under the chips.
    expect(mobileBlock).toContain('.wb-topic-editor .wb-topic-status-row{flex-wrap:wrap;');
    expect(mobileBlock).toContain('.wb-topic-editor #status:not([hidden]){display:contents;');
    // Neither line wraps; each scrolls sideways with no scrollbar drawn.
    expect(mobileBlock).toContain(
      '.wb-topic-editor .st-who,\n  .wb-topic-editor .st-info{display:flex;flex-wrap:nowrap;align-items:center;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;',
    );
    expect(mobileBlock).toContain('.wb-topic-editor .st-info::-webkit-scrollbar{display:none}');
    // Both start from nothing, so neither pushes the other to a new line; the chips grow first.
    expect(mobileBlock).toContain('.wb-topic-editor .st-who{order:1;flex:1000 1 0;max-width:max-content;');
    // Floors of 64px and 56px, or the name's own width when it is shorter, so a short one is not padded.
    expect(mobileBlock).toContain('.wb-topic-editor .wb-topic-dir{order:2;flex:1 1 0;max-width:max-content;min-width:min(64px,calc(var(--n,99)*1ch + 32px));');
    expect(mobileBlock).toContain('.wb-topic-editor .st-agent{flex:0 1 auto;min-width:min(56px,calc(var(--n,99)*1ch + 16px));');
    expect(mobileBlock).toContain('.wb-topic-editor .st-info{order:3;flex:1 0 100%;');
    expect(mobileBlock).toContain('.wb-topic-editor .st-info>.st-cost{order:1}');
    // A 24px pill in a 32px target: the band above and below is transparent border, not margin.
    expect(mobileBlock).toContain('height:32px;min-height:32px;margin:0;padding:0 8px;border:solid transparent;border-width:4px 0;border-radius:999px;background-clip:padding-box;');
    expect(mobileBlock).toContain('.wb-topic-editor .st-model[aria-expanded="true"]{background-clip:padding-box}');
    // The left-ellipsis trick for a whole path is gone with the path.
    expect(composerCss).not.toContain('direction:rtl');
    // The effort level is a switch (.st-eff, a .st-model) now; the plain-text pill's rules went with it.
    expect(composerCss).not.toContain('.st-effort');
    // None of it leaks onto the desktop row, which wraps as it did.
    expect(desktop).not.toContain('overflow-x:auto');
    expect(desktop).not.toContain('flex:1000 1 0');
    expect(desktop).toContain('.wb-topic-editor .wb-topic-dir{display:flex;align-items:center;gap:4px;flex:none;max-width:30%;');
    // The harness colour sets only the colour, so the phone's clipped pill survives it.
    expect(desktop).toContain('.wb-topic-editor .wb-topic-status-row[data-harness="claude"] .st-agent{background-color:');
    expect(desktop).not.toMatch(/\[data-harness="[a-z]+"\] \.st-agent\{background:/);
  });
});
