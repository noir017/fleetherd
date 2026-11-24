// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import type { CodeViewApi } from '../../../codeview/app.js';
import { Emitter } from '../../base/event.js';
import type { EditorContribution } from '../../plugins/api.js';
import { PluginManager } from '../../plugins/host.js';
import { ContributionRegistry, WebuiEventBus } from '../../plugins/registry.js';
import { createApiClient } from '../../services/api.js';
import { OverlayManager } from '../../services/overlays.js';
import { StorageService } from '../../services/storage.js';
import {
  createReaderPlugin,
  READER_EDITOR_KIND,
  READER_OPEN_COMMAND,
  READER_OPEN_IMAGE_COMMAND,
  READER_PLUGIN_ID,
  type ReaderPluginDeps,
} from './plugin.js';

type PanelComponent = ReturnType<EditorContribution['component']>;
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

function makePanelContext(id = 'editor:reader:1'): {
  readonly ctx: PanelInitContext;
  readonly setTitle: ReturnType<typeof vi.fn>;
} {
  const visibility = new Emitter<boolean>();
  const dimensions = new Emitter<{ readonly width: number; readonly height: number }>();
  const setTitle = vi.fn();
  const api: PanelRef = {
    id,
    group: 'main',
    params: undefined,
    onDidVisibilityChange: visibility.event,
    onDidDimensionsChange: dimensions.event,
    setTitle,
    setBadge: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
  };
  return { ctx: { id, api }, setTitle };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHarness(depsOverrides: ReaderPluginDeps = {}) {
  const openEditor = vi.fn();
  const registry = new ContributionRegistry({ openEditor });
  const events = new WebuiEventBus();
  const overlays = new OverlayManager();
  const storage = makeMemoryStorage();

  const manager = new PluginManager({
    registry,
    events,
    topics: {
      list: () => [],
      active: () => undefined,
      open: vi.fn(),
      insertIntoComposer: vi.fn(),
    },
    api: createApiClient(),
    storage,
  });

  const plugin = createReaderPlugin({
    overlays,
    ...depsOverrides,
  });

  manager.register(plugin, { builtin: true });
  return { manager, registry, overlays, openEditor };
}

describe('features/reader/plugin', () => {
  it('registers reader editor, supports transcript link inputs, and renders HTML with partial byte notice', async () => {
    const codeBlocks = vi.fn();
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            name: 'notes.md',
            html: '<p>Hello reader</p>',
            shown: 1024,
            size: 4096,
          }),
        }) as Response,
    );

    const h = makeHarness({
      fetchFn: fetchFn as unknown as typeof fetch,
      codeBlocks,
    });
    expect(await h.manager.activate(READER_PLUGIN_ID)).toBe(true);

    const editor = h.registry.getEditor(READER_EDITOR_KIND);
    expect(editor).toBeDefined();

    const link = document.createElement('a');
    link.textContent = 'notes.md';
    link.setAttribute('href', 'files/notes.md');
    link.setAttribute('data-view', 'api/read/notes');

    expect(editor?.title(link)).toBe('notes.md');
    expect(await h.registry.executeCommand(READER_OPEN_COMMAND, link)).toBe(true);
    expect(h.openEditor).toHaveBeenCalledWith(
      READER_EDITOR_KIND,
      { viewUrl: 'api/read/notes', title: 'notes.md', downloadUrl: 'files/notes.md' },
      undefined,
    );

    const comp = editor!.component();
    const panel = makePanelContext();
    comp.init(link, panel.ctx);

    await vi.waitFor(() => {
      expect(comp.element.querySelector('.b')?.innerHTML).toBe('<p>Hello reader</p>');
    });
    expect(comp.element.querySelector('.reader-note')?.textContent).toContain('1 KB');
    expect(comp.element.querySelector('.reader-note')?.textContent).toContain('4 KB');
    expect(comp.element.querySelector<HTMLAnchorElement>('.wb-reader-download')?.getAttribute('href')).toBe(
      'files/notes.md',
    );
    expect(codeBlocks).toHaveBeenCalledTimes(1);

    comp.dispose();
    h.manager.dispose();
  });

  it('guards against out-of-order responses with readSeq and falls back to plain text when CodeMirror fails', async () => {
    const first = createDeferred<Response>();
    const second = createDeferred<Response>();
    let callCount = 0;
    const fetchFn = vi.fn(() => {
      callCount++;
      return callCount === 1 ? first.promise : second.promise;
    });
    const warn = vi.fn();
    const throwingEditor = vi.fn(() => {
      throw new Error('cm init failed');
    });

    const h = makeHarness({
      fetchFn: fetchFn as unknown as typeof fetch,
      codeView: async () => ({ editor: throwingEditor }) as unknown as CodeViewApi,
      warn,
    });
    await h.manager.activate(READER_PLUGIN_ID);

    const comp = h.registry.getEditor(READER_EDITOR_KIND)!.component();
    const panel = makePanelContext();
    comp.init({ viewUrl: 'api/read/old', title: 'old.ts' }, panel.ctx);
    comp.update?.({ viewUrl: 'api/read/new', title: 'new.ts' });

    // Resolve the second (newer) request first.
    second.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        name: 'new.ts',
        text: 'const answer = 42;',
        html: '<pre class="src">const answer = 42;</pre>',
        shown: 18,
        size: 18,
      }),
    } as Response);

    await vi.waitFor(() => {
      expect(comp.element.querySelector('.b')?.textContent).toContain('const answer = 42;');
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(comp.element.querySelector('.wb-reader-body')?.classList.contains('cv')).toBe(false);

    // Late resolution of the stale first request must be ignored.
    first.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        name: 'old.ts',
        html: '<p>STALE CONTENT</p>',
        shown: 10,
        size: 10,
      }),
    } as Response);
    await Promise.resolve();
    await Promise.resolve();
    expect(comp.element.textContent).not.toContain('STALE CONTENT');
    expect(comp.element.querySelector('.b')?.textContent).toContain('const answer = 42;');

    comp.dispose();
    h.manager.dispose();
  });

  it('destroys CodeMirror editor handle on dispose and ignores in-flight codeView after dispose', async () => {
    const cvDeferred = createDeferred<CodeViewApi | null>();
    const destroy = vi.fn();
    const editorFn = vi.fn(() => ({
      getDoc: () => '',
      setDoc: () => {},
      focus: () => {},
      destroy,
    }));

    const fetchFn = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            name: 'app.ts',
            text: 'export const ok = true;',
            html: '<pre>export const ok = true;</pre>',
            shown: 23,
            size: 23,
          }),
        }) as Response,
    );

    const h = makeHarness({
      fetchFn: fetchFn as unknown as typeof fetch,
      codeView: () => cvDeferred.promise,
    });
    await h.manager.activate(READER_PLUGIN_ID);

    const comp = h.registry.getEditor(READER_EDITOR_KIND)!.component();
    comp.init({ viewUrl: 'api/read/app', title: 'app.ts' }, makePanelContext().ctx);
    await vi.waitFor(() => {
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    // Dispose before codeView resolves: editor must never be mounted.
    comp.dispose();
    cvDeferred.resolve({ editor: editorFn } as unknown as CodeViewApi);
    await Promise.resolve();
    expect(editorFn).not.toHaveBeenCalled();

    // Now test normal mount followed by dispose cleanup.
    const comp2 = h.registry.getEditor(READER_EDITOR_KIND)!.component();
    comp2.init({ viewUrl: 'api/read/app', title: 'app.ts' }, makePanelContext('editor:reader:2').ctx);
    await vi.waitFor(() => {
      expect(editorFn).toHaveBeenCalledTimes(1);
    });
    comp2.dispose();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(comp2.element.querySelector('.wb-reader-body')?.textContent).toBe('');

    h.manager.dispose();
  });

  it('opens lightbox via reader.openImage, closes on OverlayManager Esc, releases img.src, and cleans up on dispose', async () => {
    const overlayHost = document.createElement('div');
    document.body.appendChild(overlayHost);
    const triggerBtn = document.createElement('button');
    document.body.appendChild(triggerBtn);
    const focusSpy = vi.spyOn(triggerBtn, 'focus');

    const h = makeHarness({ overlayHost });
    await h.manager.activate(READER_PLUGIN_ID);

    const opened = await h.registry.executeCommand(READER_OPEN_IMAGE_COMMAND, {
      src: 'https://example.test/diagram.png',
      alt: 'Architecture diagram',
      restoreFocus: triggerBtn,
    });
    expect(opened).toBe(true);

    const lightbox = overlayHost.querySelector<HTMLElement>('.wb-lightbox')!;
    const img = lightbox.querySelector<HTMLImageElement>('img')!;
    expect(lightbox.hidden).toBe(false);
    expect(img.getAttribute('src')).toBe('https://example.test/diagram.png');
    expect(img.alt).toBe('Architecture diagram');
    expect(h.overlays.size).toBe(1);

    // Esc closes lightbox via OverlayManager, clears img.src, and restores focus.
    expect(h.overlays.handleEscape()).toBe(true);
    expect(lightbox.hidden).toBe(true);
    expect(img.hasAttribute('src')).toBe(false);
    expect(h.overlays.size).toBe(0);
    expect(focusSpy).toHaveBeenCalledTimes(1);

    // Reopen and close by clicking backdrop: OverlayManager stack is also cleared.
    await h.registry.executeCommand(READER_OPEN_IMAGE_COMMAND, 'https://example.test/photo.jpg', 'Photo');
    expect(lightbox.hidden).toBe(false);
    expect(img.getAttribute('src')).toBe('https://example.test/photo.jpg');
    expect(h.overlays.size).toBe(1);

    lightbox.click();
    expect(lightbox.hidden).toBe(true);
    expect(img.hasAttribute('src')).toBe(false);
    expect(h.overlays.size).toBe(0);

    // Reopen and deactivate plugin: owned lightbox is closed, img.src cleared, and removed from DOM.
    await h.registry.executeCommand(READER_OPEN_IMAGE_COMMAND, {
      src: 'https://example.test/cleanup.png',
    });
    expect(h.overlays.size).toBe(1);

    h.manager.deactivate(READER_PLUGIN_ID);
    expect(h.registry.getEditor(READER_EDITOR_KIND)).toBeUndefined();
    expect(img.hasAttribute('src')).toBe(false);
    expect(h.overlays.size).toBe(0);
    expect(overlayHost.querySelector('.wb-lightbox')).toBeNull();

    h.manager.dispose();
    overlayHost.remove();
    triggerBtn.remove();
  });
});
