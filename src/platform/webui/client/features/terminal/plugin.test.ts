// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { Emitter } from '../../base/event.js';
import type { TopicInfo, TopicToolContribution } from '../../plugins/api.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, WebuiEventBus } from '../../plugins/registry.js';
import { createApiClient } from '../../services/api.js';
import { StorageService } from '../../services/storage.js';
import {
  createTerminalPlugin,
  TERMINAL_END_SESSION_COMMAND,
  TERMINAL_PLUGIN_ID,
  TERMINAL_TOGGLE_COMMAND,
  TERMINAL_TOOL_ID,
  type TerminalPluginDeps,
} from './plugin.js';

type PanelComponent = ReturnType<TopicToolContribution['component']>;
type PanelInitContext = Parameters<PanelComponent['init']>[1];
type PanelRef = PanelInitContext['api'];

function makeMemoryStorage(): StorageService {
  const map = new Map<string, string>();
  return new StorageService('', {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  });
}

function makePanelContext(id = 'tool:terminal'): {
  readonly ctx: PanelInitContext;
  readonly close: ReturnType<typeof vi.fn>;
  readonly setVisibility: (visible: boolean) => void;
} {
  const visibility = new Emitter<boolean>();
  const dimensions = new Emitter<{ readonly width: number; readonly height: number }>();
  const close = vi.fn();
  const api: PanelRef = {
    id,
    group: 'panel',
    params: undefined,
    onDidVisibilityChange: visibility.event,
    onDidDimensionsChange: dimensions.event,
    setTitle: vi.fn(),
    setBadge: vi.fn(),
    focus: vi.fn(),
    close,
  };
  return {
    ctx: { id, api },
    close,
    setVisibility: (visible: boolean) => visibility.fire(visible),
  };
}

function makeHarness(
  depsOverrides: TerminalPluginDeps = {},
  initialTopics: TopicInfo[] = [
    { id: 't1', title: 'Alpha Topic', lastAt: 100 },
    { id: 't2', title: 'Beta Topic', lastAt: 200 },
  ],
) {
  let topics = [...initialTopics];
  let activeId: string | undefined = topics[0]?.id;
  const registry = new ContributionRegistry();
  const events = new WebuiEventBus();
  const storage = makeMemoryStorage();
  const post = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
  const confirmFn = vi.fn(() => true);
  const alertFn = vi.fn();

  const manager = new PluginManager({
    registry,
    events,
    topics: {
      list: () => topics,
      active: () => topics.find((t) => t.id === activeId),
      open: (id) => {
        activeId = id;
      },
      insertIntoComposer: vi.fn(),
    },
    api: createApiClient(),
    storage,
  });

  const plugin = createTerminalPlugin({
    boot: { terminal: true, terminalEnd: true },
    post,
    storage,
    confirmFn,
    alertFn,
    ...depsOverrides,
  });

  manager.register(plugin, { builtin: true });

  return {
    manager,
    registry,
    events,
    post,
    confirmFn,
    alertFn,
    setActiveTopic: (id: string | undefined) => {
      activeId = id;
      const topic = topics.find((t) => t.id === id);
      events.emit('topic.active', { id, topic });
    },
    setTopics: (next: TopicInfo[]) => {
      topics = [...next];
      events.emit('topic.list', { topics });
    },
  };
}

describe('features/terminal/plugin', () => {
  it('registers terminal topic tool in panel part and gates availability by boot.terminal and topic', async () => {
    const enabled = makeHarness({ boot: { terminal: true, terminalEnd: true } });
    expect(await enabled.manager.activate(TERMINAL_PLUGIN_ID)).toBe(true);

    const tool = enabled.registry.getTopicTool(TERMINAL_TOOL_ID);
    expect(tool).toBeDefined();
    expect(tool?.defaultPart).toBe('panel');
    expect(tool?.icon).toBe('terminal');
    expect(tool?.available({ id: 't1', title: 'Alpha', lastAt: 1 })).toBe(true);
    expect(tool?.available({ id: '   ', title: 'Blank', lastAt: 1 })).toBe(false);
    enabled.manager.dispose();

    const disabled = makeHarness({ boot: { terminal: false, terminalEnd: false } });
    expect(await disabled.manager.activate(TERMINAL_PLUGIN_ID)).toBe(true);
    const disabledTool = disabled.registry.getTopicTool(TERMINAL_TOOL_ID);
    expect(disabledTool?.available({ id: 't1', title: 'Alpha', lastAt: 1 })).toBe(false);
    expect(await disabled.registry.executeCommand(TERMINAL_TOGGLE_COMMAND)).toBe(false);
    disabled.manager.dispose();
  });

  it('switches per-topic ttyd iframes on topic change without destroying background sessions', async () => {
    const h = makeHarness();
    await h.manager.activate(TERMINAL_PLUGIN_ID);

    const tool = h.registry.getTopicTool(TERMINAL_TOOL_ID)!;
    const comp = tool.component();
    const panel = makePanelContext();
    comp.init(undefined, panel.ctx);

    const framesAfterT1 = comp.element.querySelectorAll('iframe');
    expect(framesAfterT1).toHaveLength(1);
    expect(framesAfterT1[0]?.getAttribute('src')).toBe('term/?arg=t1');
    expect(framesAfterT1[0]?.classList.contains('on')).toBe(true);
    expect(comp.element.querySelector('.term-name')?.textContent).toBe('Alpha Topic');

    h.setActiveTopic('t2');
    const framesAfterT2 = comp.element.querySelectorAll('iframe');
    expect(framesAfterT2).toHaveLength(2);
    expect(framesAfterT2[0]?.getAttribute('src')).toBe('term/?arg=t1');
    expect(framesAfterT2[0]?.classList.contains('on')).toBe(false);
    expect(framesAfterT2[0]?.hasAttribute('inert')).toBe(true);
    expect(framesAfterT2[1]?.getAttribute('src')).toBe('term/?arg=t2');
    expect(framesAfterT2[1]?.classList.contains('on')).toBe(true);
    expect(comp.element.querySelector('.term-name')?.textContent).toBe('Beta Topic');

    // Switching back reuses existing t1 iframe without recreating it.
    const t1Frame = framesAfterT2[0];
    h.setActiveTopic('t1');
    expect(comp.element.querySelectorAll('iframe')).toHaveLength(2);
    expect(t1Frame?.classList.contains('on')).toBe(true);

    // Pruning removed topics drops only deleted topic iframes.
    h.setTopics([{ id: 't1', title: 'Alpha Topic', lastAt: 100 }]);
    expect(comp.element.querySelectorAll('iframe')).toHaveLength(1);
    expect(comp.element.querySelector('iframe')?.getAttribute('src')).toBe('term/?arg=t1');

    comp.dispose();
    h.manager.dispose();
  });

  it('preserves running iframe across minimize and panel close, and cleans up on plugin dispose', async () => {
    const minimizePanel = vi.fn();
    const h = makeHarness({ minimizePanel });
    await h.manager.activate(TERMINAL_PLUGIN_ID);

    const tool = h.registry.getTopicTool(TERMINAL_TOOL_ID)!;
    const comp1 = tool.component();
    const panel1 = makePanelContext();
    comp1.init(undefined, panel1.ctx);

    const minBtn = comp1.element.querySelector<HTMLButtonElement>('.wb-term-min')!;
    expect(minBtn.querySelector('svg')).not.toBeNull();
    minBtn.click();
    expect(minimizePanel).toHaveBeenCalledTimes(1);
    expect(comp1.element.querySelectorAll('iframe')).toHaveLength(1);
    expect(comp1.element.querySelector('iframe')?.classList.contains('on')).toBe(false);

    // Disposing panel component and remounting preserves the same background iframe instance.
    const originalIframe = comp1.element.querySelector('iframe');
    comp1.dispose();

    const comp2 = tool.component();
    const panel2 = makePanelContext();
    comp2.init(undefined, panel2.ctx);
    expect(comp2.element.querySelector('iframe')).toBe(originalIframe);
    expect(originalIframe?.classList.contains('on')).toBe(true);

    panel2.setVisibility(false);
    expect(originalIframe?.classList.contains('on')).toBe(false);
    panel2.setVisibility(true);
    expect(originalIframe?.classList.contains('on')).toBe(true);

    // Deactivating the plugin removes contributions and tears down iframes.
    h.manager.deactivate(TERMINAL_PLUGIN_ID);
    expect(h.registry.getTopicTool(TERMINAL_TOOL_ID)).toBeUndefined();
    expect(comp2.element.querySelectorAll('iframe')).toHaveLength(0);
    h.manager.dispose();
  });

  it('registers terminal.toggle and terminal.endSession commands', async () => {
    const toggleTool = vi.fn(() => true);
    const h = makeHarness({ toggleTool });
    await h.manager.activate(TERMINAL_PLUGIN_ID);

    const tool = h.registry.getTopicTool(TERMINAL_TOOL_ID)!;
    const comp = tool.component();
    comp.init(undefined, makePanelContext().ctx);

    expect(await h.registry.executeCommand(TERMINAL_TOGGLE_COMMAND)).toBe(true);
    expect(toggleTool).toHaveBeenCalledWith('t1');

    const ended = await h.registry.executeCommand(TERMINAL_END_SESSION_COMMAND);
    expect(ended).toBe(true);
    expect(h.confirmFn).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith('api/terminal/end', { topic: 't1' }, 0);
    expect(comp.element.querySelectorAll('iframe')).toHaveLength(0);

    comp.dispose();
    h.manager.dispose();
  });
});
