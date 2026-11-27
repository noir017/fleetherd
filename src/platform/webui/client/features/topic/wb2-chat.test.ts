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
    expect(panel.els.dirEl.textContent).toBe('~/work/fleetherd');
    expect(panel.els.powerBtn.hidden).toBe(false);
    expect(panel.els.composerForm.classList.contains('is-running')).toBe(true);

    panel.els.powerBtn.click();
    expect(command).toHaveBeenCalledWith('/kill');

    topic = { ...topic, live: false, running: false, dir: undefined, agent: undefined };
    panel.refreshHeader();
    expect(panel.els.powerBtn.hidden).toBe(true);
    expect(panel.els.dirEl.hidden).toBe(true);
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
    expect(html).toContain('<span class="st-agent">claude</span>');
    expect(html).toContain('<span class="st-sep"> · </span>');
    expect(html).toContain('<span class="st-effort">high</span>');
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

  it('includes mobile duplicate-header suppression, own bubble, and model sheet rules in CSS', () => {
    const transcriptCss = fs.readFileSync(path.join(STYLES_DIR, 'transcript.css'), 'utf8');
    const composerCss = fs.readFileSync(path.join(STYLES_DIR, 'composer.css'), 'utf8');
    const workbenchCss = fs.readFileSync(path.join(STYLES_DIR, 'workbench.css'), 'utf8');
    expect(workbenchCss).toContain('.wb-root[data-wb-mode="mobile"] .wb-shell.is-single-topic .wb-group-head');
    expect(transcriptCss).toContain('border-radius:18px 18px 4px 18px');
    expect(composerCss).toContain('.wb-topic-editor .mp-grab');
    expect(composerCss).toContain('.wb-topic-editor .st-sep{display:none}');
  });

  it('anchors mobile own-message action bars outside the bubble and reserves bottom spacing', () => {
    const transcriptCss = fs.readFileSync(path.join(STYLES_DIR, 'transcript.css'), 'utf8');
    const hoverNoneIdx = transcriptCss.indexOf('@media(hover:none){.msg-actions{');
    const mobileStart = transcriptCss.indexOf('@media (max-width: 640px) {');
    expect(hoverNoneIdx).toBeGreaterThan(-1);
    expect(mobileStart).toBeGreaterThan(hoverNoneIdx);

    const mobileBlock = transcriptCss.slice(mobileStart, transcriptCss.indexOf('\n}', mobileStart));
    expect(mobileBlock).toContain(
      '.wb-topic-editor .m.own>.msg-actions{position:absolute;top:calc(100% + 4px);right:0;left:auto;margin-top:0;width:max-content}',
    );
    expect(mobileBlock).toContain('.wb-topic-editor .m.own:has(>.msg-actions){margin-bottom:54px}');
    expect(mobileBlock).toContain('flex-wrap:nowrap;white-space:nowrap');
    expect(mobileBlock).toContain('.wb-topic-editor .msg-act-btn{flex:none;width:28px;height:26px}');
  });

  it('lays out mobile status row in two wrapping rows with folder on row 1 and .st-info on row 2', () => {
    const composerCss = fs.readFileSync(path.join(STYLES_DIR, 'composer.css'), 'utf8');
    const statusCss = fs.readFileSync(path.join(STYLES_DIR, 'status.css'), 'utf8');
    expect(statusCss).toContain('.st-info{display:contents}');

    const mobileStart = composerCss.indexOf('@media (max-width: 640px) {');
    expect(mobileStart).toBeGreaterThan(-1);
    const mobileBlock = composerCss.slice(mobileStart);

    expect(mobileBlock).toContain('.wb-topic-editor .wb-topic-status-row{flex-wrap:wrap;overflow-x:visible;');
    expect(mobileBlock).not.toContain('overflow-x:auto');
    expect(mobileBlock).toContain('.wb-topic-editor #status:not([hidden]){display:contents;');
    expect(mobileBlock).toContain('.wb-topic-editor .st-who{display:contents}');
    expect(mobileBlock).toContain('.wb-topic-editor .st-who>*{order:1}');
    expect(mobileBlock).toContain('.wb-topic-editor .wb-topic-dir{order:2;flex:0 2 auto;');
    expect(mobileBlock).toContain('direction:rtl;text-align:left}');
    expect(mobileBlock).toContain('.wb-topic-editor .st-info{order:3;flex:1 0 100%;display:flex;flex-wrap:wrap;');
  });
});
