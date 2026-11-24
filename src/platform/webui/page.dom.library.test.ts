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
  readRecord,
  type Harness,
} from './page.dom.test-helpers.js';

describe('webui page: the skills page', () => {
  const A = 'a1b2c3d4';
  const MD = '---\nname: deploy-check\ndescription: "Use when checking a deployment"\n---\n\n# Steps\n';
  const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'deploy-check',
    description: 'Use when checking a deployment',
    version: '0123456789ab',
    status: 'active',
    pinned: false,
    resident: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastUsedAt: '2026-11-02T00:00:00.000Z',
    uses: 3,
    agents: ['cc'],
    ...over,
  });
  const detail = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    skill: entry(),
    files: [
      { path: 'SKILL.md', size: MD.length },
      { path: 'references/api.md', size: 3 },
    ],
    file: { path: 'SKILL.md', content: MD, version: '0123456789ab' },
    history: [
      { id: 'c4f06d73eaad', at: '2026-11-02T00:00:00.000Z', action: 'patch', beforeVersion: '0123456789ab', afterVersion: 'fedcba987654' },
      { id: '9b1e2d3c4f5a', at: '2026-11-01T00:00:00.000Z', action: 'create' },
    ],
    ...over,
  });
  const list = (skills: Array<Record<string, unknown>> = [entry()]): Record<string, unknown> => ({ enabled: true, skills });
  const opReply = (skills: Array<Record<string, unknown>> = [entry()], d: Record<string, unknown> = detail()): Record<string, unknown> => ({
    ok: true,
    skills,
    detail: d,
  });

  it('opens from the sidebar footer and lists status, pin and last use', async () => {
    const h = await open({ replies: { 'api/skills': list([entry({ pinned: true })]) } });
    await h.emit(sync(A, [], [A]));
    expect(h.el('skills').hidden).toBe(true);

    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    expect(h.el('skills').hidden).toBe(false);
    expect(h.el('skills-title').textContent).toBe('Skills');
    const sw = h.doc.querySelector('[data-skill="deploy-check"] [data-sop="enabled"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.textContent).toBe('On');
    expect(h.el('skills-list').textContent).toContain('pinned');
    expect(h.el('skills-list').textContent).toContain('last used');
    expect(h.el('skills-list').textContent).toContain('3 uses');
  });

  it('marks a resident skill and its category, and warns about a description too long for it', async () => {
    const resident = entry({ name: 'server-ops', resident: true, category: '运维', warning: 'the description is 130 characters; a resident skill\'s is in every agent\'s context and should be at most 120' });
    const h = await open({ replies: { 'api/skills': list([entry(), resident]) } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('server-ops'));

    const card = (name: string): Element => h.doc.querySelector(`[data-skill="${name}"]`)!;
    const pressed = (name: string): string | null | undefined =>
      card(name).querySelector('[data-sop="tier"][aria-pressed="true"]')?.textContent;
    expect(card('server-ops').closest('[data-group]')!.getAttribute('data-group')).toBe('resident');
    expect(pressed('server-ops')).toBe('Resident');
    expect(card('server-ops').querySelector('.skill-cat')!.textContent).toBe('运维');
    expect(card('server-ops').querySelector('.skill-warn')!.textContent).toMatch(/130 characters/);
    expect(card('deploy-check').closest('[data-group]')!.getAttribute('data-group')).toBe('library');
    expect(pressed('deploy-check')).toBe('Library');
  });

  it('splits the list into Library and Resident tabs with their counts, off skills last in their tab', async () => {
    const h = await open({
      replies: {
        'api/skills': list([
          entry({ name: 'a-lib' }),
          entry({ name: 'b-res', resident: true }),
          entry({ name: 'c-off', status: 'archived', resident: true }),
          entry({ name: 'd-lib', status: 'expired' }),
        ]),
      },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('a-lib'));

    const tabs = [...h.doc.querySelectorAll('#skills-list [data-stab]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Library2', 'Resident2']);
    const pane = (k: string): Element => h.doc.querySelector(`#skills-list [data-pane="${k}"]`)!;
    const rows = (k: string, g: string): Array<string | null> =>
      [...pane(k).querySelectorAll(`[data-group="${g}"] [data-skill]`)].map((r) => r.getAttribute('data-skill'));
    expect((pane('library') as HTMLElement).hidden).toBe(false);
    expect((pane('resident') as HTMLElement).hidden).toBe(true);
    expect(rows('library', 'library')).toEqual(['a-lib', 'd-lib']);
    expect(rows('resident', 'resident')).toEqual(['b-res']);
    expect(rows('resident', 'off')).toEqual(['c-off']);

    (h.doc.querySelector('[data-stab="resident"]') as HTMLElement).click();
    expect((pane('resident') as HTMLElement).hidden).toBe(false);
    expect((pane('library') as HTMLElement).hidden).toBe(true);
    // An expired skill is still on — still delivered — and says why it may not stay that way.
    const expired = h.doc.querySelector('[data-skill="d-lib"]')!;
    expect(expired.querySelector('[data-sop="enabled"]')!.getAttribute('aria-checked')).toBe('true');
    expect(expired.querySelector('.skill-state.expired')!.textContent).toBe('Expired');
    // Off: the switch says so, and the tier is greyed rather than hidden — it is where the skill
    // comes back to, and the store would refuse to move an archived one anyway.
    const off = h.doc.querySelector('[data-skill="c-off"]')!;
    expect(off.querySelector('[data-sop="enabled"]')!.getAttribute('aria-checked')).toBe('false');
    expect(off.querySelector('[data-sop="enabled"]')!.textContent).toBe('Off');
    const tiers = [...off.querySelectorAll<HTMLButtonElement>('[data-sop="tier"]')];
    expect(tiers.map((b) => b.disabled)).toEqual([true, true]);
    expect(off.querySelector('[data-sop="tier"][aria-pressed="true"]')!.textContent).toBe('Resident');
  });

  it('lists the searches that found nothing, and the hits nobody opened', async () => {
    const searches = {
      misses: [{ at: '2026-11-06T00:00:00.000Z', query: 'rotate the vpn certificate', agent: 'cx', hits: [] }],
      unread: [{ at: '2026-11-06T00:00:00.000Z', query: 'deploy', hits: ['deploy-check'] }],
    };
    const h = await open({ replies: { 'api/skills': { ...list(), searches } } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    const text = h.el('skills-list').textContent!;
    expect(text).toContain('Searches that found nothing');
    expect(text).toContain('rotate the vpn certificate');
    expect(text).toContain('Found, but not opened');
    const rows = [...h.doc.querySelectorAll('.skill-search')].map((r) => r.textContent);
    expect(rows[1]).toContain('deploy-check');
  });

  it('makes a skill resident from its page, and back', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    const tier = (r: '1' | '0'): HTMLElement => h.el('skills-detail').querySelector(`[data-sop="tier"][data-resident="${r}"]`) as HTMLElement;
    expect(tier('0').getAttribute('aria-pressed')).toBe('true');
    expect(h.el('skills-count').textContent).toBe('Library');
    // The tier it is already in does nothing.
    tier('0').click();
    await tick();
    expect(h.calls.some((c) => c.body?.action === 'resident')).toBe(false);

    tier('1').click();
    await until('the tier op', () => h.calls.some((c) => c.body?.action === 'resident'));
    expect(h.calls.find((c) => c.body?.action === 'resident')?.body).toEqual({ action: 'resident', name: 'deploy-check', resident: true });
    // The page reads the skill again rather than trusting the switch it drew.
    await until('the re-read', () => h.calls.filter((c) => c.body?.action === 'show').length === 2);
  });

  it('moves a skill between resident and library from its row, without opening it', async () => {
    const resident = entry({ resident: true });
    const replies: Record<string, unknown> = { 'api/skills': list([resident]), 'api/skills/op': opReply([entry()]) };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    expect(h.doc.querySelector('[data-skill="deploy-check"]')!.closest('[data-group]')!.getAttribute('data-group')).toBe('resident');

    const pressed = (): string | null | undefined =>
      h.doc.querySelector('[data-skill="deploy-check"] [data-sop="tier"][aria-pressed="true"]')?.textContent;
    (h.doc.querySelector('[data-skill="deploy-check"] [data-sop="tier"][data-resident="0"]') as HTMLElement).click();
    // Switched on the tap, before any answer: with skills.repo set, the answer takes seconds.
    expect(pressed()).toBe('Library');
    await until('the tier op', () => h.calls.some((c) => c.body?.action === 'resident'));

    expect(h.calls.find((c) => c.body?.action === 'resident')?.body).toEqual({ action: 'resident', name: 'deploy-check', resident: false });
    expect(h.calls.some((c) => c.body?.action === 'show')).toBe(false);
    await tick();
    // The row stays in the tab it was drawn in, switched; it moves when the list is next drawn.
    expect(h.doc.querySelector('[data-skill="deploy-check"]')!.closest('[data-pane]')!.getAttribute('data-pane')).toBe('resident');
    expect(pressed()).toBe('Library');
    expect(h.el('skills-detail').hidden).toBe(true);
    expect(h.el('skills-list').hidden).toBe(false);
  });

  it('shows the store\'s refusal in sight of the row, and leaves the row as it was', async () => {
    const replies: Record<string, unknown> = {
      'api/skills': list(),
      'api/skills/op': {
        ok: false,
        error: "a resident skill's description is in every agent's context: at most 120 characters, this one is 134; shorten it and move the detail into the body",
      },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    const pressed = (): string | null | undefined => h.doc.querySelector('[data-skill="deploy-check"] [aria-pressed="true"]')?.textContent;
    (h.doc.querySelector('[data-skill="deploy-check"] [data-sop="tier"][data-resident="1"]') as HTMLElement).click();
    expect(pressed()).toBe('Resident');
    await until('the refusal', () => !h.el('skills-note').hidden);

    expect(h.el('skills-note').textContent).toMatch(/this one is 134/);
    // Put back as the store has it.
    await until('the switch back on Library', () => pressed() === 'Library');
    // Sticky, so it is seen from wherever in the list the switch was tapped.
    expect(renderPage('Chat', false)).toMatch(/#skills-note\{position:sticky;/);
  });

  it('opens a skill from its name, not from its switches', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    const row = h.doc.querySelector('[data-skill="deploy-check"]')!;
    // The row is not a button itself — it holds buttons — and the name is the one that opens it.
    expect(row.getAttribute('role')).toBeNull();
    (row.querySelector('.skill-open') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);
    expect(h.calls.find((c) => c.path === 'api/skills/op')?.body).toEqual({ action: 'show', name: 'deploy-check' });
  });

  it('says on the card why a hand-committed skill is not delivered', async () => {
    const broken = entry({ name: 'broken-one', problem: 'SKILL.md must start with a --- frontmatter block naming the skill and describing it' });
    const h = await open({ replies: { 'api/skills': list([entry(), broken]) } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('broken-one'));

    const card = (name: string): Element => h.doc.querySelector(`[data-skill="${name}"]`)!;
    expect(card('broken-one').querySelector('.skill-problem')!.textContent).toBe(
      'Not delivered: SKILL.md must start with a --- frontmatter block naming the skill and describing it'
    );
    expect(card('deploy-check').querySelector('.skill-problem')).toBeNull();
  });

  it('opens a skill with its files, editor and history', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    expect(h.calls.find((c) => c.path === 'api/skills/op')?.body).toEqual({ action: 'show', name: 'deploy-check' });
    expect(h.el('skills-detail').textContent).toContain('references/api.md');
    expect(h.el('skills-detail').textContent).toContain('patch');
    expect(h.el('skills-detail').textContent).toContain('Restore this version');
    expect((h.el('skill-text') as HTMLTextAreaElement).value).toBe(MD);
    expect((h.el('skill-path') as HTMLInputElement).value).toBe('SKILL.md');
    expect((h.el('skill-path') as HTMLInputElement).readOnly).toBe(true);
  });

  it('offers to undo a commit someone made in the repository by hand, and names who', async () => {
    const handMade = detail({
      history: [
        { id: 'abcdef123456', at: '2026-11-02T00:00:00.000Z', action: 'commit', author: 'noir', note: 'docs: rewrite by hand' },
        { id: '0123456789ab', at: '2026-11-01T00:00:00.000Z', action: 'create', author: 'fleetherd' },
        // Before 3.0.0 the gateway's commits were authored talkcode*: still its own, still unnamed.
        { id: '00000000abcd', at: '2026-10-01T00:00:00.000Z', action: 'patch', author: 'talkcode-web' },
      ],
    });
    const replies = { 'api/skills': list(), 'api/skills/op': opReply([entry()], handMade) };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    const rows = [...h.doc.querySelectorAll('.skill-hist')];
    expect(rows[0]!.textContent).toContain('noir');
    expect(rows[0]!.textContent).toContain('docs: rewrite by hand');
    expect(rows[0]!.querySelector('[data-revert="abcdef123456"]')).not.toBeNull();
    // The gateway's own name is not repeated on every row, and a first version has nothing to restore.
    expect(rows[1]!.textContent).not.toContain('fleetherd');
    expect(rows[1]!.querySelector('[data-revert]')).toBeNull();
    expect(rows[2]!.textContent).not.toContain('talkcode');
  });

  it('saves SKILL.md with the version the detail carried', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    const next = MD.replace('# Steps', '# Steps\n\nNew line');
    (h.el('skill-text') as HTMLTextAreaElement).value = next;
    (h.doc.querySelector('[data-sop="save"]') as HTMLElement).click();
    await until('the patch', () => h.calls.some((c) => c.body.action === 'patch'));

    expect(h.calls.find((c) => c.body.action === 'patch')?.body).toEqual({
      action: 'patch',
      name: 'deploy-check',
      version: '0123456789ab',
      content: next,
    });
  });

  it('writes a new reference file from the same editor', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    (h.doc.querySelector('[data-sop="new-file"]') as HTMLElement).click();
    (h.el('skill-path') as HTMLInputElement).value = 'references/runbook.md';
    (h.el('skill-text') as HTMLTextAreaElement).value = 'run it';
    (h.doc.querySelector('[data-sop="save"]') as HTMLElement).click();
    await until('the write', () => h.calls.some((c) => c.body.action === 'write-file'));

    expect(h.calls.find((c) => c.body.action === 'write-file')?.body).toEqual({
      action: 'write-file',
      name: 'deploy-check',
      file: 'references/runbook.md',
      content: 'run it',
    });
  });

  it('pins, unpins, and removes a reference file', async () => {
    const ref = { path: 'references/api.md', content: 'API', version: '0123456789ab' };
    const replies: Record<string, unknown> = {
      'api/skills': list(),
      'api/skills/op': opReply([entry()], detail({ file: ref })),
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    // Pin, then unpin. The reply flips between the two so the follow-up show draws the button the
    // operator would see; the assertions are on what the page POSTED, which is the decision.
    replies['api/skills/op'] = opReply([entry({ pinned: true })], detail({ skill: entry({ pinned: true }), file: ref }));
    (h.doc.querySelector('[data-sop="pin"]') as HTMLElement).click();
    await until('the pin', () => h.calls.some((c) => c.body.action === 'pin'));
    expect(h.calls.find((c) => c.body.action === 'pin')?.body).toEqual({ action: 'pin', name: 'deploy-check', pinned: true });
    await until('the Unpin button', () => h.doc.querySelector('[data-sop="pin"]')?.textContent === 'Unpin');

    replies['api/skills/op'] = opReply([entry({ pinned: false })], detail({ file: ref }));
    (h.doc.querySelector('[data-sop="pin"]') as HTMLElement).click();
    await until('the unpin', () => h.calls.filter((c) => c.body.action === 'pin').length === 2);
    expect(h.calls.filter((c) => c.body.action === 'pin')[1]?.body).toEqual({ action: 'pin', name: 'deploy-check', pinned: false });

    // The unpin's own show is still in flight until the button reads "Pin" again; the Remove
    // file control was already on screen from the previous detail, so waiting for it alone would
    // click while the page is still busy and the write would be dropped by design.
    await until('the Pin button back', () => h.doc.querySelector('[data-sop="pin"]')?.textContent === 'Pin');
    await until('the Remove file button', () => Boolean(h.doc.querySelector('[data-sop="remove-file"]')));
    (h.doc.querySelector('[data-sop="remove-file"]') as HTMLElement).click();
    await until('the remove-file', () => h.calls.some((c) => c.body.action === 'remove-file'));
    expect(h.confirms[0]).toContain('references/api.md');
    expect(h.calls.find((c) => c.body.action === 'remove-file')?.body).toEqual({
      action: 'remove-file',
      name: 'deploy-check',
      file: 'references/api.md',
    });
  });

  it('creates a skill from the New form', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    await h.click('#skills-new');
    (h.el('skill-new-name') as HTMLInputElement).value = 'release-check';
    (h.el('skill-new-desc') as HTMLInputElement).value = 'Use before a release';
    (h.el('skill-new-body') as HTMLTextAreaElement).value = '# Steps';
    (h.doc.querySelector('[data-sop="create"]') as HTMLElement).click();
    await until('the create', () => h.calls.some((c) => c.body.action === 'create'));

    expect(h.calls.find((c) => c.body.action === 'create')?.body).toEqual({
      action: 'create',
      name: 'release-check',
      description: 'Use before a release',
      body: '# Steps',
    });
  });

  it('reverts to a recorded version after a confirmation', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    (h.doc.querySelector('[data-revert]') as HTMLElement).click();
    await until('the revert', () => h.calls.some((c) => c.body.action === 'revert'));

    expect(h.confirms[0]).toContain('before this change');
    expect(h.calls.find((c) => c.body.action === 'revert')?.body).toEqual({
      action: 'revert',
      name: 'deploy-check',
      id: 'c4f06d73eaad',
    });
  });

  it('turns a skill off from its row in one tap — an archive — and on again', async () => {
    const archived = entry({ status: 'archived' });
    const replies: Record<string, unknown> = { 'api/skills': list(), 'api/skills/op': { ok: true, skills: [archived] } };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    const sw = (): HTMLElement => h.doc.querySelector('[data-skill="deploy-check"] [data-sop="enabled"]') as HTMLElement;

    sw().click();
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(sw().textContent).toBe('Off');
    await until('the archive', () => h.calls.some((c) => c.body?.action === 'archive'));
    expect(h.calls.find((c) => c.body?.action === 'archive')?.body).toEqual({ action: 'archive', name: 'deploy-check' });
    expect(h.calls.filter((c) => c.path === 'api/skills/op')).toHaveLength(1);
    await tick();
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(h.doc.querySelector('[data-skill="deploy-check"]')!.classList.contains('skill-off')).toBe(true);
    expect(h.el('skills-detail').hidden).toBe(true);

    // A second tap at once is not swallowed while the first is answered: it queues behind it.
    replies['api/skills/op'] = { ok: true, skills: [entry()] };
    sw().click();
    expect(sw().getAttribute('aria-checked')).toBe('true');
    await until('the restore', () => h.calls.some((c) => c.body?.action === 'restore'));
    expect(h.calls.find((c) => c.body?.action === 'restore')?.body).toEqual({ action: 'restore', name: 'deploy-check' });
    await tick();
    expect(sw().getAttribute('aria-checked')).toBe('true');
  });

  it('turns an archived skill on from its page, and stays on the page', async () => {
    const archived = entry({ status: 'archived' });
    const replies = {
      'api/skills': list([archived]),
      'api/skills/op': opReply([archived], detail({ skill: archived })),
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"] .skill-open') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);
    expect(h.el('skills-count').textContent).toBe('Off');
    expect(h.el('skills-detail').querySelector('[data-sop="archive"],[data-sop="restore"]')).toBeNull();

    (h.el('skills-detail').querySelector('[data-sop="enabled"]') as HTMLElement).click();
    await until('the restore', () => h.calls.some((c) => c.body?.action === 'restore'));
    expect(h.calls.find((c) => c.body?.action === 'restore')?.body).toEqual({ action: 'restore', name: 'deploy-check' });
    await until('the re-read', () => h.calls.filter((c) => c.body?.action === 'show').length === 2);
    expect(h.el('skills-detail').hidden).toBe(false);
  });

  it('closes on Escape and on the backdrop, and comes back to the list', async () => {
    const h = await open({ replies: { 'api/skills': list(), 'api/skills/op': opReply() } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"]') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    await h.click('#skills-back');
    expect(h.el('skills-detail').hidden).toBe(true);
    expect(h.el('skills-list').hidden).toBe(false);

    h.doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();
    expect(h.el('skills').hidden).toBe(true);

    await h.click('#skills-toggle');
    expect(h.el('skills').hidden).toBe(false);
    h.el('skills').click();
    await tick();
    expect(h.el('skills').hidden).toBe(true);
  });

  it('says when the daemon has no skills store instead of showing an empty list', async () => {
    const h = await open({ replies: { 'api/skills': { enabled: false, skills: [] } } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the disabled note', () => h.el('skills-list').textContent!.includes('not enabled'));

    expect(h.el('skills-list').textContent).toContain('Skills are not enabled in this daemon');
  });

  it('copies the name from a row and from the skill page, with a moment of feedback', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    const rowCopy = h.doc.querySelector('[data-skill="deploy-check"] [data-copy-skill]')!;
    expect(face(rowCopy)).toBe('[copy]');
    (rowCopy as HTMLElement).click();
    await tick();
    expect(h.clipboard).toEqual(['deploy-check']);
    expect(face(rowCopy)).toBe('[check]');
    // Copying is not opening: the row stayed on screen and the page did not move.
    expect(h.el('skills-detail').hidden).toBe(true);
    // The mark is a moment, not a new state: it goes back on its own.
    await within('the copy mark back', 3000, () => face(rowCopy) === '[copy]');

    (h.doc.querySelector('[data-skill="deploy-check"] .skill-open') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);
    const headCopy = h.el('skills-detail').querySelector('.skill-head [data-copy-skill]')!;
    (headCopy as HTMLElement).click();
    await tick();
    expect(h.clipboard).toEqual(['deploy-check', 'deploy-check']);
    // Copying is not opening: the row stayed put and the page did not move.
    expect(h.el('skills-detail').hidden).toBe(false);
  });

  it('falls back to the old copy command when the page has no clipboard API', async () => {
    const h = await open({ replies: { 'api/skills': list() } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    // A plain-http origin, which is exactly how this page is reached on a LAN.
    Object.defineProperty(h.window.navigator, 'clipboard', { configurable: true, value: undefined });
    let copied = '';
    (h.doc as unknown as { execCommand: (cmd: string) => boolean }).execCommand = (cmd: string) => {
      copied = (h.doc.querySelector('textarea[readonly]') as HTMLTextAreaElement | null)?.value ?? '';
      return cmd === 'copy';
    };

    const rowCopy = h.doc.querySelector('[data-skill="deploy-check"] [data-copy-skill]') as HTMLElement;
    rowCopy.focus();
    rowCopy.click();
    await tick();
    expect(copied).toBe('deploy-check');
    expect(h.clipboard).toEqual([]);
    expect(face(rowCopy)).toBe('[check]');
    // The temporary field is not left in the page, and the focus went back where it was.
    expect(h.doc.querySelector('textarea[readonly]')).toBeNull();
    expect(h.doc.activeElement).toBe(rowCopy);
  });

  it('says the copy failed when the fallback cannot copy, and leaves no field or focus behind', async () => {
    const h = await open({ replies: { 'api/skills': list() } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    Object.defineProperty(h.window.navigator, 'clipboard', { configurable: true, value: undefined });
    (h.doc as unknown as { execCommand: () => boolean }).execCommand = () => false;
    const rowCopy = h.doc.querySelector('[data-skill="deploy-check"] [data-copy-skill]') as HTMLElement;
    rowCopy.focus();
    rowCopy.click();
    await tick();
    expect(h.el('skills-note').hidden).toBe(false);
    expect(h.el('skills-note').textContent).toContain('Could not copy the name');
    expect(h.doc.querySelector('textarea[readonly]')).toBeNull();
    expect(h.doc.activeElement).toBe(rowCopy);

    // The same when the command throws: the field still goes, and the page says why.
    (h.doc as unknown as { execCommand: () => boolean }).execCommand = () => {
      throw new Error('execCommand refused');
    };
    rowCopy.click();
    await tick();
    expect(h.doc.querySelector('textarea[readonly]')).toBeNull();
    expect(h.doc.activeElement).toBe(rowCopy);
  });

  it('opens on the cached list and redraws it only when the store moved on', async () => {
    const held: Record<string, Promise<void>> = {};
    const replies: Record<string, unknown> = { 'api/skills': list() };
    const h = await open({ replies, held });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    await h.click('#skills-close');

    // The second open's refresh is held: what is on screen before it answers is the cache.
    let release!: () => void;
    held['api/skills'] = new Promise<void>((r) => { release = r; });
    await h.click('#skills-toggle');
    expect(h.el('skills-list').textContent).toContain('deploy-check');
    expect(h.el('skills-list').textContent).not.toContain('Loading');
    const row = h.doc.querySelector('[data-skill="deploy-check"]');

    // The same answer is not a change: the row drawn from the cache is left alone.
    release();
    await until('the silent refresh', () => !(h.el('skills-refresh') as HTMLButtonElement).disabled);
    expect(h.doc.querySelector('[data-skill="deploy-check"]')).toBe(row);

    // A different answer is, and the list is drawn again from it.
    await h.click('#skills-close');
    replies['api/skills'] = list([entry(), entry({ name: 'second-skill' })]);
    let release2!: () => void;
    held['api/skills'] = new Promise<void>((r) => { release2 = r; });
    await h.click('#skills-toggle');
    expect(h.el('skills-list').textContent).not.toContain('second-skill');
    release2();
    await until('the changed list', () => h.el('skills-list').textContent!.includes('second-skill'));
  });

  it('keeps a silent refresh quiet when it fails, and says so when the button asks', async () => {
    const replies = { 'api/skills': list() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    await h.click('#skills-close');

    h.status['api/skills'] = 500;
    await h.click('#skills-toggle');
    await until('the failed refresh', () => !(h.el('skills-refresh') as HTMLButtonElement).disabled);
    expect(h.el('skills-note').hidden).toBe(true);
    expect(h.el('skills-list').textContent).toContain('deploy-check');

    await h.click('#skills-refresh');
    await until('the failure note', () => !h.el('skills-note').hidden);
    expect(h.el('skills-note').textContent).toContain('Could not refresh skills');
    // The list the cache drew is still there to use.
    expect(h.el('skills-list').textContent).toContain('deploy-check');
  });

  it('refreshes the open skill from the button, but never over unsaved text', async () => {
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"] .skill-open') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);

    // Nothing typed: the page reads the skill again, and stays on it.
    await h.click('#skills-refresh');
    await until('the re-read', () => h.calls.filter((c) => c.body.action === 'show').length === 2);
    expect(h.el('skills-detail').hidden).toBe(false);

    // Typed into: the same button refreshes the list behind, and the text is not touched.
    (h.el('skill-text') as HTMLTextAreaElement).value = 'an unsaved draft';
    await h.click('#skills-refresh');
    await until('the second refresh', () => !(h.el('skills-refresh') as HTMLButtonElement).disabled);
    expect(h.calls.filter((c) => c.body.action === 'show')).toHaveLength(2);
    expect((h.el('skill-text') as HTMLTextAreaElement).value).toBe('an unsaved draft');
    expect(h.el('skills-detail').hidden).toBe(false);
  });

  it('refreshes behind an open skill without taking the page away', async () => {
    const held: Record<string, Promise<void>> = {};
    const replies: Record<string, unknown> = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies, held });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    await h.click('#skills-close');

    let release!: () => void;
    held['api/skills'] = new Promise<void>((r) => { release = r; });
    await h.click('#skills-toggle');
    (h.doc.querySelector('[data-skill="deploy-check"] .skill-open') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);
    const editor = h.el('skill-text');

    // The background answer names another skill: the list's data changes, the page does not.
    replies['api/skills'] = list([entry(), entry({ name: 'new-one' })]);
    release();
    await until('the refresh', () => !(h.el('skills-refresh') as HTMLButtonElement).disabled);
    expect(h.el('skills-detail').hidden).toBe(false);
    expect(h.el('skill-text')).toBe(editor);
    expect((h.el('skill-text') as HTMLTextAreaElement).value).toBe(MD);

    // It is there when the person goes back, because the data behind the page did change.
    await h.click('#skills-back');
    expect(h.el('skills-list').textContent).toContain('new-one');
  });

  it('carries the list across a reload, so the first open after one is not a wait', async () => {
    const h = await open({ replies: { 'api/skills': list() } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    const saved = h.window.localStorage.getItem('aa_skills');
    expect(saved).toContain('deploy-check');
    expect((JSON.parse(saved!) as { searches?: unknown }).searches).toBeUndefined();
    await h.click('#skills-close');

    // A new page, with the daemon slow to answer: the list is drawn from what the last page kept.
    const held: Record<string, Promise<void>> = {};
    let release!: () => void;
    held['api/skills'] = new Promise<void>((r) => { release = r; });
    const again = await open({ replies: {}, held, storage: { aa_skills: saved! } });
    await again.emit(sync(A, [], [A]));
    await again.click('#skills-toggle');
    expect(again.el('skills-list').textContent).toContain('deploy-check');
    expect(again.el('skills-list').textContent).not.toContain('Loading');

    // And the refresh still wins: this daemon has no skills store.
    release();
    await until('the answer', () => again.el('skills-list').textContent!.includes('No managed skills yet'));
  });

  it('drops a list answer a write made stale, and asks again once the write is done', async () => {
    const replies: Record<string, unknown> = {
      'api/skills': list(),
      'api/skills/op': { ok: true, skills: [entry({ status: 'archived' })] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    await h.click('#skills-close');

    // The next list request is answered with what the store said before the tap, after the tap.
    const real = h.window.fetch;
    let releaseOld!: () => void;
    let held = false;
    (h.window as any).fetch = (path: string, init?: any) => {
      if (path === 'api/skills' && !held) {
        held = true;
        return new Promise((resolve) => {
          releaseOld = () =>
            resolve({
              ok: true,
              status: 200,
              headers: { get: () => null },
              json: () => Promise.resolve(list()),
            });
        });
      }
      return real(path, init);
    };

    await h.click('#skills-toggle'); // cached list; its refresh is the held one
    const sw = (): HTMLElement => h.doc.querySelector('[data-skill="deploy-check"] [data-sop="enabled"]') as HTMLElement;
    sw().click();
    await until('the archive answer', () => h.calls.some((c) => c.body?.action === 'archive'));
    expect(sw().getAttribute('aria-checked')).toBe('false');

    // The store now has the archive; the held answer is what it said before the tap. The marker
    // row can only come from the replay, so it proves the stale answer was not applied.
    replies['api/skills'] = list([entry({ status: 'archived' }), entry({ name: 'after-write' })]);
    releaseOld();
    await until('the list asked again', () => h.el('skills-list').textContent!.includes('after-write'));
    const after = h.doc.querySelector('[data-skill="deploy-check"] [data-sop="enabled"]') as HTMLElement;
    expect(after.getAttribute('aria-checked')).toBe('false');
    const saved = JSON.parse(h.window.localStorage.getItem('aa_skills') || '{}') as { skills?: Array<{ name?: string; status?: string }> };
    expect(saved.skills?.find((s) => s.name === 'deploy-check')?.status).toBe('archived');
  });

  it('draws a refresh that arrived during a switch once the switch is done', async () => {
    const held: Record<string, Promise<void>> = {};
    const replies: Record<string, unknown> = {
      'api/skills': list(),
      'api/skills/op': { ok: true, skills: [entry({ status: 'archived' })] },
    };
    const h = await open({ replies, held });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    let release!: () => void;
    held['api/skills/op'] = new Promise<void>((r) => { release = r; });
    (h.doc.querySelector('[data-skill="deploy-check"] [data-sop="enabled"]') as HTMLElement).click();
    await until('the switch sent', () => h.calls.some((c) => c.body?.action === 'archive'));

    // The refresh names a row the page has not drawn yet, and it must not draw it over the tap.
    replies['api/skills'] = list([entry({ status: 'archived' }), entry({ name: 'after-write' })]);
    await h.click('#skills-refresh');
    await until('the refresh answered', () => !(h.el('skills-refresh') as HTMLButtonElement).disabled);
    expect(h.el('skills-list').textContent).not.toContain('after-write');

    // Once the tap's own answer is in, the held-back refresh is asked again and lands.
    release();
    await until('the replay', () => h.el('skills-list').textContent!.includes('after-write'));
    const sw = h.doc.querySelector('[data-skill="deploy-check"] [data-sop="enabled"]') as HTMLElement;
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('does not re-read a skill while its switch is still being written', async () => {
    const held: Record<string, Promise<void>> = {};
    const replies = { 'api/skills': list(), 'api/skills/op': opReply() };
    const h = await open({ replies, held });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    (h.doc.querySelector('[data-skill="deploy-check"] .skill-open') as HTMLElement).click();
    await until('the detail', () => !h.el('skills-detail').hidden);
    const shows = (): number => h.calls.filter((c) => c.body.action === 'show').length;
    expect(shows()).toBe(1);

    // The switch is in flight; a refresh now must not start a show beside the write's own reread.
    let release!: () => void;
    held['api/skills/op'] = new Promise<void>((r) => { release = r; });
    (h.el('skills-detail').querySelector('[data-sop="tier"][data-resident="1"]') as HTMLElement).click();
    await until('the switch sent', () => h.calls.some((c) => c.body.action === 'resident'));
    await h.click('#skills-refresh');
    await until('the refresh', () => !(h.el('skills-refresh') as HTMLButtonElement).disabled);
    expect(shows()).toBe(1);

    release();
    // The write's own reread, then the held refresh replayed: it is asked again and the page is
    // read once more on its answer.
    await until('the held refresh replayed', () => h.calls.filter((c) => c.path === 'api/skills').length >= 3);
    await until('both rereads', () => shows() === 3);
  });

  it('opens the skill again when a switch made the first show stale', async () => {
    const replies: Record<string, unknown> = {
      'api/skills': list(),
      'api/skills/op': { ok: true, skills: [entry({ status: 'archived' })] },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    // The first show is held; the switch's answer arrives before it.
    const real = h.window.fetch;
    let releaseShow!: () => void;
    let held = false;
    (h.window as any).fetch = (path: string, init?: any) => {
      const body = path === 'api/skills/op' && init?.body ? (JSON.parse(String(init.body)) as { action?: string }) : null;
      if (body?.action === 'show' && !held) {
        held = true;
        return new Promise((resolve) => {
          releaseShow = () =>
            resolve({
              ok: true,
              status: 200,
              headers: { get: () => null },
              // What the store said before the archive.
              json: () => Promise.resolve({ ok: true, skills: [entry()], detail: detail() }),
            });
        });
      }
      return real(path, init);
    };

    (h.doc.querySelector('[data-skill="deploy-check"] .skill-open') as HTMLElement).click();
    await tick();
    (h.doc.querySelector('[data-skill="deploy-check"] [data-sop="enabled"]') as HTMLElement).click();
    await until('the archive', () => h.calls.some((c) => c.body?.action === 'archive'));

    // The page the person asked for opens again once the write is done, with the write's state.
    replies['api/skills/op'] = {
      ok: true,
      skills: [entry({ status: 'archived' })],
      detail: detail({ skill: entry({ status: 'archived' }) }),
    };
    releaseShow();
    await until('the reopened page', () => !h.el('skills-detail').hidden);
    expect(h.el('skills-title').textContent).toBe('deploy-check');
    expect(h.el('skills-count').textContent).toBe('Off');
    expect(h.calls.filter((c) => c.body.action === 'show')).toHaveLength(1);
  });

  it('keeps the skill opened last when an older show answers after it', async () => {
    const a = entry({ name: 'a-skill' });
    const b = entry({ name: 'b-skill' });
    const da = detail({ skill: a, file: { path: 'SKILL.md', content: 'A', version: 'a' } });
    const db = detail({ skill: b, file: { path: 'SKILL.md', content: 'B', version: 'b' } });
    const replies: Record<string, unknown> = {
      'api/skills': list([a, b]),
      'api/skills/op': { ok: true, skills: [a, b], detail: db },
    };
    const h = await open({ replies });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('a-skill'));

    const real = h.window.fetch;
    let releaseA!: () => void;
    let held = false;
    (h.window as any).fetch = (path: string, init?: any) => {
      const body = path === 'api/skills/op' && init?.body ? (JSON.parse(String(init.body)) as { action?: string; name?: string }) : null;
      if (body?.action === 'show' && body.name === 'a-skill' && !held) {
        held = true;
        return new Promise((resolve) => {
          releaseA = () =>
            resolve({
              ok: true,
              status: 200,
              headers: { get: () => null },
              json: () => Promise.resolve({ ok: true, skills: [a, b], detail: da }),
            });
        });
      }
      return real(path, init);
    };

    (h.doc.querySelector('[data-skill="a-skill"] .skill-open') as HTMLElement).click();
    await tick();
    (h.doc.querySelector('[data-skill="b-skill"] .skill-open') as HTMLElement).click();
    await until('b opened', () => h.el('skills-title').textContent === 'b-skill');
    releaseA();
    await tick();
    await tick();
    expect(h.el('skills-title').textContent).toBe('b-skill');
    expect((h.el('skill-text') as HTMLTextAreaElement).value).toBe('B');
  });

  it('ignores a cache written by another shape, and a cached row that is not a skill', async () => {
    const held: Record<string, Promise<void>> = {};
    let release!: () => void;
    held['api/skills'] = new Promise<void>((r) => { release = r; });
    const h = await open({
      replies: { 'api/skills': list() },
      held,
      storage: { aa_skills: JSON.stringify({ v: 99, at: Date.now(), enabled: true, skills: [entry()] }) },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    expect(h.el('skills-list').textContent).toContain('Loading');
    expect(h.el('skills-list').textContent).not.toContain('deploy-check');
    release();
    await until('the list', () => h.el('skills-list').textContent!.includes('deploy-check'));

    const held2: Record<string, Promise<void>> = {};
    let release2!: () => void;
    held2['api/skills'] = new Promise<void>((r) => { release2 = r; });
    const again = await open({
      replies: { 'api/skills': list() },
      held: held2,
      storage: { aa_skills: JSON.stringify({ v: 1, at: Date.now(), enabled: true, skills: [{ name: 'deploy-check' }] }) },
    });
    await again.emit(sync(A, [], [A]));
    await again.click('#skills-toggle');
    expect(again.el('skills-list').textContent).toContain('Loading');
    release2();
    await until('the list', () => again.el('skills-list').textContent!.includes('deploy-check'));
  });

  it('keeps no cached list when the daemon has no skills store', async () => {
    const h = await open({ replies: { 'api/skills': { enabled: false, skills: [] } } });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the disabled note', () => h.el('skills-list').textContent!.includes('not enabled'));
    expect(h.window.localStorage.getItem('aa_skills')).toBeNull();
    await h.click('#skills-close');

    const held: Record<string, Promise<void>> = {};
    let release!: () => void;
    held['api/skills'] = new Promise<void>((r) => { release = r; });
    const again = await open({ replies: { 'api/skills': { enabled: false, skills: [] } }, held });
    await again.emit(sync(A, [], [A]));
    await again.click('#skills-toggle');
    expect(again.el('skills-list').textContent).toContain('Loading');
    release();
    await until('the note again', () => again.el('skills-list').textContent!.includes('not enabled'));
  });

  it('leaves the refresh button live during a silent refresh, and a tap makes it manual', async () => {
    const held: Record<string, Promise<void>> = {};
    const h = await open({ replies: { 'api/skills': list() }, held });
    await h.emit(sync(A, [], [A]));
    await h.click('#skills-toggle');
    await until('the skill list', () => h.el('skills-list').textContent!.includes('deploy-check'));
    await h.click('#skills-close');

    // The status is read when the request is made, so set it before the silent one leaves.
    h.status['api/skills'] = 500;
    let release!: () => void;
    held['api/skills'] = new Promise<void>((r) => { release = r; });
    await h.click('#skills-toggle');
    const btn = h.el('skills-refresh') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    await h.click('#skills-refresh');
    expect(btn.disabled).toBe(true);
    release();
    await until('the failure', () => !h.el('skills-note').hidden);
    expect(h.el('skills-note').textContent).toContain('Could not refresh skills');
  });
});

describe('webui page: the History tab', () => {
  const A = 'a1b2c3d4';
  const B = 'b2c3d4e5';
  const at = Date.UTC(2026, 10, 9, 12, 0);
  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 1,
    key: `webui#main#${A}`,
    title: 'Deploy notes',
    agent: 'cc',
    platform: 'webui',
    lastAt: at,
    messages: 4,
    topic: A,
    ...over,
  });
  const page = (sessions: Array<Record<string, unknown>>, next?: string): Record<string, unknown> => ({
    enabled: true,
    sessions,
    ...(next ? { next } : {}),
  });
  /** Two tool lines exactly as renderWebToolLines writes them. */
  const TOOLS =
    '<div class="tools"><div class="tl"><span class="tl-c">Bash: npm run deploy</span></div>' +
    '<div class="tl"><span class="tl-c">Read: notes.md</span></div></div>';
  /** A read in the shape room.ts historyMessages answers with: the transcript's own messages. */
  const read = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    session: row(),
    messages: [
      { id: 'h1', own: true, html: '<div class="raw">deploy it</div>', at, buttons: [], reactions: [] },
      { id: 'h2', own: false, html: TOOLS, at: at + 500, buttons: [], reactions: [], kind: 'tools' },
      { id: 'h3', own: false, html: '<p>deployed <strong>v2</strong></p>', at: at + 1_000, buttons: [], reactions: [] },
    ],
    ...over,
  });
  const topicList = (stages: Record<string, Record<string, unknown>> = {}): Array<Record<string, unknown>> =>
    [A, B].map((id, i) => ({ id, title: `Topic ${id}`, lastAt: 1000 - i, running: false, msgCount: 0, ...stages[id] }));

  /** Type a query and press Enter, the way a phone's search key does. */
  async function search(h: Harness, q: string): Promise<void> {
    const input = h.el('history-q') as HTMLInputElement;
    input.value = q;
    input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
  }

  /** The History tab, its first page on screen. */
  async function onHistory(h: Harness, until_ = 'Deploy notes'): Promise<void> {
    await h.click('#sb-tab-history');
    await until('the history list', () => h.el('history-list').textContent!.includes(until_));
  }

  /** One conversation opened from the list, read back into the transcript's place. */
  async function openRow(h: Harness, n = 0): Promise<void> {
    (h.doc.querySelectorAll('#history-list .hist-item')[n] as HTMLElement).click();
    await until('the conversation', () => h.el('lib-log').querySelector('.lib-head, .hist-note') !== null);
  }

  const libOn = (h: Harness): boolean => h.el('chat').classList.contains('lib');

  it('is a tab beside Topics in the sidebar header, and the list it shows replaces the topics', async () => {
    const h = await open({
      replies: {
        'api/history': page([row(), row({ id: 2, key: 'telegram#chat#9', title: 'Phone chat', agent: 'oc', platform: 'telegram', messages: 1, topic: undefined })]),
      },
    });
    await h.emit(sync(A, [], [A]));
    const title = h.doc.querySelector('#sidebar-header .panel-title')!;
    const tabs = [...title.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Topics', 'Starred', 'History']);
    expect(h.el('sb-tab-topics').getAttribute('aria-selected')).toBe('true');
    expect(h.el('history-pane').hidden).toBe(true);
    // The page never asks the library for anything until the tab is chosen.
    expect(h.calls.some((c) => c.path.startsWith('api/history'))).toBe(false);

    await onHistory(h);

    expect(h.el('sb-tab-history').getAttribute('aria-selected')).toBe('true');
    expect(h.el('sb-tab-history').classList.contains('on')).toBe(true);
    expect(h.el('history-pane').hidden).toBe(false);
    expect(h.el('topics').hidden).toBe(true);
    expect(h.el('topics-filter').hidden).toBe(true);
    // Clear all topics is about the other tab's list.
    expect(h.el('sidebar').classList.contains('on-history')).toBe(true);
    expect(renderPage('Chat', false)).toContain('#sidebar.on-history #clear-topics{display:none}');
    expect(h.el('history-count').textContent).toBe('2 conversations');
    const rows = [...h.doc.querySelectorAll('#history-list .hist-item')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Deploy notes');
    expect(rows[0]!.textContent).toContain('cc · webui');
    expect(rows[0]!.textContent).toContain('4 messages');
    expect(rows[1]!.textContent).toContain('Phone chat');
    expect(rows[1]!.textContent).toContain('oc · telegram');
    expect(h.el('history-more').hidden).toBe(true);

    // Back on Topics, the list is the topics again; the transcript was never touched.
    await h.click('#sb-tab-topics');
    expect(h.el('history-pane').hidden).toBe(true);
    expect(h.el('topics').hidden).toBe(false);
    expect(h.el('sidebar').classList.contains('on-history')).toBe(false);
  });

  it('reads the library again each time the tab is chosen, keeping the rows it has until the answer', async () => {
    const held: Record<string, Promise<void>> = {};
    const h = await open({ replies: { 'api/history': page([row()]) }, held });
    await h.emit(sync(A, [], [A]));
    await onHistory(h);
    const reads = (): number => h.calls.filter((c) => c.path === 'api/history').length;
    expect(reads()).toBe(1);

    // The second read is slow to answer.
    let answer!: () => void;
    held['api/history'] = new Promise<void>((r) => {
      answer = r;
    });
    await h.click('#sb-tab-topics');
    await h.click('#sb-tab-history');
    await until('the second read', () => reads() === 2);
    // No "Loading…" over a list that is already there: the old rows stand until the new ones land.
    expect(h.el('history-list').textContent).toContain('Deploy notes');
    expect(h.el('history-list').textContent).not.toContain('Loading');
    answer();
    await tick();
    // Choosing the tab it is already on is not a reason to ask again.
    await h.click('#sb-tab-history');
    await tick();
    expect(reads()).toBe(2);
  });

  it('pages backwards through the library from the button the daemon offers', async () => {
    const h = await open({
      replies: {
        'api/history': page([row(), row({ id: 2, title: 'Second' })], '1762300000000.2'),
        'api/history?before=1762300000000.2': page([row({ id: 3, title: 'Older still' })]),
      },
    });
    await h.emit(sync(A, [], [A]));
    await onHistory(h, 'Second');
    expect(h.el('history-count').textContent).toBe('2+ conversations');
    expect(h.el('history-more').hidden).toBe(false);

    await h.click('#history-more');
    await until('the second page', () => h.el('history-list').textContent!.includes('Older still'));

    // Appended, not replaced, and the last page offers no further one.
    expect([...h.doc.querySelectorAll('#history-list .hist-item')]).toHaveLength(3);
    expect(h.el('history-count').textContent).toBe('3 conversations');
    expect(h.el('history-more').hidden).toBe(true);
    expect(h.calls.some((c) => c.path === 'api/history?before=1762300000000.2')).toBe(true);
  });

  it('ignores Enter mid-composition, which is a candidate being chosen and not a search', async () => {
    const h = await open({ replies: { 'api/history': page([row()]) } });
    await h.emit(sync(A, [], [A]));
    await onHistory(h);
    const searches = (): number => h.calls.filter((c) => c.path.startsWith('api/history/search')).length;

    const input = h.el('history-q') as HTMLInputElement;
    input.value = '部署';
    const ev = new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
    input.dispatchEvent(ev);
    await tick();

    // The Enter that closes an IME candidate list is the composition's, not the field's.
    expect(searches()).toBe(0);
    expect(ev.defaultPrevented).toBe(false);

    input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick();
    expect(searches()).toBe(1);
  });

  it('counts "30+" when the daemon says the search carried fewer matches than the library has', async () => {
    const hits = Array.from({ length: 30 }, (_, i) => ({
      session: 1,
      message: i + 1,
      at,
      title: 'Deploy notes',
      agent: 'cc',
      platform: 'webui',
      role: 'user',
      excerpt: `deployment ${i}`,
    }));
    const h = await open({
      replies: { 'api/history': page([row()]), 'api/history/search?q=deployment': { enabled: true, hits, more: true } },
    });
    await h.emit(sync(A, [], [A]));
    await onHistory(h);

    await search(h, 'deployment');
    await until('the hits', () => h.doc.querySelectorAll('#history-list .hist-item').length === 30);
    // The number on screen is the size of the answer; the + says it is not the size of the result.
    expect(h.el('history-count').textContent).toBe('30+ matches');

    // A search the daemon did not call a floor keeps the plain number.
    const whole = await open({
      replies: { 'api/history': page([row()]), 'api/history/search?q=deployment': { enabled: true, hits } },
    });
    await whole.emit(sync(A, [], [A]));
    await onHistory(whole);
    await search(whole, 'deployment');
    await until('the hits', () => whole.doc.querySelectorAll('#history-list .hist-item').length === 30);
    expect(whole.el('history-count').textContent).toBe('30 matches');
  });

  it('keeps the page it already has when the next one cannot be read, and offers the button again', async () => {
    const next = 'api/history?before=1762300000000.2';
    const h = await open({
      replies: {
        'api/history': page([row(), row({ id: 2, title: 'Second' })], '1762300000000.2'),
        [next]: page([row({ id: 3, title: 'Older still' })]),
      },
      status: { [next]: 500 },
    });
    await h.emit(sync(A, [], [A]));
    await onHistory(h, 'Second');

    await h.click('#history-more');
    await until('the error', () => !h.el('history-err').hidden);

    // The rows already read stay: a page that failed is not a reason to throw them away.
    expect(h.el('history-list').textContent).toContain('Deploy notes');
    expect(h.el('history-list').textContent).toContain('Second');
    expect(h.el('history-err').textContent).toMatch(/HTTP 500/);
    expect(h.el('history-more').hidden).toBe(false);
    expect((h.el('history-more') as HTMLButtonElement).disabled).toBe(false);

    // And it works when the daemon answers: the same button, the page appended, the error gone.
    h.status[next] = 200;
    await h.click('#history-more');
    await until('the second page', () => h.el('history-list').textContent!.includes('Older still'));
    expect(h.el('history-err').hidden).toBe(true);
    expect([...h.doc.querySelectorAll('#history-list .hist-item')]).toHaveLength(3);
  });

  it('puts a failed page under the list, beside the button that asked for it', async () => {
    const next = 'api/history?before=1762300000000.2';
    const h = await open({
      replies: {
        'api/history': page([row(), row({ id: 2, title: 'Second' })], '1762300000000.2'),
        [next]: page([row({ id: 3, title: 'Older still' })]),
      },
      status: { [next]: 500 },
    });
    await h.emit(sync(A, [], [A]));
    await onHistory(h, 'Second');

    await h.click('#history-more');
    await until('the error', () => !h.el('history-err').hidden);

    // jsdom does no layout, so the DOM order is the evidence: the error follows the list and sits
    // immediately above the button. That is where a reader who tapped it at the bottom of fifty
    // rows is looking; above the list, the same line was 2550px out of view on a phone.
    const err = h.el('history-err');
    expect(err.parentElement).toBe(h.el('history-body'));
    expect(h.el('history-list').compareDocumentPosition(err) & h.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(err.nextElementSibling).toBe(h.el('history-more'));

    // Failing twice changes nothing: the same line, and the button offers the same page again.
    await h.click('#history-more');
    await until('the second failure', () => !h.el('history-err').hidden && !(h.el('history-more') as HTMLButtonElement).disabled);
    expect(err.textContent).toMatch(/HTTP 500/);
  });

  it('searches the library, and puts the list back when the field is cleared', async () => {
    const h = await open({
      replies: {
        'api/history': page([row()]),
        'api/history/search?q=deployment': {
          enabled: true,
          hits: [
            { session: 1, message: 4, at, title: 'Deploy notes', agent: 'cc', platform: 'webui', role: 'user', excerpt: 'the deployment finished' },
          ],
        },
      },
    });
    await h.emit(sync(A, [], [A]));
    await onHistory(h);

    await search(h, 'deployment');
    await until('the hit', () => h.el('history-list').textContent!.includes('the deployment finished'));

    expect(h.calls.some((c) => c.path === 'api/history/search?q=deployment')).toBe(true);
    expect(h.el('history-count').textContent).toBe('1 match');
    expect(h.doc.querySelector('#history-list .hist-excerpt')!.textContent).toBe('the deployment finished');

    // The field's own × leaves an empty value: the library comes back, not the last search.
    const input = h.el('history-q') as HTMLInputElement;
    input.value = '';
    input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    await tick();
    expect(h.doc.querySelector('#history-list .hist-excerpt')).toBeNull();
    expect(h.el('history-list').textContent).toContain('Deploy notes');
    expect(h.el('history-count').textContent).toBe('1 conversation');
  });

  it('opens a conversation where the transcript is, drawn with the transcript’s own bubbles', async () => {
    const h = await open({
      replies: { 'api/history': page([row()]), 'api/history/read?id=1': read() },
    });
    // The topic underneath holds a tool bubble of its own, the same two lines.
    await h.emit(sync(B, [{ ...message('w1', TOOLS), kind: 'tools' }], [A, B]));
    await onHistory(h);
    await openRow(h);

    expect(h.calls.some((c) => c.path === 'api/history/read?id=1')).toBe(true);
    expect(libOn(h)).toBe(true);
    expect(h.el('lib-title').textContent).toBe('Deploy notes');
    expect(h.doc.querySelector('#history-list .hist-item')!.classList.contains('on')).toBe(true);
    const head = h.el('lib-log').querySelector('.lib-head')!;
    expect(head.textContent).toContain('cc · webui');
    expect(head.textContent).toContain('4 messages');
    expect(head.textContent).toContain(`webui#main#${A}`);

    const bubbles = [...h.el('lib-log').querySelectorAll('.m')];
    expect(bubbles).toHaveLength(3);
    expect(bubbles[0]!.className).toBe('m own');
    expect(bubbles[0]!.querySelector('.b .raw')!.textContent).toBe('deploy it');
    expect(bubbles[2]!.querySelector('.b strong')!.textContent).toBe('v2');
    // The same bubble as the transcript draws, from the same markup: class, body and folding.
    const live = h.el('log').querySelector('[data-k="1:w1"]')!;
    const lib = h.el('lib-log').querySelector('[data-k="h:h2"]')!;
    expect(lib.className).toBe(live.className);
    expect(lib.querySelector('.b')!.innerHTML).toBe(live.querySelector('.b')!.innerHTML);
    expect(lib.querySelector('.tl-all')!.textContent).toBe('Show all');

    // A line opens and folds as it does in a topic, and only this bubble's.
    (lib.querySelector('.tl') as HTMLElement).click();
    expect(h.el('lib-log').querySelector('[data-k="h:h2"] .tl')!.classList.contains('open')).toBe(true);
    expect(h.el('log').querySelector('[data-k="1:w1"] .tl')!.classList.contains('open')).toBe(false);
    (h.el('lib-log').querySelector('[data-k="h:h2"] .tl-all') as HTMLElement).click();
    expect(h.el('lib-log').querySelector('[data-k="h:h2"] .tl-all')!.textContent).toBe('Collapse');

    // The topic underneath is still there, untouched, for the way back.
    expect(h.painted()).toBe(1);
    // And the stylesheet takes the composer, the header's topic controls and the terminal's
    // divider away while it is up — as text, because jsdom's CSSOM is not to be trusted with
    // this (see Testing). The terminal itself is only parked: a record is no reason to hang up
    // on a shell, so its frame keeps its box under the record.
    expect(renderPage('Chat', false)).toContain(
      '#chat.lib #log,#chat.lib #typing,#chat.lib #note,#chat.lib #bar,#chat.lib #term-grip,\n' +
        '#chat.lib #topic-title,#chat.lib #topic-status,#chat.lib #kill-agent,#chat.lib #term-toggle,#chat.lib #files-toggle,\n' +
        '#chat.lib #fork-note{display:none}'
    );
    expect(renderPage('Chat', false)).toContain(
      '#chat.lib #term{position:absolute;left:0;right:0;bottom:0;visibility:hidden;pointer-events:none}'
    );
  });

  it('parks the terminal while a record covers the chat, and shows it again on the way out', async () => {
    // The frame's own rule says `visibility:visible`, and that beats anything the panel inherits
    // — so a CSS rule on #term leaves the terminal painted over the record, visible and
    // unclickable. The record has to take the frame out of `on`, which is paintFrames' job.
    const h = await open({
      terminal: true,
      replies: { 'api/history': page([row()]), 'api/history/read?id=1': read() },
    });
    await h.emit(sync(A, [], [A]));
    await h.click('#term-toggle');
    const frame = h.doc.querySelector('#term-frames iframe.on');
    expect(frame).not.toBeNull();
    expect(h.el('term').hasAttribute('inert')).toBe(false);

    await onHistory(h);
    await openRow(h);
    expect(libOn(h)).toBe(true);
    // Boolean, not the element: a failure should say what happened, not try to print a jsdom frame.
    expect(Boolean(h.doc.querySelector('#term-frames iframe.on'))).toBe(false);
    // Invisible is not enough on its own: an iframe can still be focused from script.
    expect(h.el('term').hasAttribute('inert')).toBe(true);

    await h.click('#lib-close');
    expect(libOn(h)).toBe(false);
    expect(h.doc.querySelector('#term-frames iframe.on') === frame).toBe(true);
    expect(h.el('term').hasAttribute('inert')).toBe(false);
  });

  it('measures the panel again when a record closes, rather than under it', async () => {
    // #bar and the divider are display:none while a record is up, so they measure 0. A resize
    // there used to work out a ceiling ~100px too generous and leave the panel at that height
    // after the record went — on a phone turned sideways, the log a few pixels tall.
    const h = await open({
      terminal: true,
      replies: { 'api/history': page([row()]), 'api/history/read?id=1': read() },
    });
    await h.emit(sync(A, [], [A]));
    const stub = (id: string, prop: string, value: number): void => {
      Object.defineProperty(h.el(id), prop, { configurable: true, get: () => value });
    };
    stub('chat', 'clientHeight', 800);
    stub('chat-header', 'clientHeight', 50);
    stub('bar', 'clientHeight', 100);
    stub('term-grip', 'offsetHeight', 9);
    await h.click('#term-toggle');
    expect(h.el('term').style.height).toBe('400px');

    await onHistory(h);
    await openRow(h);
    // The record takes the composer and the divider off screen, and the window shrinks.
    stub('bar', 'clientHeight', 0);
    stub('term-grip', 'offsetHeight', 0);
    stub('chat', 'clientHeight', 500);
    h.window.dispatchEvent(new h.window.Event('resize'));
    await tick();
    // Nothing to measure against: the panel keeps the height it had, out of sight.
    expect(h.el('term').style.height).toBe('400px');

    // Back on screen both have their heights again, and the panel is measured once more:
    // 500 - (50 header + 100 composer + 9 divider + 120 transcript) = 221.
    stub('bar', 'clientHeight', 100);
    stub('term-grip', 'offsetHeight', 9);
    await h.click('#lib-close');
    expect(h.el('term').style.height).toBe('221px');
  });

  it('says a read was cut short where the reader lands, and says nothing when it was not', async () => {
    const note = 'This conversation is longer than the 500 messages this page reads; only the first 500 are shown.';
    const h = await open({
      replies: {
        'api/history': page([row(), row({ id: 2, title: 'Whole' })]),
        'api/history/read?id=1': read({ note }),
        'api/history/read?id=2': read({ session: row({ id: 2, title: 'Whole' }) }),
      },
    });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h);
    await openRow(h);

    // In the bar where the composer was, under the last message read — not above a transcript the
    // reader lands at the bottom of.
    expect(h.el('lib-note').hidden).toBe(false);
    expect(h.el('lib-note').textContent).toBe(note);
    expect(h.el('lib-note').parentElement).toBe(h.el('lib-bar'));

    (h.doc.querySelectorAll('#history-list .hist-item')[1] as HTMLElement).click();
    await until('the second conversation', () => h.el('lib-title').textContent === 'Whole');
    expect(h.el('lib-note').hidden).toBe(true);
    expect(h.doc.querySelectorAll('#history-list .hist-item.on')).toHaveLength(1);
  });

  it('says why nothing can be sent, and takes the reader into the topic while this page has it', async () => {
    const h = await open({ replies: { 'api/history': page([row()]), 'api/history/read?id=1': read() } });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h);
    await openRow(h);

    expect(h.el('lib-why').textContent).toMatch(/^Read-only: .*still a topic on this page/);
    expect(h.el('lib-topic').hidden).toBe(false);

    await h.click('#lib-topic');
    await until('the switch', () => h.window.location.search.includes(A));
    expect(libOn(h)).toBe(false);
    // The sidebar follows: the row to come back to is in the Topics list.
    expect(h.el('sb-tab-topics').getAttribute('aria-selected')).toBe('true');
    expect(h.el('history-pane').hidden).toBe(true);
  });

  it('takes the way into a topic away when the topic is gone, and names the other platform', async () => {
    const h = await open({
      replies: {
        'api/history': page([row(), row({ id: 2, key: 'telegram#chat#9', title: 'Phone chat', platform: 'telegram', topic: undefined })]),
        'api/history/read?id=1': read(),
        'api/history/read?id=2': read({ session: row({ id: 2, key: 'telegram#chat#9', title: 'Phone chat', platform: 'telegram', topic: undefined }) }),
      },
    });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h);
    await openRow(h);
    expect(h.el('lib-topic').hidden).toBe(false);

    // The topic is deleted while its record is on screen: the list changes, and the button goes.
    await h.emit({ t: 'topics', topics: topicList().filter((t) => t.id !== A) });
    expect(h.el('lib-topic').hidden).toBe(true);
    expect(h.el('lib-why').textContent).toMatch(/cleared from this page/);

    (h.doc.querySelectorAll('#history-list .hist-item')[1] as HTMLElement).click();
    await until('the other platform', () => h.el('lib-title').textContent === 'Phone chat');
    expect(h.el('lib-topic').hidden).toBe(true);
    expect(h.el('lib-why').textContent).toMatch(/ran on telegram/);
  });

  it('goes back to the conversation underneath from Close, from the Topics tab and from any topic', async () => {
    const h = await open({ replies: { 'api/history': page([row()]), 'api/history/read?id=1': read() } });
    await h.emit(sync(B, [message('w1', '<p>underneath</p>')], [A, B]));
    await onHistory(h);

    await openRow(h);
    await h.click('#lib-close');
    expect(libOn(h)).toBe(false);
    expect(h.el('lib-log').innerHTML).toBe('');
    // Close leaves the list where it was; the row is no longer lit.
    expect(h.el('history-pane').hidden).toBe(false);
    expect(h.doc.querySelector('#history-list .hist-item.on')).toBeNull();

    await openRow(h);
    // A message that reaches the covered topic lands in it, for when it is shown again.
    await h.emit({ t: 'msg', topic: B, msg: message('w2', '<p>meanwhile</p>') });
    await h.click('#sb-tab-topics');
    expect(libOn(h)).toBe(false);
    expect(h.el('log').textContent).toContain('meanwhile');

    // Into a topic from the record itself, even the one that was underneath all along.
    await onHistory(h);
    await openRow(h);
    h.el('lib-topic').click();
    await tick();
    expect(libOn(h)).toBe(false);
    expect(h.window.location.search).toContain(A);
  });

  it('follows a link to a topic out of the conversation, including one to the topic underneath', async () => {
    const link = (id: string): Record<string, unknown> =>
      read({
        messages: [{ id: 'h1', own: false, html: `<p>see <a href="?t=${id}" data-goto="${id}">the plan</a></p>`, at, buttons: [], reactions: [], kind: 'dispatch' }],
      });
    const h = await open({ replies: { 'api/history': page([row(), row({ id: 2, title: 'Second' })]), 'api/history/read?id=1': link(A), 'api/history/read?id=2': link(A) } });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h, 'Second');

    await openRow(h);
    (h.el('lib-log').querySelector('a[data-goto]') as HTMLElement).click();
    await until('the switch', () => h.window.location.search.includes(A));
    expect(libOn(h)).toBe(false);
    await opens(h, `api/events?t=${A}`);

    // A link to the topic already underneath: nothing to switch to, but the view still has to go.
    await h.emit(sync(A, [message('w1', '<p>underneath</p>')], [A, B]));
    const streams = h.streams.length;
    (h.doc.querySelectorAll('#history-list .hist-item')[1] as HTMLElement).click();
    await until('the second conversation', () => libOn(h) && h.el('lib-log').querySelector('a[data-goto]') !== null);
    (h.el('lib-log').querySelector('a[data-goto]') as HTMLElement).click();
    await tick();
    expect(libOn(h)).toBe(false);
    expect(h.window.location.search).toBe(`?t=${A}`);
    expect(h.el('log').textContent).toContain('underneath');
    // Shown again, not entered again: the same stream, no new sync asked for.
    expect(h.streams.length).toBe(streams);
  });

  it('keeps the title in a phone’s header: the tag is its icon there', () => {
    const at640 = renderPage('Chat', false);
    const block = at640.slice(at640.indexOf('@media(max-width:640px){'));
    expect(block).toContain('.lib-tag-word{display:none}');
  });

  it('marks nothing seen and takes no paste for the topic it covers', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${B}`, replies: { 'api/history': page([row()]), 'api/history/read?id=1': read() } });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h);
    await openRow(h);
    const seen = (): number => h.calls.filter((c) => c.path === 'api/seen').length;

    // The topic underneath finishes a reply nobody can see.
    await h.emit({ t: 'topics', topics: topicList({ [B]: { stage: 'review' } }) });
    expect(seen()).toBe(0);

    // A screenshot pasted now would go, unseen, into that topic's composer.
    const file = new h.window.File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });
    const ev = new h.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } });
    h.doc.body.dispatchEvent(ev);
    await tick();
    expect(ev.defaultPrevented).toBe(false);
    // Nor a file dropped on the page.
    const drop = new h.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } });
    h.doc.body.dispatchEvent(drop);
    // A file is read over several turns before its chip is drawn; give it them.
    for (let i = 0; i < 20; i++) await tick();
    expect(h.el('chips').children).toHaveLength(0);

    // Uncovered, it is read — and only then.
    await h.click('#lib-close');
    expect(h.calls.filter((c) => c.path === 'api/seen').map((c) => c.body)).toEqual([{ topic: B }]);
  });

  it('on a phone: a picked conversation closes the drawer, and the drawer’s Topics tab brings the topic back', async () => {
    const h = await open({ width: 390, height: 844, replies: { 'api/history': page([row()]), 'api/history/read?id=1': read() } });
    await h.emit(sync(B, [message('w1', '<p>underneath</p>')], [A, B]));
    await h.click('#expand-sidebar');
    await onHistory(h);
    // The tab is chosen inside the drawer; the drawer stays out until something is picked.
    expect(h.el('sidebar').classList.contains('collapsed')).toBe(false);

    await openRow(h);
    expect(libOn(h)).toBe(true);
    expect(h.el('sidebar').classList.contains('collapsed')).toBe(true);
    expect(h.el('app').classList.contains('sb-open')).toBe(false);

    // Back in, the drawer is where it was left: on History, with the row lit.
    await h.click('#expand-sidebar');
    expect(h.el('history-pane').hidden).toBe(false);
    expect(h.doc.querySelector('#history-list .hist-item.on')).not.toBeNull();
    await h.click('#sb-tab-topics');
    expect(libOn(h)).toBe(false);
    expect(h.el('topics').hidden).toBe(false);
    expect(h.el('log').textContent).toContain('underneath');
  });

  it('does not remember the tab or the conversation: a reload opens on Topics, on the topic in the address', async () => {
    const h = await open({ url: `http://localhost:8787/?t=${B}`, replies: { 'api/history': page([row()]), 'api/history/read?id=1': read() } });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h);
    await openRow(h);
    // The address still names the topic underneath: ?t= is what links and notifications open.
    expect(h.window.location.search).toBe(`?t=${B}`);
    const storage: Record<string, string> = {};
    for (let i = 0; i < h.window.localStorage.length; i++) {
      const k = h.window.localStorage.key(i)!;
      storage[k] = h.window.localStorage.getItem(k)!;
    }

    const again = await open({ url: `http://localhost:8787/?t=${B}`, storage });
    await again.emit(sync(B, [], [A, B]));
    expect(again.el('sb-tab-topics').getAttribute('aria-selected')).toBe('true');
    expect(again.el('history-pane').hidden).toBe(true);
    expect(again.el('chat').classList.contains('lib')).toBe(false);
  });

  it('says a conversation could not be read, and keeps the way out', async () => {
    const h = await open({
      replies: { 'api/history': page([row()]), 'api/history/read?id=1': { error: 'no conversation "1"; `fleetherd sessions list` shows the ids' } },
      status: { 'api/history/read?id=1': 404 },
    });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h);
    await openRow(h);

    expect(h.el('lib-log').querySelector('.hist-note.bad')!.textContent).toMatch(/no conversation "1"/);
    expect(h.el('lib-topic').hidden).toBe(true);
    await h.click('#lib-close');
    expect(libOn(h)).toBe(false);
  });

  it('creates a new topic into the Topics tab', async () => {
    const h = await open({ replies: { 'api/history': page([row()]) } });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h);
    await h.click('#new-topic');
    expect(h.el('sb-tab-topics').getAttribute('aria-selected')).toBe('true');
    expect(h.el('topics').hidden).toBe(false);
  });

  it('copies a history conversation reference from the list row and from the open reader header', async () => {
    const replies = {
      'api/history': page([row({ id: 42, title: 'Deploy rollback', platform: 'telegram', topic: undefined })]),
      'api/history/read?id=42': {
        session: row({ id: 42, title: 'Deploy rollback', platform: 'telegram', topic: undefined }),
        messages: [],
      },
    };
    const h = await open({ replies });
    await h.emit(sync(B, [], [A, B]));
    await onHistory(h, 'Deploy rollback');

    const rowCopy = h.doc.querySelector('[data-hist="42"] [data-hist-copy]') as HTMLElement;
    expect(rowCopy).not.toBeNull();
    rowCopy.click();
    await tick();
    expect(h.clipboard).toEqual(['Deploy rollback (#42)']);
    expect(rowCopy.querySelector('.ic-check')).not.toBeNull();
    // Clicking the row copy button must not open the conversation.
    expect(libOn(h)).toBe(false);

    await openRow(h, 0);
    expect(h.el('copy-ref').hidden).toBe(false);
    await h.click('#copy-ref');
    await tick();
    expect(h.clipboard).toEqual(['Deploy rollback (#42)', 'Deploy rollback (#42)']);

    await h.click('#lib-close');
    await h.click('#copy-ref');
    await tick();
    expect(h.clipboard[2]).toContain(`(web:main/${B})`);
  });

  it('says when the daemon has no conversation library', async () => {
    const h = await open({ replies: { 'api/history': { enabled: false, sessions: [] } } });
    await h.emit(sync(A, [], [A]));
    await h.click('#sb-tab-history');
    await until('the disabled note', () => h.el('history-list').textContent!.includes('no conversation library'));

    expect(h.el('history-count').textContent).toBe('');
    expect(h.el('history-more').hidden).toBe(true);
  });
});

/**
 * What a turn changed, under its reply (daemon/turn-changes.ts, WebMessage.turnChanges).
 *
 * The entry is a control that opens the git panel's window, and that window is another file's
 * (`window.openGitWindow`). So there are two states worth pinning: a page that has it draws the
 * entry and calls it with the turn's two URLs, and a page that does not must draw nothing at all —
 * a button that opens nothing is worse than no button.
 */
describe('the page: a turn’s changes', () => {
  const A = 'a1b2c3d4';
  const withChanges = (id: string, turn: number) => ({
    ...message(id, '<p>done</p>'),
    turnChanges: { turn, files: 3, additions: 12, deletions: 4 },
  });

  it('shows the counts under the reply and opens the window on the turn', async () => {
    const h = await open();
    const opened: Array<Record<string, unknown>> = [];
    (h.window as unknown as { openGitWindow: (o: Record<string, unknown>) => void }).openGitWindow = (o) => opened.push(o);
    await h.emit(sync(A, [withChanges('w1', 2)], [A]));

    const row = h.doc.querySelector('.tc button[data-turns]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('3 files changed');
    expect(row?.textContent).toContain('+12');
    expect(row?.textContent).toContain('-4');
    expect(h.doc.querySelector('.tc .ic-diff')).not.toBeNull();

    await h.click('button[data-turns]');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ title: 'Turn 2 changes' });
    expect(String(opened[0]!.statusUrl)).toBe(`api/turn-changes/status?t=${A}&turn=2`);
    expect(String(opened[0]!.fileUrl)).toBe(`api/turn-changes/file?t=${A}&turn=2`);
  });

  it('draws nothing at all when the page has no window to open', async () => {
    const h = await open();
    // The page carries the git window; take it away to stand for a page served without one.
    delete (h.window as unknown as { openGitWindow?: unknown }).openGitWindow;
    await h.emit(sync(A, [withChanges('w1', 2)], [A]));
    expect(h.el('log').textContent).toContain('done');
    expect(h.doc.querySelector('.tc')).toBeNull();
    expect(h.doc.querySelector('button[data-turns]')).toBeNull();
  });

  it('opens the real git window on the turn, and reads a file through the turn’s own route', async () => {
    const status = `api/turn-changes/status?t=${A}&turn=2`;
    const file = `api/turn-changes/file?t=${A}&turn=2&path=src%2Fa.ts`;
    const h = await open({
      replies: {
        [status]: {
          ok: true,
          repo: { root: '/srv/project' },
          files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }],
        },
        [file]: {
          ok: true,
          path: 'src/a.ts',
          status: 'modified',
          original: 'one\n',
          modified: 'two\n',
          patch: '@@ -1 +1 @@\n-one\n+two\n',
        },
      },
    });
    await h.emit(sync(A, [withChanges('w1', 2)], [A]));
    await h.click('button[data-turns]');
    await until('the turn’s list', () => h.el('git-files').querySelectorAll('.git-file').length === 1);
    expect(h.el('git-title').textContent).toBe('Turn 2 changes');
    expect(h.el('git-modes').hidden).toBe(true);
    await h.click('[data-gpath="src/a.ts"]');
    // One path= and the encoded name: the entry hands over the bare route, the window appends.
    await until('the turn’s file', () => h.calls.some((c) => c.path === file));
    await until('the patch', () => Boolean(h.el('git-diff').querySelector('.git-patch')));
    expect(h.el('git-diff').textContent).toContain('+two');
  });

  it('is still there after a reconnect, and the browser’s copy keeps it for a reload', async () => {
    const h = await open();
    (h.window as unknown as { openGitWindow: (o: Record<string, unknown>) => void }).openGitWindow = () => {};
    await h.emit(sync(A, [withChanges('w1', 4)], [A]));
    expect(h.doc.querySelectorAll('.tc button[data-turns]')).toHaveLength(1);

    // A dropped stream comes back as a full sync with the same room in it — what the daemon kept.
    await h.emit(sync(A, [withChanges('w1', 4)], [A]));
    expect(h.doc.querySelectorAll('.tc button[data-turns]')).toHaveLength(1);

    // And the cache the next visit reads holds the entry with the message it belongs to.
    // SAVE_MS (400) after the change, so this waits on a timer rather than on a microtask.
    let cached: { turnChanges?: unknown } | undefined;
    for (let i = 0; i < 60 && !cached?.turnChanges; i++) {
      const record = await readRecord(h.idb, A);
      cached = record?.list?.find((m) => m.id === 'w1') as { turnChanges?: unknown } | undefined;
      if (!cached?.turnChanges) await new Promise((r) => setTimeout(r, 50));
    }
    expect(cached?.turnChanges).toMatchObject({ turn: 4 });
  });
});

/**
 * The file window: a topic's machine, a tree, and an editor (page.ts "the file window").
 *
 * The daemon's side is tested where it lives (`daemon/file-panel.test.ts`); what is asserted here
 * is what a person would see and do — the button appearing only when the feature is on, a file
 * opening, the editor holding what was typed, a save carrying the version it read, the conflict
 * dialog's three answers, and the confirmation that keeps a tap from throwing an edit away.
 *
 * Two editor paths, because the page has two: the plain textarea it always has, and CodeMirror
 * behind `window.__fhCodeView` (which is null in production until the asset lands).
 */
