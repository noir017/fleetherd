import { describe, it, expect } from 'vitest';
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
  rowMenu,
  installCodeView,
  type Harness,
} from './page.dom.test-helpers.js';

describe('webui page: the file window', () => {
  const T = 'aaaaaaaa';
  const LIST = `api/files/list?topic=${T}`;
  const READ = `api/files/read?topic=${T}&path=${encodeURIComponent('/w/a.txt')}`;
  const rootEntry = { name: 'a.txt', dir: false };
  const listing = { ok: true, path: '/w', rel: '', entries: [rootEntry, { name: 'sub', dir: true }] };
  const SHA = 'a'.repeat(64);
  const file = {
    ok: true,
    path: '/w/a.txt',
    dir: '/w',
    rel: 'a.txt',
    name: 'a.txt',
    size: 3,
    mtimeMs: 5,
    kind: 'text',
    text: 'abc',
    eol: 'lf',
    sha256: SHA,
  };

  async function openFiles(over: Record<string, unknown> = {}) {
    const h = await open({
      files: true,
      url: `http://localhost:8787/?t=${T}`,
      replies: { [LIST]: listing, [READ]: file, ...over },
    });
    await h.click('#files-toggle');
    await until('the tree', () => h.el('files-tree-list').querySelectorAll('[data-fx-file]').length > 0);
    return h;
  }

  async function openA(h: Harness): Promise<void> {
    await h.click('[data-fx-file="/w/a.txt"]');
    await until('the editor', () => Boolean(h.el('files-editor').querySelector('textarea')));
  }

  const editorText = (h: Harness): HTMLTextAreaElement =>
    h.el('files-editor').querySelector('textarea') as HTMLTextAreaElement;

  it('hides the button and offers no openFileEditor when the daemon has the feature off', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${T}`, replies: { [LIST]: listing, [READ]: file } });
    expect(h.el('files-toggle').hidden).toBe(true);
    // Absent rather than inert: the git panel offers its Edit only where this is a function.
    expect(typeof (h.window as unknown as { openFileEditor?: unknown }).openFileEditor).toBe('undefined');
    await tick();
    expect(h.el('files').hidden).toBe(true);
    expect(h.calls.some((c) => c.path.startsWith('api/files/'))).toBe(false);
  });

  it('opens a file from the tree, edits it in the plain-text fallback and saves with its version', async () => {
    const h = await openFiles({ 'api/files/write': { ok: true, mtimeMs: 6, size: 4 } });
    expect(h.el('files-toggle').hidden).toBe(false);
    expect(typeof (h.window as unknown as { openFileEditor?: unknown }).openFileEditor).toBe('function');
    // From the header there is no file yet: on a phone the tree drawer starts open, so the window
    // is not an empty pane, and picking a file puts it away.
    expect(h.el('files').classList.contains('tree-open')).toBe(true);
    expect(h.el('files-title').textContent).toBe('Files');

    await openA(h);
    expect(h.el('files').classList.contains('tree-open')).toBe(false);
    expect(h.el('files-title').textContent).toBe('a.txt');
    expect(editorText(h).value).toBe('abc');
    // The fallback, not the code view: nothing put a CodeMirror node there.
    expect(h.el('files-editor').querySelector('.fake-cm')).toBeNull();
    expect(h.el('files-save').hasAttribute('disabled')).toBe(true);

    const ta = editorText(h);
    ta.value = 'abcd';
    ta.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect(h.el('files-dirty').hidden).toBe(false);
    expect(h.el('files-save').hasAttribute('disabled')).toBe(false);

    await h.click('#files-save');
    await until('the save', () => h.calls.some((c) => c.path === 'api/files/write'));
    const save = h.calls.find((c) => c.path === 'api/files/write')!;
    expect(save.body).toEqual({ topic: T, path: '/w/a.txt', text: 'abcd', mtimeMs: 5, size: 3, sha256: SHA });
    expect(h.el('files-dirty').hidden).toBe(true);
    expect(h.el('files-save').hasAttribute('disabled')).toBe(true);
  });

  it('saves from Ctrl+S as well as from the button', async () => {
    const h = await openFiles({ 'api/files/write': { ok: true, mtimeMs: 6, size: 5 } });
    await openA(h);
    const ta = editorText(h);
    ta.value = 'abcde';
    ta.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    ta.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await until('the keyed save', () => h.calls.some((c) => c.path === 'api/files/write'));
    expect(h.calls.find((c) => c.path === 'api/files/write')!.body.text).toBe('abcde');
  });

  it('uses the code view when it is there, and saves the document it holds', async () => {
    const h = await openFiles({ 'api/files/write': { ok: true, mtimeMs: 7, size: 6 } });
    type Fake = { type: (v: string) => void; save: () => void };
    let fake: Fake | null = null;
    (h.window as unknown as { __fhCodeView: unknown }).__fhCodeView = {
      editor(parent: HTMLElement, o: { doc: string; onChange?: (d: string) => void; onSave?: () => void }) {
        const el = h.doc.createElement('div');
        el.className = 'fake-cm';
        el.textContent = o.doc;
        parent.appendChild(el);
        const state = { doc: o.doc };
        fake = {
          type: (v: string) => {
            state.doc = v;
            el.textContent = v;
            o.onChange?.(v);
          },
          save: () => o.onSave?.(),
        };
        return { getDoc: () => state.doc, setDoc: (v: string) => (state.doc = v), focus: () => {}, destroy: () => {} };
      },
    };
    await h.click('[data-fx-file="/w/a.txt"]');
    await until('the code view', () => Boolean(h.el('files-editor').querySelector('.fake-cm')));
    expect(h.el('files-editor').querySelector('textarea')).toBeNull();

    (fake as Fake | null)!.type('abcdef');
    expect(h.el('files-dirty').hidden).toBe(false);
    (fake as Fake | null)!.save();
    await until('the save', () => h.calls.some((c) => c.path === 'api/files/write'));
    expect(h.calls.find((c) => c.path === 'api/files/write')!.body.text).toBe('abcdef');
  });

  it('offers reload, overwrite or cancel when the file changed under the editor', async () => {
    // One object, mutated between requests: the harness hands back whatever `replies` holds when
    // the answer is read, and replacement would leave the page's copy pointing at the old one.
    const writeReply: Record<string, unknown> = { ok: true, mtimeMs: 6, size: 4 };
    const h = await openFiles({ 'api/files/write': writeReply });
    await openA(h);
    const ta = editorText(h);
    ta.value = 'mine';
    ta.dispatchEvent(new h.window.Event('input', { bubbles: true }));

    h.status['api/files/write'] = 409;
    writeReply.ok = false;
    writeReply.conflict = true;
    writeReply.exists = true;
    writeReply.size = 9;
    writeReply.mtimeMs = 10;
    await h.click('#files-save');
    await until('the conflict dialog', () => !h.el('files-conflict').hidden);
    expect(h.el('files-conflict-text').textContent).toMatch(/changed on the machine/);
    // Nothing was thrown away: the editor still holds the typed text.
    expect(editorText(h).value).toBe('mine');

    // Overwrite is the same write with the check skipped.
    h.status['api/files/write'] = 200;
    writeReply.ok = true;
    writeReply.mtimeMs = 11;
    writeReply.size = 4;
    writeReply.conflict = false;
    await h.click('#files-overwrite');
    await until('the forced save', () => h.calls.filter((c) => c.path === 'api/files/write').length >= 2);
    const forced = h.calls.filter((c) => c.path === 'api/files/write')[1]!;
    expect(forced.body).toEqual({ topic: T, path: '/w/a.txt', text: 'mine', force: true });
    expect(h.el('files-conflict').hidden).toBe(true);
  });

  it('asks before a close or another file throws unsaved changes away', async () => {
    const h = await openFiles({ [READ.replace('/w/a.txt', '/w/a.txt')]: file });
    await openA(h);
    const ta = editorText(h);
    ta.value = 'unsaved';
    ta.dispatchEvent(new h.window.Event('input', { bubbles: true }));

    await h.click('#files-close');
    expect(h.confirms.at(-1)).toMatch(/Discard the unsaved changes/);
    // Answered yes (the harness's confirm does): the window is gone.
    expect(h.el('files').hidden).toBe(true);
  });

  it('keeps the window open when the unsaved confirmation is refused', async () => {
    const h = await open({
      files: true,
      confirm: false,
      url: `http://localhost:8787/?t=${T}`,
      replies: { [LIST]: listing, [READ]: file },
    });
    await h.click('#files-toggle');
    await until('the tree', () => h.el('files-tree-list').querySelectorAll('[data-fx-file]').length > 0);
    await openA(h);
    const ta = editorText(h);
    ta.value = 'unsaved';
    ta.dispatchEvent(new h.window.Event('input', { bubbles: true }));

    await h.click('#files-close');
    expect(h.el('files').hidden).toBe(false);
    expect(editorText(h).value).toBe('unsaved');
  });

  it('puts a BOM and CRLF back on save, and keeps a file that ends without a newline', async () => {
    const win = {
      ...file,
      path: '/w/win.txt',
      rel: 'win.txt',
      name: 'win.txt',
      size: 7,
      mtimeMs: 6,
      text: '\uFEFFa\r\nb',
      eol: 'crlf',
      bom: true,
      sha256: 'c'.repeat(64),
    };
    const h = await openFiles({
      [`api/files/read?topic=${T}&path=${encodeURIComponent('/w/win.txt')}`]: win,
      'api/files/write': { ok: true, mtimeMs: 9, size: 7, sha256: 'd'.repeat(64) },
    });
    (h.window as unknown as { openFileEditor: (p: string) => void }).openFileEditor('/w/win.txt');
    await until('the editor', () => Boolean(h.el('files-editor').querySelector('textarea')));
    // What the textarea shows: LF, with the BOM still the first character.
    expect(editorText(h).value).toBe('\uFEFFa\nb');

    editorText(h).dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await until('the save', () => h.calls.some((c) => c.path === 'api/files/write'));
    const body = h.calls.find((c) => c.path === 'api/files/write')!.body;
    expect(body.text).toBe('\uFEFFa\r\nb');
    expect(body.sha256).toBe('c'.repeat(64));
    expect(body.size).toBe(7);
    // The new version replaces the baseline, so the next save carries the hash just written.
    expect(h.el('files-dirty').hidden).toBe(true);
    // Uniform CRLF is byte-exact, so nothing is announced.
    expect(h.el('files-eol').hidden).toBe(true);
  });

  it('warns what a save will do to mixed line endings, and does it', async () => {
    const mixed = {
      ...file,
      path: '/w/mixed.txt',
      rel: 'mixed.txt',
      name: 'mixed.txt',
      size: 6,
      mtimeMs: 6,
      text: 'a\r\nb\n',
      eol: 'crlf',
      eolWarning: 'mixed',
      sha256: 'e'.repeat(64),
    };
    const h = await openFiles({
      [`api/files/read?topic=${T}&path=${encodeURIComponent('/w/mixed.txt')}`]: mixed,
      'api/files/write': { ok: true, mtimeMs: 9, size: 8, sha256: 'f'.repeat(64) },
    });
    (h.window as unknown as { openFileEditor: (p: string) => void }).openFileEditor('/w/mixed.txt');
    await until('the editor', () => Boolean(h.el('files-editor').querySelector('textarea')));
    expect(h.el('files-eol').hidden).toBe(false);
    expect(h.el('files-eol').textContent).toBe(
      'This file mixes line endings; saving will normalize them to CRLF.'
    );
    expect(editorText(h).value).toBe('a\nb\n');

    editorText(h).dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await until('the save', () => h.calls.some((c) => c.path === 'api/files/write'));
    expect(h.calls.find((c) => c.path === 'api/files/write')!.body.text).toBe('a\r\nb\r\n');
  });

  it('warns about a pure-CR file and saves it as LF', async () => {
    const classic = {
      ...file,
      path: '/w/classic.txt',
      rel: 'classic.txt',
      name: 'classic.txt',
      size: 4,
      mtimeMs: 6,
      text: 'a\rb\r',
      eol: 'lf',
      eolWarning: 'cr',
      sha256: 'e'.repeat(64),
    };
    const h = await openFiles({
      [`api/files/read?topic=${T}&path=${encodeURIComponent('/w/classic.txt')}`]: classic,
      'api/files/write': { ok: true, mtimeMs: 9, size: 4, sha256: 'f'.repeat(64) },
    });
    (h.window as unknown as { openFileEditor: (p: string) => void }).openFileEditor('/w/classic.txt');
    await until('the editor', () => Boolean(h.el('files-editor').querySelector('textarea')));
    expect(h.el('files-eol').textContent).toBe('This file uses CR line endings; saving will normalize them to LF.');
    expect(editorText(h).value).toBe('a\nb\n');

    editorText(h).dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await until('the save', () => h.calls.some((c) => c.path === 'api/files/write'));
    expect(h.calls.find((c) => c.path === 'api/files/write')!.body.text).toBe('a\nb\n');
  });

  it('moves the new-file directory up when the folder it named is deleted', async () => {
    const h = await openFiles({
      [`api/files/list?topic=${T}&path=${encodeURIComponent('/w/sub')}`]: {
        ok: true,
        path: '/w/sub',
        rel: 'sub',
        entries: [],
      },
      'api/files/remove': { ok: true, removed: true },
      'api/files/create': { ok: true, path: '/w/x.txt', dir: false },
    });
    // Opening the folder is what puts the tree's cursor on it.
    await h.click('[data-fx-dir="/w/sub"]');
    await h.click('[data-fx-dir-delete="/w/sub"]');
    await until('the delete', () => h.calls.some((c) => c.path === 'api/files/remove'));

    await h.click('#files-new-file');
    (h.el('files-new-name') as HTMLInputElement).value = 'x.txt';
    await h.click('#files-new-go');
    await until('the create', () => h.calls.some((c) => c.path === 'api/files/create'));
    expect(h.calls.find((c) => c.path === 'api/files/create')!.body).toEqual({
      topic: T,
      path: '/w/x.txt',
      dir: false,
    });
  });

  it('keeps unsaved text across a successful rename instead of re-reading the file', async () => {
    const h = await openFiles({ 'api/files/rename': { ok: true, path: '/w/b.txt' } });
    await openA(h);
    const ta = editorText(h);
    ta.value = 'draft';
    ta.dispatchEvent(new h.window.Event('input', { bubbles: true }));

    await h.click('#files-rename-open');
    (h.el('files-rename-name') as HTMLInputElement).value = 'b.txt';
    await h.click('#files-rename-go');
    await until('the rename', () => h.el('files-title').textContent === 'b.txt');

    expect(editorText(h).value).toBe('draft');
    expect(h.el('files-dirty').hidden).toBe(false);
    // No read of the new path: the editor's text is the person's, and the disk copy is older.
    expect(h.calls.some((c) => c.path === `api/files/read?topic=${T}&path=${encodeURIComponent('/w/b.txt')}`)).toBe(false);

    await h.click('#files-save');
    await until('the save after rename', () => h.calls.some((c) => c.path === 'api/files/write'));
    expect(h.calls.find((c) => c.path === 'api/files/write')!.body).toMatchObject({ path: '/w/b.txt', text: 'draft' });
  });

  it('keeps the dirty mark when a rename fails', async () => {
    const h = await openFiles({ 'api/files/rename': { ok: false, error: 'something is already there' } });
    h.status['api/files/rename'] = 400;
    await openA(h);
    const ta = editorText(h);
    ta.value = 'draft';
    ta.dispatchEvent(new h.window.Event('input', { bubbles: true }));

    await h.click('#files-rename-open');
    (h.el('files-rename-name') as HTMLInputElement).value = 'b.txt';
    await h.click('#files-rename-go');
    await until('the refusal', () => h.el('files-note').textContent!.includes('already there'));

    expect(h.el('files-title').textContent).toBe('a.txt');
    expect(editorText(h).value).toBe('draft');
    expect(h.el('files-dirty').hidden).toBe(false);
  });

  it('keeps the dirty mark when a conflict Reload fails, so a close still asks', async () => {
    const writeReply: Record<string, unknown> = { ok: true, mtimeMs: 6, size: 4 };
    const h = await openFiles({ 'api/files/write': writeReply });
    await openA(h);
    const ta = editorText(h);
    ta.value = 'mine';
    ta.dispatchEvent(new h.window.Event('input', { bubbles: true }));

    h.status['api/files/write'] = 409;
    writeReply.ok = false;
    writeReply.conflict = true;
    writeReply.exists = true;
    await h.click('#files-save');
    await until('the conflict dialog', () => !h.el('files-conflict').hidden);

    h.status[READ] = 404;
    await h.click('#files-reload');
    await until('the failed reload', () => !h.el('files-note').hidden);
    expect(editorText(h).value).toBe('mine');
    expect(h.el('files-dirty').hidden).toBe(false);

    await h.click('#files-close');
    expect(h.confirms.at(-1)).toMatch(/Discard the unsaved changes/);
  });

  it('renames a folder from its row, and says what it is renaming', async () => {
    const h = await openFiles({ 'api/files/rename': { ok: true, path: '/w/renamed' } });
    await h.click('[data-fx-dir-rename="/w/sub"]');
    expect(h.el('files-rename-what').textContent).toBe('Rename folder');
    expect((h.el('files-rename-name') as HTMLInputElement).value).toBe('sub');

    (h.el('files-rename-name') as HTMLInputElement).value = 'renamed';
    await h.click('#files-rename-go');
    await until('the rename', () => h.calls.some((c) => c.path === 'api/files/rename'));
    expect(h.calls.find((c) => c.path === 'api/files/rename')!.body).toEqual({
      topic: T,
      from: '/w/sub',
      to: '/w/renamed',
    });
    expect(h.confirms.at(-1)).toMatch(/Rename "sub" to "renamed"/);
    await until('the note', () => h.el('files-note').textContent === 'Renamed.');
  });

  it('deletes an empty folder only after a confirmation that says so', async () => {
    const h = await openFiles({ 'api/files/remove': { ok: true, removed: true } });
    await h.click('[data-fx-dir-delete="/w/sub"]');
    expect(h.confirms.at(-1)).toMatch(/Only an empty folder can be deleted/);
    await until('the delete', () => h.calls.some((c) => c.path === 'api/files/remove'));
    expect(h.calls.find((c) => c.path === 'api/files/remove')!.body).toEqual({ topic: T, path: '/w/sub' });
    await until('the note', () => h.el('files-note').textContent === 'Deleted.');
  });

  it('shows the not-empty refusal when a folder with something in it is deleted', async () => {
    const h = await openFiles({ 'api/files/remove': { ok: false, error: 'That folder is not empty. Delete its contents first.' } });
    h.status['api/files/remove'] = 400;
    await h.click('[data-fx-dir-delete="/w/sub"]');
    await until('the refusal', () => h.el('files-note').textContent!.includes('not empty'));
    expect(h.el('files-note').textContent).toBe('That folder is not empty. Delete its contents first.');
  });

  it('asks before deleting the folder the open file lives in, and posts nothing if refused', async () => {
    const inside = {
      ...file,
      path: '/w/sub/a.txt',
      dir: '/w/sub',
      rel: 'sub/a.txt',
      name: 'a.txt',
    };
    const h = await open({
      files: true,
      confirm: false,
      url: `http://localhost:8787/?t=${T}`,
      replies: {
        [LIST]: listing,
        [`api/files/read?topic=${T}&path=${encodeURIComponent('/w/sub/a.txt')}`]: inside,
      },
    });
    await h.click('#files-toggle');
    await until('the tree', () => h.el('files-tree-list').querySelectorAll('[data-fx-dir]').length > 0);
    (h.window as unknown as { openFileEditor: (p: string) => void }).openFileEditor('/w/sub/a.txt');
    await until('the editor', () => Boolean(h.el('files-editor').querySelector('textarea')));
    const ta = editorText(h);
    ta.value = 'unsaved';
    ta.dispatchEvent(new h.window.Event('input', { bubbles: true }));

    await h.click('[data-fx-dir-delete="/w/sub"]');
    // The unsaved question came first and was answered no: nothing was sent.
    expect(h.confirms.at(-1)).toMatch(/Discard the unsaved changes/);
    expect(h.calls.some((c) => c.path === 'api/files/remove')).toBe(false);
    expect(editorText(h).value).toBe('unsaved');
  });

  it('opens a file named by another panel (window.openFileEditor) and shows a Markdown preview', async () => {
    const h = await open({
      files: true,
      url: `http://localhost:8787/?t=${T}`,
      replies: {
        [LIST]: listing,
        [READ]: file,
        [`api/files/read?topic=${T}&path=${encodeURIComponent('/w/notes.md')}&preview=1`]: {
          ...file,
          path: '/w/notes.md',
          rel: 'notes.md',
          name: 'notes.md',
          html: '<h1>Hi</h1>',
        },
        [`api/files/read?topic=${T}&path=${encodeURIComponent('/w/notes.md')}`]: {
          ...file,
          path: '/w/notes.md',
          rel: 'notes.md',
          name: 'notes.md',
          text: '# Hi\n',
        },
      },
    });
    (h.window as unknown as { openFileEditor: (p: string) => void }).openFileEditor('/w/notes.md');
    expect(h.el('files').classList.contains('tree-open')).toBe(false);
    await until('the file from another panel', () => h.el('files-title').textContent === 'notes.md');
    expect(h.el('files').hidden).toBe(false);

    await h.click('#files-preview-toggle');
    await until('the preview', () => h.el('files-preview').querySelector('h1') !== null);
    expect(h.el('files-editor').hidden).toBe(true);
    expect(h.el('files-preview-toggle').textContent).toBe('Edit');

    await h.click('#files-preview-toggle');
    expect(h.el('files-preview').hidden).toBe(true);
    expect(h.el('files-editor').hidden).toBe(false);
  });
});

describe('webui page: the git window', () => {
  const A = 'a1b2c3d4';
  const statusPath = (mode: string, base = ''): string =>
    `api/git/status?t=${A}&mode=${mode}${base ? `&base=${encodeURIComponent(base)}` : ''}`;
  const filePath = (mode: string, file: string, base = ''): string =>
    `api/git/file?t=${A}&mode=${mode}${base ? `&base=${encodeURIComponent(base)}` : ''}&path=${encodeURIComponent(file)}`;

  /** A complete change list, and one file that both sides of the diff can read. */
  const replies = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    [`api/git/branches?t=${A}`]: { ok: true, branch: 'main', base: 'main', branches: ['main', 'origin/main'] },
    [statusPath('working')]: {
      ok: true,
      repo: { root: '/srv/project', branch: 'main', base: 'main' },
      files: [
        { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
        { path: 'new.txt', status: 'added', additions: 2, deletions: 0 },
      ],
    },
    [statusPath('branch', 'main')]: {
      ok: true,
      repo: { root: '/srv/project', branch: 'main', base: 'main' },
      files: [{ path: 'src/a.ts', status: 'modified', additions: 4, deletions: 1 }],
    },
    [filePath('working', 'src/a.ts')]: {
      ok: true,
      path: 'src/a.ts',
      status: 'modified',
      original: 'one\ntwo\n',
      modified: 'one\nTWO\nthree\n',
      patch: '@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+three\n',
    },
    [filePath('working', 'new.txt')]: {
      ok: true,
      path: 'new.txt',
      status: 'added',
      original: '',
      modified: 'new\nlines\n',
      patch: '@@ -0,0 +1,2 @@\n+new\n+lines\n',
    },
    ...extra,
  });

  async function openWindow(h: Harness): Promise<void> {
    await h.emit(sync(A, [message('m1', '<p>work</p>')], [A]));
    await h.click('#git-toggle');
    await until('the change list', () => h.el('git-files').querySelectorAll('.git-file').length > 0);
  }

  it('opens from the chat header with the change list, and switches comparison from the bar', async () => {
    const h = await open({ replies: replies() });
    await openWindow(h);

    expect(h.el('git').hidden).toBe(false);
    expect(h.el('git-title').textContent).toBe('Changes');
    expect(h.el('git-branch').textContent).toBe('main');
    expect(h.el('git-modes').hidden).toBe(false);
    expect(h.el('git-base').hidden).toBe(true);
    const rows = Array.from(h.el('git-files').querySelectorAll('.git-file'));
    expect(rows.map((r) => [r.querySelector('.gf-path')?.textContent, r.querySelector('.gf-status')?.textContent])).toEqual([
      ['src/a.ts', 'M'],
      ['new.txt', 'A'],
    ]);
    expect(rows[0]?.querySelector('.gf-stat')?.textContent).toContain('+3');

    await h.click('[data-gm="branch"]');
    await until('the branch comparison', () => h.calls.some((c) => c.path === statusPath('branch', 'main')));
    expect(Array.from(h.el('git-modes').querySelectorAll('.git-mode.on')).map((b) => b.getAttribute('data-gm'))).toEqual([
      'branch',
    ]);
    // The base picker appears with the branches the daemon named, and the answer's base is chosen.
    await until('the base picker', () => !h.el('git-base').hidden);
    expect(Array.from(h.el('git-base').querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'main',
      'origin/main',
    ]);
    expect((h.el('git-base') as HTMLSelectElement).value).toBe('main');
  });

  it('draws a file through codeView, and falls back to the coloured patch when it is not there', async () => {
    const h = await open({ replies: replies() });
    const diffs = installCodeView(h);
    await openWindow(h);

    // The first row opens by itself on a wide window; the second row is the click below.
    await until('the code view', () => diffs.length === 1);
    const first = diffs[0]!;
    expect(first.options.name).toBe('src/a.ts');
    expect(first.options.original).toBe('one\ntwo\n');
    expect(first.options.modified).toBe('one\nTWO\nthree\n');
    // A desktop page opens the two-column diff, and the button offers the other way.
    expect(first.options.layout).toBe('split');
    expect(h.el('git-layout').hidden).toBe(false);
    expect(h.el('git-layout').textContent).toBe('Unified');

    await h.click('#git-layout');
    expect(first.layouts).toEqual(['unified']);
    expect(h.el('git-layout').textContent).toBe('Split');

    // No code view on this page: the same read, as a plain patch with + and − coloured. There is
    // no selection there, so the comment affordance must stay hidden.
    delete (h.window as any).__fhCodeView;
    await h.click('[data-gpath="new.txt"]');
    await until('the plain patch', () => Boolean(h.el('git-diff').querySelector('.git-patch')));
    expect(first.destroyed).toBe(1);
    expect(h.el('git-diff').querySelectorAll('.git-patch .pa').length).toBeGreaterThanOrEqual(2);
    expect(h.el('git-layout').hidden).toBe(true);
    // No code view means no selection, so the comment affordance stays hidden.
    expect(h.el('git-sel').hidden).toBe(true);
  });

  it('turns a selected range into a line comment in the composer, and never sends it', async () => {
    const h = await open({ replies: replies() });
    const diffs = installCodeView(h);
    await openWindow(h);
    await until('the code view', () => diffs.length === 1);

    // A drag covers part of each line; the comment still quotes lines 2-3 of the new side whole.
    diffs[0]!.options.onSelect?.({ side: 'new', from: 2, to: 3, text: 'WO\nthr' });
    await tick();
    expect(h.el('git-sel').hidden).toBe(false);
    expect(h.el('git-sel-what').textContent).toBe('New lines 2\u20133');

    await h.click('#git-comment-open');
    expect(h.el('git-comment').hidden).toBe(false);
    expect(h.el('git-comment-what').textContent).toBe('src/a.ts:L2-L3 \u00b7 new side');
    (h.el('git-comment-text') as HTMLTextAreaElement).value = 'Looks good';
    await h.click('#git-comment-add');

    expect((h.el('input') as HTMLTextAreaElement).value).toBe(
      ['src/a.ts:L2-L3 (new)', '```', 'TWO', 'three', '```', 'Looks good'].join('\n')
    );
    expect(h.el('git-comment').hidden).toBe(true);
    expect(h.el('git-note').textContent).toContain('Added to the message');
    // Inserting is all it does: nothing has been sent to the daemon.
    expect(h.calls.some((c) => c.path === 'api/send')).toBe(false);
  });

  it('re-reads the change list when the topic turn ends, but leaves the open diff alone', async () => {
    const h = await open({ replies: replies() });
    const diffs = installCodeView(h);
    await openWindow(h);
    await until('the code view', () => diffs.length === 1);
    const before = h.calls.filter((c) => c.path === statusPath('working')).length;

    await h.emit({ t: 'typing', on: false });
    await until('a refreshed list', () => h.calls.filter((c) => c.path === statusPath('working')).length === before + 1);
    expect(diffs[0]?.destroyed).toBe(0);
  });

  it('opens a fixed pair of URLs for the turn-change view, with no comparison controls', async () => {
    const h = await open({
      replies: {
        'api/git/status?t=turn1&mode=working': {
          ok: true,
          repo: { root: '/srv/project', branch: 'feature' },
          files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }],
        },
        'api/git/file?t=turn1&mode=working&path=src%2Fa.ts': {
          ok: true,
          path: 'src/a.ts',
          status: 'modified',
          original: 'one\n',
          modified: 'two\n',
          patch: '@@ -1 +1 @@\n-one\n+two\n',
        },
      },
    });
    await h.emit(sync(A, [message('m1', '<p>work</p>')], [A]));
    (h.window as any).openGitWindow({
      title: 'Changes this turn',
      statusUrl: 'api/git/status?t=turn1&mode=working',
      fileUrl: 'api/git/file?t=turn1&mode=working',
    });
    await until('the fixed list', () => h.el('git-files').querySelectorAll('.git-file').length === 1);

    expect(h.el('git-title').textContent).toBe('Changes this turn');
    expect(h.el('git-modes').hidden).toBe(true);
    expect(h.el('git-base').hidden).toBe(true);
    // Nothing opens by itself here, and the history is not offered: the view is one turn's files.
    expect(h.el('git-diff').textContent).toContain('Select a file');
    expect(h.calls.some((c) => c.path.startsWith('api/git/log'))).toBe(false);
    expect(h.calls.some((c) => c.path.startsWith('api/git/commit'))).toBe(false);

    await h.click('[data-gpath="src/a.ts"]');
    await until('the fixed diff', () => h.calls.some((c) => c.path === 'api/git/file?t=turn1&mode=working&path=src%2Fa.ts'));
    await until('the plain patch', () => Boolean(h.el('git-diff').querySelector('.git-patch')));
    expect(h.el('git-diff').textContent).toContain('+two');
  });

  it('closes on Escape, its button and the backdrop', async () => {
    const h = await open({ replies: replies() });
    await openWindow(h);

    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();
    expect(h.el('git').hidden).toBe(true);

    await h.click('#git-toggle');
    await until('the list again', () => h.el('git-files').querySelectorAll('.git-file').length > 0);
    await h.click('#git-close');
    expect(h.el('git').hidden).toBe(true);

    await h.click('#git-toggle');
    await until('the list a third time', () => h.el('git-files').querySelectorAll('.git-file').length > 0);
    h.el('git').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    expect(h.el('git').hidden).toBe(true);
  });

  it('hands the editor an absolute path, and a key on Edit stays with Edit', async () => {
    const h = await open({ replies: replies() });
    const edited: string[] = [];
    (h.window as any).openFileEditor = (p: string) => edited.push(p);
    await openWindow(h);

    const edit = h.el('git-files').querySelector('.gf-edit') as HTMLElement;
    expect(edit.getAttribute('data-gedit')).toBe('/srv/project/src/a.ts');
    // A wide window opens the first row by itself, so the count is taken as it stands: what the
    // click must not do is add another read of that file.
    const reads = h.calls.filter((c) => c.path === filePath('working', 'src/a.ts')).length;
    await h.click('.gf-edit');
    expect(edited).toEqual(['/srv/project/src/a.ts']);
    // The click on Edit must not also open the row's diff.
    expect(h.calls.filter((c) => c.path === filePath('working', 'src/a.ts')).length).toBe(reads);

    // Enter on the button is the button's press, not the row's "open the diff".
    edit.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    expect(h.calls.filter((c) => c.path === filePath('working', 'src/a.ts')).length).toBe(reads);
  });

  it('opens the file window on the file when the daemon has files on, and offers no Edit when off', async () => {
    const read = `api/files/read?topic=${A}&path=${encodeURIComponent('/srv/project/src/a.ts')}`;
    const h = await open({
      files: true,
      replies: replies({
        [`api/files/list?topic=${A}&path=${encodeURIComponent('/srv/project/src')}`]: {
          ok: true,
          path: '/srv/project/src',
          rel: 'src',
          entries: [{ name: 'a.ts', dir: false }],
        },
        [read]: {
          ok: true,
          path: '/srv/project/src/a.ts',
          dir: '/srv/project/src',
          rel: 'src/a.ts',
          name: 'a.ts',
          size: 4,
          mtimeMs: 1,
          kind: 'text',
          text: 'one\n',
          eol: 'lf',
          sha256: 'a'.repeat(64),
        },
      }),
    });
    await openWindow(h);
    await h.click('.gf-edit');
    await until('the file read', () => h.calls.some((c) => c.path === read));
    expect(h.el('files').hidden).toBe(false);

    // The same list on a daemon with the file window off: no control that would do nothing.
    const off = await open({ replies: replies() });
    await openWindow(off);
    expect(off.el('git-files').querySelector('.gf-edit')).toBeNull();
  });

  it('drops a file answer that arrives after the comparison changed', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = await open({
      replies: replies(),
      held: { [filePath('working', 'src/a.ts')]: gate },
    });
    const diffs = installCodeView(h);
    await openWindow(h);
    await h.click('[data-gpath="src/a.ts"]');
    await within('the file request', 1000, () => h.calls.some((c) => c.path === filePath('working', 'src/a.ts')));

    await h.click('[data-gm="branch"]');
    await until('the branch answer', () => h.calls.some((c) => c.path === statusPath('branch', 'main')));
    release();
    await tick();
    await tick();

    // The old file's answer belongs to the comparison that was left: no diff, and no selection
    // that a comment could be written against with an empty path.
    expect(diffs).toHaveLength(0);
    expect(h.el('git-diff').textContent).not.toContain('TWO');
    expect(h.el('git-sel').hidden).toBe(true);
  });

  it('closes when another topic is opened', async () => {
    const B = 'b2c3d4e5';
    const h = await open({ replies: replies() });
    await h.emit(sync(A, [], [A, B]));
    await h.click('#git-toggle');
    await until('the list', () => h.el('git-files').querySelectorAll('.git-file').length > 0);

    await h.click(`[data-topic="${B}"]`);
    expect(h.el('git').hidden).toBe(true);
  });

  it('re-reads the comparison when the base branch changes', async () => {
    const h = await open({
      replies: replies({
        [`api/git/branches?t=${A}`]: { ok: true, branch: 'main', base: 'main', branches: ['main', 'dev'] },
        [statusPath('branch', 'dev')]: {
          ok: true,
          repo: { root: '/srv/project', branch: 'main', base: 'dev' },
          files: [],
        },
      }),
    });
    await openWindow(h);
    await h.click('[data-gm="branch"]');
    await until('the default base', () => h.calls.some((c) => c.path === statusPath('branch', 'main')));
    await until('the picker', () => !h.el('git-base').hidden);

    const picker = h.el('git-base') as HTMLSelectElement;
    picker.value = 'dev';
    picker.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await until('the new base', () => h.calls.some((c) => c.path === statusPath('branch', 'dev')));
  });

  it('picks the first branch as the base when the repository names no default', async () => {
    const h = await open({
      replies: replies({
        [`api/git/branches?t=${A}`]: { ok: true, branch: 'feature', branches: ['feature', 'topic'] },
        [statusPath('branch', 'feature')]: {
          ok: true,
          repo: { root: '/srv/project', branch: 'feature', base: 'feature' },
          files: [],
        },
      }),
    });
    await openWindow(h);
    await h.click('[data-gm="branch"]');
    await until('the first branch as base', () => h.calls.some((c) => c.path === statusPath('branch', 'feature')));
    expect((h.el('git-base') as HTMLSelectElement).value).toBe('feature');
  });

  it('shows the daemon sentence for a failed read, not "no changes"', async () => {
    const h = await open({
      replies: {
        [statusPath('working')]: { ok: false, reason: 'error', text: 'git status failed: index file corrupt' },
      },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#git-toggle');
    await until('the failure', () => h.el('git-note').textContent!.includes('index file corrupt'));
    expect(h.el('git-files').textContent).not.toContain('No changes');
  });

  it('shows why the base picker has no branches, and keeps saying it under the list', async () => {
    const h = await open({
      replies: replies({ [`api/git/branches?t=${A}`]: { ok: false, text: 'too many branches to list' } }),
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#git-toggle');
    await until('the branch failure', () => h.el('git-note').textContent!.includes('too many branches'));
    // The status answer came after it and still did not wipe the sentence.
    expect(h.el('git-files').querySelectorAll('.git-file').length).toBeGreaterThan(0);
  });

  it('draws the rows it did get when the list itself is incomplete', async () => {
    const h = await open({
      replies: {
        [statusPath('working')]: {
          ok: true,
          repo: { root: '/srv/project', branch: 'main', base: 'main' },
          files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }],
          truncated: true,
        },
        [filePath('working', 'src/a.ts')]: {
          ok: true,
          path: 'src/a.ts',
          status: 'modified',
          original: 'one\n',
          modified: 'two\n',
          patch: '@@ -1 +1 @@\n-one\n+two\n',
        },
      },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#git-toggle');
    await until('the partial list', () => h.el('git-files').querySelectorAll('.git-file').length === 1);
    expect(h.el('git-note').textContent).toContain('too many changes');
    expect(h.el('git-files').textContent).toContain('src/a.ts');
    // A row that was drawn from an incomplete list is still a real row: the first one opened by
    // itself, and a click on it re-reads the file — how a diff is refreshed after an Edit.
    await until('the first read', () => h.calls.some((c) => c.path === filePath('working', 'src/a.ts')));
    await until('the plain patch', () => Boolean(h.el('git-diff').querySelector('.git-patch')));
    const reads = h.calls.filter((c) => c.path === filePath('working', 'src/a.ts')).length;
    await h.click('[data-gpath="src/a.ts"]');
    await until('the second read', () =>
      h.calls.filter((c) => c.path === filePath('working', 'src/a.ts')).length === reads + 1
    );
  });

  it('drops a file answer when a failed refresh cleared the open file', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = await open({ replies: replies(), held: { [filePath('working', 'src/a.ts')]: gate } });
    const diffs = installCodeView(h);
    await openWindow(h);
    await h.click('[data-gpath="src/a.ts"]');
    await within('the file request', 1000, () => h.calls.some((c) => c.path === filePath('working', 'src/a.ts')));

    // The refresh fails after the path has been cleared; the file answer must not land in the
    // empty pane and hand a comment an empty file name.
    h.status[statusPath('working')] = 500;
    await h.emit({ t: 'typing', on: false });
    await until('the failure', () => h.el('git-note').textContent!.includes('Could not read the changes'));
    release();
    await tick();
    await tick();

    expect(diffs).toHaveLength(0);
    expect(h.el('git-diff').textContent).toBe('');
  });

  it('drops a file answer when the file has left the change list', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    const list = {
      ok: true,
      repo: { root: '/srv/project', branch: 'main', base: 'main' },
      files: [
        { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
        { path: 'new.txt', status: 'added', additions: 2, deletions: 0 },
      ],
    };
    const h = await open({
      replies: { ...replies(), [statusPath('working')]: list },
      held: { [filePath('working', 'src/a.ts')]: gate },
    });
    const diffs = installCodeView(h);
    await openWindow(h);
    await h.click('[data-gpath="src/a.ts"]');
    await within('the file request', 1000, () => h.calls.some((c) => c.path === filePath('working', 'src/a.ts')));

    list.files = [list.files[1]!];
    await h.emit({ t: 'typing', on: false });
    await until('the notice', () => h.el('git-diff').textContent!.includes('no longer in the changes'));
    release();
    await tick();
    await tick();

    expect(diffs).toHaveLength(0);
    expect(h.el('git-sel').hidden).toBe(true);
  });

  it('names a too-large file and a too-large diff differently', async () => {
    const big = (patchTooLarge: boolean) => ({
      ok: true,
      path: 'src/a.ts',
      status: 'modified',
      original: '',
      modified: '',
      patch: '',
      tooLarge: true,
      ...(patchTooLarge ? { patchTooLarge: true } : {}),
    });
    const h = await open({
      replies: replies({
        [filePath('working', 'src/a.ts')]: big(false),
        [filePath('working', 'new.txt')]: { ...big(true), path: 'new.txt' },
        [statusPath('working')]: {
          ok: true,
          repo: { root: '/srv/project', branch: 'main', base: 'main' },
          files: [
            { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 },
            { path: 'new.txt', status: 'added', additions: 2, deletions: 0 },
          ],
        },
      }),
    });
    await openWindow(h);

    // src/a.ts is the first row, so the window opened it by itself.
    await until('the file notice', () => h.el('git-diff').textContent === 'This file is too large to show.');
    await h.click('[data-gpath="new.txt"]');
    await until('the diff notice', () => h.el('git-diff').textContent === "This file's diff is too large to show.");
  });

  it('says the counts were not read instead of drawing +0 −0', async () => {
    const h = await open({
      replies: {
        [statusPath('working')]: {
          ok: true,
          repo: { root: '/srv/project', branch: 'main', base: 'main' },
          files: [{ path: 'many/a.txt', status: 'added', additions: 0, deletions: 0, statsUnknown: true }],
        },
      },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#git-toggle');
    await until('the row', () => h.el('git-files').querySelectorAll('.git-file').length === 1);

    expect(h.el('git-files').textContent).toContain('counts not read');
    expect(h.el('git-files').textContent).not.toContain('+0');
  });

  it('writes which side of the diff a comment is on', async () => {
    const h = await open({ replies: replies() });
    const diffs = installCodeView(h);
    await openWindow(h);
    await until('the code view', () => diffs.length === 1);

    diffs[0]!.options.onSelect?.({ side: 'old', from: 2, to: 2, text: 'tw' });
    await tick();
    await h.click('#git-comment-open');
    expect(h.el('git-comment-what').textContent).toContain('old side');
    (h.el('git-comment-text') as HTMLTextAreaElement).value = 'Removed on purpose';
    await h.click('#git-comment-add');
    expect((h.el('input') as HTMLTextAreaElement).value).toBe(
      ['src/a.ts:L2 (old)', '```', 'two', '```', 'Removed on purpose'].join('\n')
    );
  });

  it('says in the middle of the pane that the directory is not a repository', async () => {
    const h = await open({
      replies: {
        [`api/git/branches?t=${A}`]: { ok: false, reason: 'not-git', text: 'not a git repository' },
        [statusPath('working')]: { ok: false, reason: 'not-git', text: '/srv/work is not inside a git repository.' },
      },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#git-toggle');
    await until('the sentence', () => Boolean(h.el('git-diff').querySelector('.git-blank')));

    expect(h.el('git-diff').textContent).toContain('/srv/work is not inside a git repository.');
    // An answer, not a failed request: no red note, and no list of rows that do not exist.
    expect(h.el('git-note').hidden).toBe(true);
    expect(h.el('git-files').querySelectorAll('.git-file').length).toBe(0);
  });

  it('says the directory is gone, not that git failed, for a topic whose directory was removed', async () => {
    const gone = { ok: false, reason: 'missing', text: "This topic's directory no longer exists: /srv/wt/feature" };
    const h = await open({
      replies: { [`api/git/branches?t=${A}`]: gone, [statusPath('working')]: gone },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#git-toggle');
    await until('the sentence', () => Boolean(h.el('git-diff').querySelector('.git-blank')));

    expect(h.el('git-diff').querySelector('.gb-title')?.textContent).toBe('Directory not found.');
    expect(h.el('git-diff').textContent).toContain('/srv/wt/feature');
    expect(h.el('git-note').hidden).toBe(true);
  });

  it('repaints the pane when a directory that was not a repository becomes one', async () => {
    const status: Record<string, unknown> = {
      ok: false,
      reason: 'not-git',
      text: '/srv/work is not inside a git repository.',
    };
    const branches: Record<string, unknown> = { ok: false, reason: 'not-git', text: 'not a git repository' };
    const h = await open({
      replies: { [`api/git/branches?t=${A}`]: branches, [statusPath('working')]: status },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#git-toggle');
    await until('the sentence', () => h.el('git-diff').textContent!.includes('not inside a git repository'));

    // An agent runs `git init` in the directory; the turn ends and the window reads it again.
    Object.assign(status, {
      ok: true,
      repo: { root: '/srv/work', branch: 'main', base: 'main' },
      files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }],
    });
    delete status.reason;
    delete status.text;
    Object.assign(branches, { ok: true, branch: 'main', base: 'main', branches: ['main'] });
    delete branches.reason;
    delete branches.text;
    await h.emit({ t: 'typing', on: false });

    await until('the files', () => h.el('git-files').querySelectorAll('.git-file').length === 1);
    // The answer before it is gone from the pane, the stale branch refusal with it, and the first
    // file opened by itself as it would on any first list.
    expect(h.el('git-diff').textContent).not.toContain('not inside a git repository');
    expect(h.el('git-note').hidden).toBe(true);
    await until('the first file', () => h.calls.some((c) => c.path === filePath('working', 'src/a.ts')));
  });

  it('re-reads the branches when a repository appears while the window sits on Commits', async () => {
    const status: Record<string, unknown> = {
      ok: false,
      reason: 'not-git',
      text: '/srv/work is not inside a git repository.',
    };
    const branches: Record<string, unknown> = { ok: false, reason: 'not-git', text: 'not a git repository' };
    const log: Record<string, unknown> = {
      ok: false,
      reason: 'not-git',
      text: '/srv/work is not inside a git repository.',
    };
    const branchesPath = `api/git/branches?t=${A}`;
    const logPath = `api/git/log?t=${A}&skip=0`;
    const h = await open({ replies: { [branchesPath]: branches, [statusPath('working')]: status, [logPath]: log } });
    await h.emit(sync(A, [], [A]));
    await h.click('#git-toggle');
    await until('the not-git answer', () => h.el('git-diff').textContent!.includes('not inside a git repository'));

    // The window is left on Commits while an agent turns the directory into a repository: the
    // history read succeeds and clears the shared not-git flag, but the branch refusal stays.
    await h.click('[data-gm="commits"]');
    await until('the history refusal', () => h.el('git-diff').textContent!.includes('not inside a git repository'));
    Object.assign(status, { ok: true, repo: { root: '/srv/work', branch: 'main', base: 'main' }, files: [] });
    delete status.reason;
    delete status.text;
    Object.assign(branches, { ok: true, branch: 'main', base: 'main', branches: ['main'] });
    delete branches.reason;
    delete branches.text;
    Object.assign(log, { ok: true, repo: { root: '/srv/work', branch: 'main' }, commits: [], more: false });
    delete log.reason;
    delete log.text;
    await h.emit({ t: 'typing', on: false });
    await until('the history', () => h.calls.filter((c) => c.path === logPath).length === 2);

    await h.click('[data-gm="working"]');
    await until('the branches again', () => h.calls.filter((c) => c.path === branchesPath).length === 2);
    await tick();
    // The refusal from the not-git answer is not pasted back over a list that now has a branch.
    expect(h.el('git-note').hidden).toBe(true);
    expect(Array.from(h.el('git-base').querySelectorAll('option')).map((o) => o.textContent)).toEqual(['main']);
  });

  it('names the comparison that came back empty, and offers the commits from it', async () => {
    const at = Date.now() - 2 * 3600 * 1000;
    const h = await open({
      replies: {
        ...replies(),
        [statusPath('working')]: { ok: true, repo: { root: '/srv/project', branch: 'main', base: 'main' }, files: [] },
        [`api/git/log?t=${A}&skip=0`]: {
          ok: true,
          repo: { root: '/srv/project', branch: 'main' },
          commits: [{ sha: 'abc1234def', short: 'abc1234', subject: 'The first commit', author: 'Ada', at, parents: [] }],
          more: false,
        },
      },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#git-toggle');
    await until('the empty comparison', () => Boolean(h.el('git-diff').querySelector('.git-blank')));

    // Which comparison is empty, said where the diff would have been.
    expect(h.el('git-diff').textContent).toContain('HEAD');
    expect(h.el('git-files').querySelector('.git-file')).toBeNull();

    await h.click('[data-gact="commits"]');
    await until('the history', () => h.el('git-files').querySelectorAll('.git-commit').length === 1);
    expect(h.calls.some((c) => c.path === `api/git/log?t=${A}&skip=0`)).toBe(true);
    expect(
      Array.from(h.el('git-modes').querySelectorAll('.git-mode.on')).map((b) => b.getAttribute('data-gm'))
    ).toEqual(['commits']);
    expect(h.el('git-base').hidden).toBe(true);
  });

  it('names the base branch in an empty branch comparison', async () => {
    const h = await open({
      replies: replies({
        [statusPath('branch', 'main')]: {
          ok: true,
          repo: { root: '/srv/project', branch: 'main', base: 'main' },
          files: [],
        },
      }),
    });
    await openWindow(h);
    await h.click('[data-gm="branch"]');
    await until('the empty branch', () => h.el('git-diff').textContent!.includes('main'));
    expect(h.el('git-diff').textContent).toContain('No changes against main');
  });

  it('says a turn changed nothing, without a comparison it cannot switch to', async () => {
    const statusUrl = `api/turn-changes/status?t=${A}&turn=2`;
    const h = await open({ replies: { [statusUrl]: { ok: true, repo: { root: '/srv/project' }, files: [] } } });
    await h.emit(sync(A, [], [A]));
    (h.window as any).openGitWindow({
      title: 'Turn 2 changes',
      statusUrl,
      fileUrl: `api/turn-changes/file?t=${A}&turn=2`,
    });
    await until('the empty turn', () => Boolean(h.el('git-diff').querySelector('.git-blank')));

    expect(h.el('git-diff').textContent).toContain('No changes in this turn.');
    // The view is fixed to one turn: there is no other comparison to name or offer.
    expect(h.el('git-diff').textContent).not.toContain('HEAD');
    expect(h.el('git-diff').querySelector('[data-gact]')).toBeNull();
  });

  it('opens the first file on a wide window, and asks for one on a phone', async () => {
    const h = await open({ replies: replies() });
    const diffs = installCodeView(h);
    await openWindow(h);
    await until('the first file by itself', () => diffs.length === 1);
    expect(diffs[0]!.options.name).toBe('src/a.ts');
    expect(h.el('git-files').querySelector('.git-file.on')?.getAttribute('data-gpath')).toBe('src/a.ts');

    const phone = await open({ width: 500, replies: replies() });
    const phoneDiffs = installCodeView(phone);
    await phone.emit(sync(A, [], [A]));
    await phone.click('#git-toggle');
    await until('the list', () => phone.el('git-files').querySelectorAll('.git-file').length > 0);
    await tick();
    // The two columns are stacked there: opening a file would push the list out of sight.
    expect(phoneDiffs).toHaveLength(0);
    expect(phone.el('git-diff').textContent).toContain('Select a file');
    expect(phone.calls.some((c) => c.path === filePath('working', 'src/a.ts'))).toBe(false);
  });

  it('lists commits, pages further back, and opens one into its files and diff', async () => {
    const at = Date.now() - 2 * 3600 * 1000;
    const first = { sha: '1111111aaaa', short: '1111111', subject: 'Add the parser', author: 'Ada', at, parents: [] };
    const second = { sha: '2222222bbbb', short: '2222222', subject: 'Fix the parser', author: 'Grace', at: at - 3600000, parents: ['1111111aaaa'] };
    const log = (skip: number, commits: unknown[], more: boolean) => ({
      ok: true,
      repo: { root: '/srv/project', branch: 'main' },
      commits,
      more,
    });
    const h = await open({
      replies: replies({
        [`api/git/log?t=${A}&skip=0`]: log(0, [first], true),
        [`api/git/log?t=${A}&skip=1`]: log(1, [second], false),
        [`api/git/commit?t=${A}&sha=${encodeURIComponent(first.sha)}`]: {
          ok: true,
          repo: { root: '/srv/project', branch: 'main' },
          commit: { ...first, body: 'The parser is new.\nIt reads things.' },
          files: [{ path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 }],
        },
        [`api/git/commit-file?t=${A}&sha=${encodeURIComponent(first.sha)}&path=src%2Fa.ts`]: {
          ok: true,
          path: 'src/a.ts',
          status: 'modified',
          original: 'one\ntwo\n',
          modified: 'one\nTWO\nthree\n',
          patch: '@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+three\n',
        },
      }),
    });
    const diffs = installCodeView(h);
    await openWindow(h);
    await h.click('[data-gm="commits"]');
    await until('the first page', () => h.el('git-files').querySelectorAll('.git-commit').length === 1);

    const row = h.el('git-files').querySelector('.git-commit')!;
    expect(row.querySelector('.gc-subject')?.textContent).toBe('Add the parser');
    expect(row.querySelector('.gc-sha')?.textContent).toBe('1111111');
    expect(row.querySelector('.gc-author')?.textContent).toBe('Ada');
    expect(row.querySelector('.gc-when')?.textContent).toBe('2h ago');

    await h.click('[data-gmore]');
    await until('the second page', () => h.el('git-files').querySelectorAll('.git-commit').length === 2);
    expect(h.calls.some((c) => c.path === `api/git/log?t=${A}&skip=1`)).toBe(true);
    expect(h.el('git-files').querySelector('[data-gmore]')).toBeNull();

    // The working comparison had already opened its first file; the commit's diff is the next one.
    const before = diffs.length;
    await h.click('[data-gsha="1111111aaaa"]');
    await until('the commit’s files', () => h.el('git-files').querySelectorAll('.git-file').length === 1);
    expect(h.el('git-files').querySelector('.git-back')).not.toBeNull();
    expect(h.el('git-files').textContent).toContain('Add the parser');
    // A file inside a commit has no Edit: the editor writes the working tree, not this commit.
    expect(h.el('git-files').querySelector('.gf-edit')).toBeNull();

    const body = h.el('git-files').querySelector('.gch-body') as HTMLElement;
    expect(body.hidden).toBe(true);
    await h.click('[data-gbody]');
    expect(body.hidden).toBe(false);
    expect(body.textContent).toContain('The parser is new.');

    // The first file opens on a wide window, and its diff comes from the commit, not the tree.
    await until('the commit diff', () => diffs.length === before + 1);
    expect(
      h.calls.some((c) => c.path === `api/git/commit-file?t=${A}&sha=${encodeURIComponent(first.sha)}&path=src%2Fa.ts`)
    ).toBe(true);
    const commitDiff = diffs[diffs.length - 1]!;
    expect(commitDiff.options.original).toBe('one\ntwo\n');

    // A comment made here carries the short sha, or the agent reads it against today's file.
    commitDiff.options.onSelect?.({ side: 'new', from: 2, to: 3, text: 'WO\nthr' });
    await tick();
    await h.click('#git-comment-open');
    expect(h.el('git-comment-what').textContent).toBe('src/a.ts:L2-L3 \u00b7 new side \u00b7 1111111');
    (h.el('git-comment-text') as HTMLTextAreaElement).value = 'Looks good';
    await h.click('#git-comment-add');
    expect((h.el('input') as HTMLTextAreaElement).value).toBe(
      ['src/a.ts:L2-L3 (new, 1111111)', '```', 'TWO', 'three', '```', 'Looks good'].join('\n')
    );

    await h.click('[data-gback]');
    await tick();
    expect(h.el('git-files').querySelectorAll('.git-commit').length).toBe(2);
    expect(h.el('git-files').querySelector('.git-file')).toBeNull();
    // The pane asks for a commit rather than leaving the last diff under the list, and the
    // layout button went with the diff it belonged to.
    expect(h.el('git-diff').textContent).toContain('Pick a commit');
    expect(h.el('git-layout').hidden).toBe(true);
  });

  it('drops a commit answer when the mode changed under it', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    const sha = '1111111aaaa';
    const h = await open({
      replies: replies({
        [`api/git/log?t=${A}&skip=0`]: {
          ok: true,
          repo: { root: '/srv/project', branch: 'main' },
          commits: [{ sha, short: '1111111', subject: 'Add the parser', author: 'Ada', at: Date.now(), parents: [] }],
          more: false,
        },
        [`api/git/commit?t=${A}&sha=${encodeURIComponent(sha)}`]: {
          ok: true,
          repo: { root: '/srv/project', branch: 'main' },
          commit: { sha, short: '1111111', subject: 'Add the parser', author: 'Ada', at: Date.now(), parents: [] },
          files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }],
        },
      }),
      held: { [`api/git/commit?t=${A}&sha=${encodeURIComponent(sha)}`]: gate },
    });
    await openWindow(h);
    await h.click('[data-gm="commits"]');
    await until('the history', () => h.el('git-files').querySelectorAll('.git-commit').length === 1);
    await h.click(`[data-gsha="${sha}"]`);
    await within('the commit request', 1000, () =>
      h.calls.some((c) => c.path === `api/git/commit?t=${A}&sha=${encodeURIComponent(sha)}`)
    );

    await h.click('[data-gm="working"]');
    await until('the working list', () => h.el('git-files').querySelectorAll('.git-file').length > 0);
    release();
    await tick();
    await tick();

    // The commit belonged to the view that was left: no header, no files, nothing of it on screen.
    expect(h.el('git-files').querySelector('.git-back')).toBeNull();
    expect(h.el('git-files').textContent).not.toContain('Add the parser');
  });

  it('re-reads the history when a turn ends, and leaves the working comparison alone', async () => {
    const h = await open({
      replies: replies({
        [`api/git/log?t=${A}&skip=0`]: {
          ok: true,
          repo: { root: '/srv/project', branch: 'main' },
          commits: [
            { sha: '1111111aaaa', short: '1111111', subject: 'Add the parser', author: 'Ada', at: Date.now(), parents: [] },
          ],
          more: false,
        },
      }),
    });
    await openWindow(h);
    await h.click('[data-gm="commits"]');
    await until('the history', () => h.el('git-files').querySelectorAll('.git-commit').length === 1);
    const logs = h.calls.filter((c) => c.path === `api/git/log?t=${A}&skip=0`).length;
    const statuses = h.calls.filter((c) => c.path === statusPath('working')).length;

    await h.emit({ t: 'typing', on: false });
    await until('the history again', () =>
      h.calls.filter((c) => c.path === `api/git/log?t=${A}&skip=0`).length === logs + 1
    );
    // The comparison behind the window is not what the reader is looking at.
    expect(h.calls.filter((c) => c.path === statusPath('working')).length).toBe(statuses);
  });

  it('says the directory is not a repository when the history cannot be read', async () => {
    const h = await open({
      replies: replies({
        [`api/git/log?t=${A}&skip=0`]: {
          ok: false,
          reason: 'not-git',
          text: '/srv/work is not inside a git repository.',
        },
      }),
    });
    await openWindow(h);
    await h.click('[data-gm="commits"]');
    await until('the sentence', () => Boolean(h.el('git-diff').querySelector('.git-blank')));

    expect(h.el('git-diff').textContent).toContain('/srv/work is not inside a git repository.');
    expect(h.el('git-note').hidden).toBe(true);
    expect(h.el('git-files').querySelectorAll('.git-commit').length).toBe(0);
  });

  it('keeps the commits it has when Load more fails', async () => {
    const h = await open({
      replies: replies({
        [`api/git/log?t=${A}&skip=0`]: {
          ok: true,
          repo: { root: '/srv/project', branch: 'main' },
          commits: [
            { sha: '1111111aaaa', short: '1111111', subject: 'Add the parser', author: 'Ada', at: Date.now(), parents: [] },
          ],
          more: true,
        },
        [`api/git/log?t=${A}&skip=1`]: { ok: false, reason: 'error', text: 'git log failed: bad object' },
      }),
    });
    await openWindow(h);
    await h.click('[data-gm="commits"]');
    await until('the first page', () => h.el('git-files').querySelectorAll('.git-commit').length === 1);

    await h.click('[data-gmore]');
    await until('the failure', () => h.el('git-note').textContent!.includes('bad object'));
    // The rows it already had are still true, and the button is back for another try.
    expect(h.el('git-files').querySelectorAll('.git-commit').length).toBe(1);
    expect((h.el('git-files').querySelector('[data-gmore]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the open commit when the history refresh fails', async () => {
    const sha = '1111111aaaa';
    const at = Date.now();
    const log: Record<string, unknown> = {
      ok: true,
      repo: { root: '/srv/project', branch: 'main' },
      commits: [{ sha, short: '1111111', subject: 'Add the parser', author: 'Ada', at, parents: [] }],
      more: false,
    };
    const h = await open({
      replies: replies({
        [`api/git/log?t=${A}&skip=0`]: log,
        [`api/git/commit?t=${A}&sha=${encodeURIComponent(sha)}`]: {
          ok: true,
          repo: { root: '/srv/project', branch: 'main' },
          commit: { sha, short: '1111111', subject: 'Add the parser', author: 'Ada', at, parents: [] },
          files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }],
        },
      }),
    });
    await openWindow(h);
    await h.click('[data-gm="commits"]');
    await until('the history', () => h.el('git-files').querySelectorAll('.git-commit').length === 1);
    await h.click(`[data-gsha="${sha}"]`);
    await until('the commit’s files', () => h.el('git-files').querySelectorAll('.git-file').length === 1);

    // A turn ends while the commit is open and the history read fails: the commit stays put.
    Object.assign(log, { ok: false, reason: 'error', text: 'git log failed: bad object' });
    delete log.commits;
    await h.emit({ t: 'typing', on: false });
    await until('the failure', () => h.el('git-note').textContent!.includes('bad object'));
    expect(h.el('git-files').querySelector('.git-back')).not.toBeNull();
    expect(h.el('git-files').querySelectorAll('.git-file').length).toBe(1);
    expect(h.el('git-files').textContent).toContain('Add the parser');
  });
});

/**
 * The instruction editor: the settings page's Instructions section, and the file window opened on
 * it (page.ts "Instructions"). The daemon's side is tested in daemon/instructions-panel.test.ts;
 * here, what a person sees and does — the section only when the feature is on, the window without
 * the controls that make no sense for a fixed list, a save carrying its version (or "create" for a
 * file not written yet), and where the text went said in the window.
 */
describe('webui page: the instruction editor', () => {
  const A = 'a1b2c3d4';
  const SHA = 'c'.repeat(64);
  const settingsList = {
    ...message('m1', '<p>Settings</p>'),
    buttons: [{ id: 'stg:r:0', label: 'Idle reclaim · 15m' }],
    settings: {
      level: 'list',
      groups: [{ name: 'Agents' }, { name: 'Conversations' }],
      rows: [
        {
          buttonId: 'stg:a:0',
          label: 'cc',
          target: 'cc',
          targetKind: 'Claude Code',
          group: 'Agents',
          control: {
            kind: 'agent',
            fields: [{ label: 'Model', buttonId: 'stg:a:0', value: 'harness default', unset: true, control: { kind: 'list' } }],
          },
        },
        { buttonId: 'stg:r:0', label: 'Idle reclaim', value: '15m', group: 'Conversations', control: { kind: 'list' } },
      ],
    },
  };
  const LIST = {
    dir: '/c/instructions',
    on: true,
    global: [
      { name: 'common.md', layer: 'common', exists: true, size: 5, agents: ['cc', 'cx'], reach: 'every agent' },
      { name: 'claude.md', layer: 'claude', exists: false, agents: ['cc'], reach: 'every Claude Code agent' },
    ],
    agents: [
      { id: 'cc', harness: 'claude', host: 'box', file: '~/.claude/CLAUDE.md', own: '`@` references in `~/.claude/CLAUDE.md`, and `~/.claude/rules`' },
      { id: 'oc', harness: 'gemini', host: 'local' },
    ],
  };
  const COMMON = 'api/instructions/read?scope=global&name=common.md';
  const CLAUDE = 'api/instructions/read?scope=global&name=claude.md';
  const REFS = 'api/instructions/refs?agent=cc';
  const RULE = `api/instructions/read?scope=agent&agent=cc&path=${encodeURIComponent('/h/.claude/rules/a.md')}`;
  const commonFile = { ok: true, path: '/c/instructions/common.md', dir: '/c/instructions', name: 'common.md', size: 5, mtimeMs: 7, kind: 'text', text: 'hello', eol: 'lf', sha256: SHA };
  const claudeFile = { ok: true, missing: true, path: '/c/instructions/claude.md', dir: '/c/instructions', name: 'claude.md', size: 0, mtimeMs: 0, kind: 'text', text: '', eol: 'lf' };
  const ruleFile = { ok: true, path: '/h/.claude/rules/a.md', dir: '/h/.claude/rules', name: 'a.md', size: 4, mtimeMs: 9, kind: 'text', text: 'rule', eol: 'lf', sha256: SHA };
  const refs = {
    ok: true,
    agent: 'cc',
    host: 'box',
    root: '~/.claude/CLAUDE.md',
    rootState: 'managed',
    summary: '`@` references in `~/.claude/CLAUDE.md`, and `~/.claude/rules`',
    refs: [
      { path: '/h/.claude/rules/a.md', shown: '~/.claude/rules/a.md', exists: true, depth: 1, kind: 'rule', editable: true },
      { path: '/h/new.md', shown: '~/new.md', exists: false, depth: 2, kind: 'reference', editable: true, via: '~/.claude/rules/a.md' },
      {
        path: '/h/.fleetherd/instructions/codex.md',
        shown: '~/.fleetherd/instructions/codex.md',
        exists: true,
        depth: 1,
        kind: 'reference',
        editable: false,
        note: "the gateway's delivered copy: edit the shared files above it",
      },
    ],
  };

  async function opened(over: Record<string, unknown> = {}, list: Record<string, unknown> = LIST, status?: Record<string, number>): Promise<Harness> {
    const h = await open({
      instructions: true,
      replies: { 'api/instructions': list, [COMMON]: commonFile, [CLAUDE]: claudeFile, [REFS]: refs, [RULE]: ruleFile, ...over },
      ...(status ? { status } : {}),
    });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'msg', msg: settingsList });
    await until('the files', () => Boolean(h.doc.querySelector('.ag-card[data-ag="cc"] [data-instr-agent]')));
    await h.click('.ag-card[data-ag="cc"] .ag-top');
    return h;
  }

  const editor = (h: Harness): HTMLTextAreaElement => h.el('files-editor').querySelector('textarea') as HTMLTextAreaElement;
  const type = (h: Harness, v: string): void => {
    const ta = editor(h);
    ta.value = v;
    ta.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  };
  const writes = (h: Harness) => h.calls.filter((c) => c.path === 'api/instructions/write');
  const tree = (h: Harness) => Array.from(h.el('files-tree-list').querySelectorAll('[data-fx-file]')).map((b) => b.getAttribute('data-fx-file'));

  it('leaves the files out of every card, and asks for nothing, when the daemon has it off', async () => {
    const h = await open({ replies: { 'api/instructions': LIST } });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'msg', msg: settingsList });
    await tick();
    expect(h.el('settings-page').hidden).toBe(false);
    expect(h.doc.querySelector('.ag-instr, .instr-sec, [data-instr-agent]')).toBeNull();
    expect(h.calls.some((c) => c.path.startsWith('api/instructions'))).toBe(false);
  });

  it('lists what an agent reads on its card — the shared files, then its own — and has no section of its own', async () => {
    const h = await opened();
    // The daemon's rows are the whole page: nothing is appended after them.
    expect(h.doc.querySelector('.instr-sec')).toBeNull();
    expect(Array.from(h.doc.querySelectorAll('#settings-body .set-group')).map((e) => e.textContent)).toEqual(['Agents', 'Conversations']);
    const files = Array.from(h.doc.querySelectorAll('.ag-card[data-ag="cc"] .ag-file')).map((b) => [
      b.getAttribute('data-instr-file'),
      b.querySelector('.ag-fname')?.textContent,
      b.querySelector('.ag-fsub')?.textContent,
      b.getAttribute('title'),
    ]);
    // Shared ones say who else an edit reaches; one not written yet says so.
    expect(files).toEqual([
      ['g:common.md', 'common.md', 'every agent · 2 read it', 'cc, cx'],
      ['g:claude.md', 'claude.md', 'every Claude Code agent · 1 reads itnot written', 'cc'],
      [null, 'Its own files', '@ references in ~/.claude/CLAUDE.md, and ~/.claude/rules · box', null],
    ]);
    expect(h.doc.querySelector('.ag-card[data-ag="cc"] .ag-file:not([data-instr-file]) .ag-fsub')?.innerHTML).toContain('<code>~/.claude/rules</code>');
    // Every shared file has a reader, so there is no layer-no-one-reads row.
    expect(h.doc.querySelector('[data-instr-orphans]')).toBeNull();
  });

  it('says who reads a shared file from the daemon, and names the layer when another kind shares it', async () => {
    const shared = {
      ...LIST,
      global: [
        { name: 'common.md', layer: 'common', exists: true, size: 5, agents: ['cc', 'mh'], reach: 'every agent' },
        { name: 'claude.md', layer: 'claude', exists: true, size: 3, agents: ['cc', 'mh'], reach: 'the claude layer' },
      ],
    };
    const h = await opened({}, shared);
    expect(h.doc.querySelector('.ag-card[data-ag="cc"] [data-instr-file="g:claude.md"] .ag-fsub')?.textContent).toBe(
      'the claude layer · 2 read it'
    );
    await h.click('.ag-card[data-ag="cc"] [data-instr-file="g:claude.md"]');
    await until('the editor', () => Boolean(editor(h)));
    expect(h.el('files-tree-list').querySelector('[data-fx-file="g:claude.md"] .fx-sub')?.textContent).toBe('the claude layer');
  });

  it('lists a layer file no agent reads under the Agents cards, and opens it so it can be cleared', async () => {
    const ORPHAN = 'api/instructions/read?scope=global&name=mh.md';
    const mhFile = {
      ok: true,
      path: '/c/instructions/mh.md',
      dir: '/c/instructions',
      name: 'mh.md',
      size: 4,
      mtimeMs: 11,
      kind: 'text',
      text: 'old\n',
      eol: 'lf',
      sha256: SHA,
    };
    const list = {
      ...LIST,
      global: [...LIST.global, { name: 'mh.md', layer: 'mh', exists: true, size: 4, agents: [], reach: 'the mh layer' }],
    };
    const h = await opened({ [ORPHAN]: mhFile, 'api/instructions/write': { ok: true, mtimeMs: 12, size: 0, sha256: 'a'.repeat(64) } }, list);
    const row = h.doc.querySelector('[data-instr-orphans]');
    expect(row?.textContent).toContain('Instructions no agent reads');
    expect(row?.textContent).toContain('mh.md');
    // common.md is on every agent's card, never a layer no one reads.
    expect(row?.textContent).not.toContain('common.md');
    await h.click('[data-instr-orphans]');
    await until('the tree', () => tree(h).includes('g:mh.md'));
    expect(tree(h)).toEqual(['g:mh.md']);
    expect(h.el('files-title').textContent).toBe('Instructions no agent reads');
    expect(h.el('files-tree-list').querySelector('[data-fx-file="g:mh.md"] .fx-sub')?.textContent).toBe('the mh layer · no agent reads it');
    await h.click('[data-fx-file="g:mh.md"]');
    await until('the editor', () => Boolean(editor(h)));
    expect(editor(h).value).toBe('old\n');
    type(h, '');
    await h.click('#files-save');
    await until('the save', () => writes(h).length === 1);
    expect(writes(h)[0]!.body).toEqual({ scope: 'global', name: 'mh.md', text: '', mtimeMs: 11, size: 4, sha256: SHA });
    await until('the answer', () => /Saved/.test(h.el('files-note').textContent ?? ''));
    expect(h.el('files-note').textContent).toContain('No configured agent reads this file.');
  });

  it('never counts common.md as a layer no agent reads, even with no agent configured', async () => {
    const list = { ...LIST, global: [{ name: 'common.md', layer: 'common', exists: true, size: 5, agents: [], reach: 'every agent' }] };
    const h = await opened({}, list);
    expect(h.doc.querySelector('[data-instr-orphans]')).toBeNull();
  });

  it('opens a shared file in the file window, on that agent’s whole list, without the controls a fixed list has no use for', async () => {
    const h = await opened();
    await h.click('.ag-card[data-ag="cc"] [data-instr-file="g:common.md"]');
    await until('the editor', () => Boolean(editor(h)));
    expect(h.el('files').hidden).toBe(false);
    expect(h.el('files-title').textContent).toBe('common.md');
    expect(h.el('files-where').textContent).toBe('common.md');
    expect(editor(h).value).toBe('hello');
    for (const id of ['files-tree-head', 'files-search-row', 'files-rename-open', 'files-delete', 'files-crumbs']) {
      expect(h.el(id).hidden, id).toBe(true);
    }
    // Everything it reads, in two parts, each saying where its files live.
    expect(tree(h)).toEqual(['g:common.md', 'g:claude.md', 'a:/h/.claude/rules/a.md', 'a:/h/new.md']);
    expect(Array.from(h.el('files-tree-list').querySelectorAll('.fx-sec')).map((e) => e.textContent)).toEqual([
      'Shared, kept on the gateway',
      'On box',
    ]);
    expect(h.el('files-tree-list').querySelector('[data-fx-file="g:common.md"] .fx-sub')?.textContent).toBe('every agent');
    expect(h.el('files-tree-list').querySelector('[data-fx-file="g:claude.md"] .fx-sub')?.textContent).toBe('every Claude Code agent');
    // The page never asked the file window's routes for anything.
    expect(h.calls.some((c) => c.path.startsWith('api/files/'))).toBe(false);
  });

  it('saves a shared file with the version it read, and says where the text was placed', async () => {
    const h = await opened({
      'api/instructions/write': {
        ok: true,
        mtimeMs: 8,
        size: 6,
        sha256: 'd'.repeat(64),
        delivery: [
          { host: 'local', agents: ['cx'], outcome: 'linked', link: '/x/.codex/AGENTS.md' },
          { host: 'box', agents: ['cc'], outcome: 'unreachable', detail: 'no answer within 10 s' },
        ],
      },
    });
    await h.click('.ag-card[data-ag="cc"] [data-instr-file="g:common.md"]');
    await until('the editor', () => Boolean(editor(h)));
    type(h, 'hello!');
    await h.click('#files-save');
    await until('the save', () => writes(h).length === 1);
    expect(writes(h)[0]!.body).toEqual({ scope: 'global', name: 'common.md', text: 'hello!', mtimeMs: 7, size: 5, sha256: SHA });
    await until('the answer', () => /Saved/.test(h.el('files-note').textContent ?? ''));
    expect(h.el('files-note').textContent).toBe(
      'Saved common.md. Placed for cx; a session already running keeps what it read. box did not answer; it gets this when an agent next starts there.'
    );
    expect(h.el('files-dirty').hidden).toBe(true);
  });

  it('says a connect agent gets a saved shared file with its next session, not that no agent reads it', async () => {
    const h = await opened({
      'api/instructions/write': {
        ok: true,
        mtimeMs: 8,
        size: 6,
        sha256: 'd'.repeat(64),
        delivery: [{ host: 'box', agents: ['gt@box'], outcome: 'next-session' }],
      },
    });
    await h.click('.ag-card[data-ag="cc"] [data-instr-file="g:common.md"]');
    await until('the editor', () => Boolean(editor(h)));
    type(h, 'hello!');
    await h.click('#files-save');
    await until('the answer', () => /Saved/.test(h.el('files-note').textContent ?? ''));
    expect(h.el('files-note').textContent).toBe(
      'Saved common.md. gt@box on box: given this when its next session starts; one already running keeps what it read.'
    );
  });

  it('creates a file not written yet instead of sending a version it never had', async () => {
    const h = await opened({ 'api/instructions/write': { ok: true, mtimeMs: 3, size: 2, sha256: 'e'.repeat(64), delivery: [] } });
    await h.click('.ag-card[data-ag="cc"] [data-instr-file="g:claude.md"]');
    await until('the editor', () => Boolean(editor(h)));
    expect(h.el('files-note').textContent).toBe('Not written yet. Saving creates it.');
    expect(h.el('files-tree-list').querySelector('[data-fx-file="g:claude.md"] .fx-tag')?.textContent).toBe('not written');
    type(h, 'x\n');
    await h.click('#files-save');
    await until('the save', () => writes(h).length === 1);
    expect(writes(h)[0]!.body).toEqual({ scope: 'global', name: 'claude.md', text: 'x\n', missing: true });
    await until('the tree', () => !h.el('files-tree-list').querySelector('[data-fx-file="g:claude.md"] .fx-tag'));
  });

  it('lists an agent’s own files from its machine under the shared ones, and saves one where it is', async () => {
    const h = await opened({ 'api/instructions/write': { ok: true, mtimeMs: 10, size: 5, sha256: 'f'.repeat(64) } });
    await h.click('.ag-card[data-ag="cc"] .ag-file:not([data-instr-file])');
    await until('the tree', () => tree(h).length === 4);
    expect(h.calls.some((c) => c.path === REFS)).toBe(true);
    expect(h.el('files-title').textContent).toBe('cc · instructions');
    const list = h.el('files-tree-list');
    expect(Array.from(list.querySelectorAll('.fx-head')).map((e) => e.textContent)).toEqual([
      'A save places it on every machine an agent that reads it is configured for.',
      '@ references in ~/.claude/CLAUDE.md, and ~/.claude/rules. ~/.claude/CLAUDE.md is the gateway’s copy: add a reference to a shared file above.',
    ]);
    // The gateway's own copy is listed and cannot be opened here.
    const off = list.querySelector('.fx-off') as HTMLElement;
    expect(off.textContent).toContain('~/.fleetherd/instructions/codex.md');
    expect(off.textContent).toContain('edit the shared files above it');
    expect(off.querySelector('button')).toBeNull();
    expect(list.querySelector('[data-fx-file="a:/h/new.md"]')?.getAttribute('title')).toBe('~/new.md ← ~/.claude/rules/a.md');

    await h.click('[data-fx-file="a:/h/.claude/rules/a.md"]');
    await until('the editor', () => Boolean(editor(h)));
    expect(h.el('files-where').textContent).toBe('~/.claude/rules/a.md');
    type(h, 'rule!');
    await h.click('#files-save');
    await until('the save', () => writes(h).length === 1);
    expect(writes(h)[0]!.body).toEqual({ scope: 'agent', agent: 'cc', path: '/h/.claude/rules/a.md', text: 'rule!', mtimeMs: 9, size: 4, sha256: SHA });
    await until('the answer', () => /Saved/.test(h.el('files-note').textContent ?? ''));
    expect(h.el('files-note').textContent).toBe('Saved ~/.claude/rules/a.md. cc reads it when its next session starts.');
  });

  it('keeps the shared files when its machine cannot list its own, and says why there', async () => {
    const h = await opened({ [REFS]: { ok: false, error: 'box did not answer.' } }, LIST, { [REFS]: 502 });
    await h.click('.ag-card[data-ag="cc"] .ag-file:not([data-instr-file])');
    await until('the tree', () => tree(h).length === 2);
    expect(tree(h)).toEqual(['g:common.md', 'g:claude.md']);
    expect(Array.from(h.el('files-tree-list').querySelectorAll('.fx-sec')).map((e) => e.textContent)).toEqual([
      'Shared, kept on the gateway',
      'On box',
    ]);
    expect(Array.from(h.el('files-tree-list').querySelectorAll('.fx-head')).at(-1)?.textContent).toBe('box did not answer.');
  });

  it('does not ask an agent’s machine for files its harness does not have', async () => {
    const h = await opened({}, { ...LIST, agents: [{ id: 'cc', harness: 'claude', host: 'box' }] });
    expect(h.doc.querySelector('.ag-card[data-ag="cc"] .ag-file:not([data-instr-file])')).toBeNull();
    await h.click('.ag-card[data-ag="cc"] [data-instr-file="g:common.md"]');
    await until('the editor', () => Boolean(editor(h)));
    expect(tree(h)).toEqual(['g:common.md', 'g:claude.md']);
    expect(h.el('files-tree-list').querySelectorAll('.fx-sec')).toHaveLength(1);
    expect(h.calls.some((c) => c.path === REFS)).toBe(false);
  });

  it('puts the editor away alone on Escape, and asks for the list again for the page it came from', async () => {
    const h = await opened();
    const before = h.calls.filter((c) => c.path === 'api/instructions').length;
    await h.click('.ag-card[data-ag="cc"] [data-instr-file="g:common.md"]');
    await until('the editor', () => Boolean(editor(h)));
    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.el('files').hidden).toBe(true);
    expect(h.el('settings-page').hidden).toBe(false);
    // The tree's own "list" plus the refresh the close asks for.
    await until('the refresh', () => h.calls.filter((c) => c.path === 'api/instructions').length >= before + 2);
    // The card it was opened from is still open once the list is drawn again.
    await until('the redraw', () => Boolean(h.doc.querySelector('.ag-card[data-ag="cc"].open [data-instr-file]')));
    // The window is the file window again for whoever opens it next: nothing of this mode is left.
    expect(h.el('files-tree-head').hidden).toBe(false);
    expect(h.el('files-search-row').hidden).toBe(false);
  });
});

describe('webui page: forked topics (Topic.forkOf)', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const D = 'd15a7c40';
  const F = 'f0f0f0f0';
  const rows = (h: Harness): Array<string | null> =>
    Array.from(h.el('topics').querySelectorAll('[data-topic]')).map((r) => r.getAttribute('data-topic'));
  const row = (h: Harness, id: string): Element => h.doc.querySelector(`#topics [data-topic="${id}"]`)!;
  /** A topic, a sub-agent's topic under it, an unrelated topic, and a fork; each flag set by the test. */
  const fleet = (over: Record<string, Record<string, unknown>> = {}): Array<Record<string, unknown>> =>
    [
      // The daemon's order: most recently active first.
      { id: F, title: 'fix login (fork)', lastAt: 2000, msgCount: 0, stage: 'idle', forkOf: A, forkTurn: 3 },
      { id: A, title: 'fix login', lastAt: 1000, msgCount: 0, stage: 'idle' },
      { id: B, title: 'part', lastAt: 999, msgCount: 0, stage: 'idle', parent: A },
      { id: D, title: 'other', lastAt: 500, msgCount: 0, stage: 'idle' },
    ].map((t) => ({ ...t, ...(over[t.id] ?? {}) }));

  it('draws a fork right after its source and what is under it, marked, whatever state it is in', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${D}` });
    await h.emit(sync(D, [], [D]));
    // The fork is the most recent topic and working, which on its own would put it first.
    await h.emit({ t: 'topics', topics: fleet({ [F]: { running: true, stage: 'working' } }) });
    expect(rows(h)).toEqual([A, F, D]);
    await h.click(`#topics [data-fold="${A}"]`);
    expect(rows(h)).toEqual([A, B, F, D]);
    // Beside its source, not under it: the depth is the source's, and no fold counts it.
    expect(row(h, F).className).not.toMatch(/\bsub\b/);
    expect(face(h.doc.querySelector(`#topics [data-fold="${A}"]`))).toBe('[chevronDown] 1');
    const mark = row(h, F).querySelector('.topic-fork-mark')!;
    expect(face(mark)).toBe('[fork]');
    expect(mark.getAttribute('title')).toBe('Forked from fix login · turn 3');
    expect(row(h, A).querySelector('.topic-fork-mark')).toBeNull();
  });

  it("goes where its source goes: beside a sub-agent's topic, and folded away with it", async () => {
    const h = await open({ url: `http://localhost:8787/?t=${D}` });
    await h.emit(sync(D, [], [D]));
    await h.emit({ t: 'topics', topics: fleet({ [F]: { forkOf: B } }) });
    // Under a folded parent, as its source is.
    expect(rows(h)).toEqual([A, D]);
    await h.click(`#topics [data-fold="${A}"]`);
    expect(rows(h)).toEqual([A, B, F, D]);
    expect(row(h, F).className).toMatch(/\bsub d1\b/);
    // It is not what A's agent opened: the fold still counts one.
    expect(face(h.doc.querySelector(`#topics [data-fold="${A}"]`))).toBe('[chevronDown] 1');
  });

  it("keeps the topic on screen visible when it is a fork of a folded-away sub-agent's topic", async () => {
    const h = await open({ url: `http://localhost:8787/?t=${F}` });
    await h.emit(sync(F, [], [F]));
    await h.emit({ t: 'topics', topics: fleet({ [F]: { forkOf: B } }) });
    expect(rows(h)).toEqual([A, B, F, D]);
  });

  it('is a root of its own when its source is not in the list', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${D}` });
    await h.emit(sync(D, [], [D]));
    await h.emit({ t: 'topics', topics: fleet({ [F]: { forkOf: 'e0e0e0e0' } }).filter((t) => t.id !== A && t.id !== B) });
    expect(rows(h)).toEqual([F, D]);
    expect(row(h, F).querySelector('.topic-fork-mark')?.getAttribute('title')).toBe('Forked from another topic · turn 3');
  });

  it('says at the top of the fork where it came from, and goes back there on a tap', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${F}` });
    await h.emit(sync(F, [], [F]));
    await h.emit({ t: 'topics', topics: fleet() });
    const note = h.el('fork-note');
    expect(note.hidden).toBe(false);
    expect(face(note)).toBe('[fork]Forked fromfix login· turn 3');
    expect(note.getAttribute('title')).toBe('Back to fix login');
    await h.click('#fork-note');
    await opens(h, `api/events?t=${A}`);
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: fleet() });
    // The source is not a fork: no line there.
    expect(note.hidden).toBe(true);
  });

  it('says nothing about a source that is gone, and leaves out a turn it was not told', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${F}` });
    await h.emit(sync(F, [], [F]));
    await h.emit({ t: 'topics', topics: fleet({ [F]: { forkTurn: undefined } }) });
    expect(face(h.el('fork-note'))).toBe('[fork]Forked fromfix login');
    // The daemon drops forkOf with its source, and the line goes with it.
    await h.emit({ t: 'topics', topics: fleet({ [F]: { forkOf: undefined, forkTurn: undefined } }).filter((t) => t.id !== A) });
    expect(h.el('fork-note').hidden).toBe(true);
  });

  it("types /fork from the menu: into the topic on screen with its bubble, into another without one", async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: fleet() });
    await rowMenu(h, A);
    await h.click('[data-rmk="fork"]');
    await until('the send', () => h.calls.some((c) => c.path === 'api/send'));
    expect(h.calls.filter((c) => c.path === 'api/send').map((c) => [c.body.topic, c.body.text])).toEqual([[A, '/fork']]);
    expect(h.el('log').textContent).toContain('/fork');
    expect(h.el('row-menu').hidden).toBe(true);

    await rowMenu(h, D);
    await h.click('[data-rmk="fork"]');
    await until('the second send', () => h.calls.filter((c) => c.path === 'api/send').length === 2);
    const second = h.calls.filter((c) => c.path === 'api/send')[1]!;
    expect([second.body.topic, second.body.text]).toEqual([D, '/fork']);
    expect(typeof second.body.nonce).toBe('string');
    // Still on A: the answer is in D, and the fork appears beside D in the list.
    expect(h.window.location.search).toBe(`?t=${A}`);
  });

  it('greys Fork, and says why, while a turn runs there', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${A}` });
    await h.emit(sync(A, [], [A]));
    await h.emit({ t: 'topics', topics: fleet({ [D]: { running: true } }) });
    await rowMenu(h, D);
    const fork = h.doc.querySelector<HTMLButtonElement>('[data-rmk="fork"]')!;
    expect(fork.disabled).toBe(true);
    expect(fork.title).toMatch(/fork it once the turn ends/);
  });

  it('hides the line while a conversation from History is open in its place', () => {
    const css = renderPage('Chat', false).match(/#chat\.lib #log,[^{]*\{display:none\}/)?.[0] ?? '';
    expect(css).toContain('#chat.lib #fork-note');
  });

  it("lets only the source's title give way on a narrow screen", () => {
    // Pinned as text: jsdom has no layout. Without it the words around the title wrapped at 390px.
    const html = renderPage('Chat', false);
    expect(html).toContain('#fork-note span{white-space:nowrap;flex-shrink:0}');
    expect(html).toContain('#fork-note .fork-src{color:var(--fg);overflow:hidden;text-overflow:ellipsis;min-width:0;flex-shrink:1}');
  });
});
