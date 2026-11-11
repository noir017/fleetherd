import { describe, expect, it } from 'vitest';
import {
  WORKDIR_PAGE_SIZE,
  buildWorkdirMenu,
  matchWorkdirs,
  parseWorkdirButtonId,
  workdirAmbiguousText,
  workdirChoiceText,
  workdirIndexOf,
  workdirMenuSurface,
  workdirNoMatchText,
  workdirPageCount,
  workdirPageOf,
  workdirSummaryText,
  type WorkdirOption,
} from './workdir-menu.js';

/** A workspace of the shape this feature was built for: a root plus one directory per project. */
const OPTIONS: WorkdirOption[] = [
  { path: '/home/u/workspace', name: 'workspace', root: true },
  { path: '/home/u/workspace/fleetherd', name: 'fleetherd' },
  { path: '/home/u/workspace/shop-api', name: 'shop-api' },
  { path: '/home/u/workspace/shop-api-web', name: 'shop-api-web' },
  { path: '/home/u/workspace/tools', name: 'tools' },
  { path: '/home/u/workspace/uniagent', name: 'uniagent' },
  { path: '/home/u/workspace/scratch', name: 'scratch' },
  { path: '/home/u/workspace/notes', name: 'notes' },
];

const menu = (page: number, current?: string) =>
  buildWorkdirMenu({ reqId: 'ab12cd34', options: OPTIONS, current, page });

const picks = (buttons: Array<{ id: string; label: string }>) =>
  buttons.filter((b) => b.id.startsWith('wdr:'));
const navs = (buttons: Array<{ id: string; label: string }>) =>
  buttons.filter((b) => b.id.startsWith('wdp:'));

describe('page arithmetic', () => {
  it('counts pages, never fewer than one', () => {
    expect(workdirPageCount(OPTIONS.length)).toBe(2);
    expect(workdirPageCount(WORKDIR_PAGE_SIZE)).toBe(1);
    expect(workdirPageCount(0)).toBe(1);
  });

  it('maps an index to its page', () => {
    expect(workdirPageOf(0)).toBe(0);
    expect(workdirPageOf(WORKDIR_PAGE_SIZE)).toBe(1);
  });

  it('locates a path, and reports -1 for one that is not on offer', () => {
    expect(workdirIndexOf(OPTIONS, '/home/u/workspace/shop-api')).toBe(2);
    expect(workdirIndexOf(OPTIONS, '/home/u/elsewhere')).toBe(-1);
    expect(workdirIndexOf(OPTIONS, undefined)).toBe(-1);
  });

  // The reason `/cd` is worth using on a phone at all: a workspace this size is ONE page on a
  // platform that declared it can carry twelve, so choosing a directory is a tap and not a hunt.
  it('honours a platform page size, and stops paging when the list fits one', () => {
    expect(workdirPageCount(OPTIONS.length, 12)).toBe(1);
    expect(workdirPageOf(7, 12)).toBe(0);
    const view = buildWorkdirMenu({ reqId: 'ab12cd34', options: OPTIONS, page: 0, pageSize: 12 });
    expect(picks(view.buttons)).toHaveLength(OPTIONS.length);
    expect(navs(view.buttons)).toEqual([]); // no ◀/▶ for a single page
    expect(view.pageCount).toBe(1);
  });

  it('keeps indices absolute at any page size', () => {
    const view = buildWorkdirMenu({ reqId: 'ab12cd34', options: OPTIONS, page: 1, pageSize: 3 });
    expect(picks(view.buttons)[0]!.id).toBe('wdr:ab12cd34:3');
    expect(view.pageCount).toBe(3);
  });
});

describe('menu rendering', () => {
  it('fills a page and carries absolute indices, so paging cannot re-point a button', () => {
    const first = picks(menu(0).buttons);
    const second = picks(menu(1).buttons);
    expect(first).toHaveLength(WORKDIR_PAGE_SIZE);
    expect(first[0]!.id).toBe('wdr:ab12cd34:0');
    // Second page starts where the first ended — not back at 0.
    expect(second[0]!.id).toBe(`wdr:ab12cd34:${WORKDIR_PAGE_SIZE}`);
    expect(second).toHaveLength(OPTIONS.length - WORKDIR_PAGE_SIZE);
  });

  it('marks the current directory, and the root when it is not the current one', () => {
    const labels = picks(menu(0, '/home/u/workspace/shop-api').buttons).map((b) => b.label);
    expect(labels).toContain('● shop-api');
    expect(labels).toContain('⌂ workspace');
    // The root is not double-marked when it IS the current directory: ● wins, because "where am I"
    // is what the reader is looking for.
    const atRoot = picks(menu(0, '/home/u/workspace').buttons).map((b) => b.label);
    expect(atRoot).toContain('● workspace');
    expect(atRoot).not.toContain('⌂ workspace');
  });

  it('wraps page navigation instead of hiding it at the edges', () => {
    // From the first page, ◀ goes to the last one; from the last, ▶ comes back to the first.
    expect(navs(menu(0).buttons).map((b) => b.id)).toEqual(['wdp:ab12cd34:1', 'wdp:ab12cd34:1']);
    expect(navs(menu(1).buttons).map((b) => b.id)).toEqual(['wdp:ab12cd34:0', 'wdp:ab12cd34:0']);
  });

  it('offers no navigation when everything fits on one page', () => {
    const one = buildWorkdirMenu({ reqId: 'r', options: OPTIONS.slice(0, 3), current: undefined, page: 0 });
    expect(navs(one.buttons)).toHaveLength(0);
  });

  it('wraps an out-of-range page rather than rendering an empty one', () => {
    expect(menu(7).page).toBe(1);
    expect(menu(-1).page).toBe(1);
    expect(picks(menu(7).buttons).length).toBeGreaterThan(0);
  });

  it('says what a tap will cost, on every page', () => {
    for (const page of [0, 1]) {
      expect(menu(page, '/home/u/workspace').text).toContain('starts a fresh session');
    }
  });
});

describe('button ids', () => {
  it('round-trips picks and page turns, and ignores other menus', () => {
    expect(parseWorkdirButtonId('wdr:ab12cd34:4')).toEqual({
      kind: 'pick',
      reqId: 'ab12cd34',
      index: 4,
    });
    expect(parseWorkdirButtonId('wdp:ab12cd34:1')).toEqual({
      kind: 'page',
      reqId: 'ab12cd34',
      page: 1,
    });
    // The model menu's ids, the settings menu's, and malformed ones are all somebody else's.
    expect(parseWorkdirButtonId('mdl:ab12cd34:4')).toBeNull();
    expect(parseWorkdirButtonId('stg:ab12cd34:0')).toBeNull();
    expect(parseWorkdirButtonId('wdr:ab12cd34:x')).toBeNull();
  });
});

describe('matching a typed query', () => {
  it('prefers an exact path over the substring that also contains it', () => {
    // The reason exact-first exists: shop-api's path is a prefix of shop-api-web'.
    const m = matchWorkdirs(OPTIONS, '/home/u/workspace/shop-api');
    expect(m.kind === 'one' && m.option.name).toBe('shop-api');
  });

  it('matches on name or path, case-insensitively', () => {
    const m = matchWorkdirs(OPTIONS, 'UNIAGENT');
    expect(m.kind === 'one' && m.option.path).toBe('/home/u/workspace/uniagent');
  });

  it('never guesses between candidates', () => {
    const m = matchWorkdirs(OPTIONS, 'shop-api');
    expect(m.kind).toBe('many');
    expect(m.kind === 'many' && m.matches).toHaveLength(2);
  });

  it('reports no match rather than falling back to the root', () => {
    expect(matchWorkdirs(OPTIONS, 'nowhere').kind).toBe('none');
    expect(workdirNoMatchText('nowhere')).toContain('nowhere');
  });

  it('lists the candidates as paths, which are what disambiguates them', () => {
    const text = workdirAmbiguousText('shop-api', OPTIONS.slice(2, 4));
    expect(text).toContain('/home/u/workspace/shop-api-web');
  });
});

describe('surface choice', () => {
  it('needs both button capabilities: a menu that cannot be edited cannot be paged or retired', () => {
    expect(workdirMenuSurface({ buttons: true, editButtons: true }, 8)).toBe('menu');
    expect(workdirMenuSurface({ buttons: true, editButtons: false }, 8)).toBe('text');
    expect(workdirMenuSurface({ buttons: false, editButtons: true }, 8)).toBe('text');
    // A capability object that omits the fields resolves to the safe surface.
    expect(workdirMenuSurface({}, 8)).toBe('text');
  });

  it('falls back to text when the only option is the directory already in use', () => {
    expect(workdirMenuSurface({ buttons: true, editButtons: true }, 1)).toBe('text');
  });
});

describe('the text surface', () => {
  it('names the current directory and what else there is', () => {
    const text = workdirSummaryText('/home/u/workspace', OPTIONS);
    expect(text).toContain('Working dir: /home/u/workspace');
    expect(text).toContain('/cd shop-api');
    expect(text).not.toContain('/cd workspace'); // the current one is not offered as a move
  });

  it('says so plainly when there is nowhere else to go', () => {
    const text = workdirSummaryText('/home/u/workspace', [OPTIONS[0]!]);
    expect(text).toContain('Nothing else on offer');
  });
});

describe('choice outcomes', () => {
  it('distinguishes a move from a re-pick of the current directory', () => {
    expect(workdirChoiceText({ kind: 'applied', path: '/p' })).toContain('fresh session');
    const unchanged = workdirChoiceText({ kind: 'unchanged', path: '/p' });
    expect(unchanged).toContain('nothing reset');
    expect(unchanged).not.toContain('fresh session');
  });

  it('gives every failure its own sentence', () => {
    expect(workdirChoiceText({ kind: 'missing', path: '/gone' })).toContain('no longer exists');
    expect(workdirChoiceText({ kind: 'rebound', agent: 'opencode' })).toContain('opencode');
    expect(workdirChoiceText({ kind: 'failed', reason: 'no store' })).toContain('no store');
  });
});
