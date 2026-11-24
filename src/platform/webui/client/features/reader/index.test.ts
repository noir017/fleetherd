// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import type { CodeViewApi } from '../../../codeview/app.js';
import { createCodeViewLoader, createLightbox, createReader, formatByteSize } from './index.js';

describe('features/reader', () => {
  it('formats byte sizes in KB and MB', () => {
    expect(formatByteSize(10)).toBe('1 KB');
    expect(formatByteSize(2048)).toBe('2 KB');
    expect(formatByteSize(1048576 * 2.5)).toBe('2.5 MB');
  });

  it('loads code view from injected seam or dynamic import and warns once on failure', async () => {
    const fakeApi = { editor: vi.fn() } as unknown as CodeViewApi;
    const winWithSeam = { __fhCodeView: fakeApi } as unknown as Window;
    const fromSeam = createCodeViewLoader('assets/codeview.js', { win: winWithSeam });
    expect(await fromSeam()).toBe(fakeApi);

    const noBundle = createCodeViewLoader(null, { win: {} as Window });
    expect(await noBundle()).toBeNull();

    const warn = vi.fn();
    const importModule = vi.fn(async () => {
      throw new Error('boom');
    });
    const failing = createCodeViewLoader('assets/codeview.js', {
      win: {} as Window,
      importModule,
      warn,
    });
    expect(await failing()).toBeNull();
    expect(await failing()).toBeNull();
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('opens and closes lightbox while clearing image src on close', () => {
    const lightbox = document.createElement('div');
    lightbox.hidden = true;
    const lightboxImg = document.createElement('img');
    const lb = createLightbox({ lightbox, lightboxImg });

    lb.open({ src: 'https://example.test/a.png', alt: 'preview' });
    expect(lb.isOpen()).toBe(true);
    expect(lightboxImg.getAttribute('src')).toBe('https://example.test/a.png');
    expect(lightboxImg.alt).toBe('preview');

    lightbox.click();
    expect(lb.isOpen()).toBe(false);
    expect(lightboxImg.hasAttribute('src')).toBe(false);
    lb.dispose();
  });

  it('renders markdown documents and mounts CodeMirror editor for text files with fallback', async () => {
    const reader = document.createElement('div');
    reader.hidden = true;
    const readerName = document.createElement('span');
    const readerGet = document.createElement('a');
    const readerBody = document.createElement('div');
    const readerClose = document.createElement('button');
    const codeBlocks = vi.fn();
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
            name: 'demo.ts',
            text: 'const x = 1;',
            html: '<pre>const x = 1;</pre>',
            shown: 1024,
            size: 2048,
          }),
        }) as Response,
    );

    const ctrl = createReader({
      reader,
      readerName,
      readerGet,
      readerBody,
      readerClose,
      codeView: async () => ({ editor: editorFn }) as unknown as CodeViewApi,
      codeBlocks,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const link = document.createElement('a');
    link.textContent = 'demo.ts';
    link.setAttribute('href', 'files/demo.ts');
    link.setAttribute('data-view', 'api/read/1');

    ctrl.open(link);
    expect(ctrl.isOpen()).toBe(true);
    expect(readerName.textContent).toBe('demo.ts');
    expect(readerGet.getAttribute('href')).toBe('files/demo.ts');

    await vi.waitFor(() => {
      expect(editorFn).toHaveBeenCalledTimes(1);
    });
    expect(readerBody.classList.contains('cv')).toBe(true);
    expect(readerBody.querySelector('.reader-note')).not.toBeNull();

    readerClose.click();
    expect(ctrl.isOpen()).toBe(false);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(readerBody.textContent).toBe('');
    ctrl.dispose();
  });
});
