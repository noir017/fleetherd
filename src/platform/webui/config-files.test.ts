import { describe, expect, it } from 'vitest';

import { WebuiConfigSchema } from '../config-schemas.js';

/**
 * The `files` block of a webui instance. Only the shape rules are here — what the panel does with
 * the roots is `daemon/file-panel.test.ts` — but the root rule is worth a test of its own: a
 * relative entry cannot match the absolute paths containment compares against, so it would be a
 * configuration that looks like it grants access and silently grants none.
 */
describe('platforms.<id>.files', () => {
  const parse = (files: unknown) => WebuiConfigSchema.safeParse({ type: 'webui', token: 't', files });

  it('is off with no extra roots unless asked', () => {
    const r = parse({});
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.files).toEqual({ enabled: false, roots: [] });
    // And absent entirely, which is how every config that predates it parses.
    const plain = WebuiConfigSchema.safeParse({ type: 'webui', token: 't' });
    expect(plain.success && plain.data.files).toEqual({ enabled: false, roots: [] });
  });

  it.each([
    ['an absolute root', ['/srv/shared']],
    ['a home root', ['~/projects']],
    ['home itself', ['~']],
    ['a Windows drive root', ['D:\\work']],
  ])('accepts %s', (_label, roots) => {
    expect(parse({ enabled: true, roots }).success).toBe(true);
  });

  it.each([
    ['a relative root', 'shared'],
    ['a dotted relative root', '../shared'],
    ['a root that only starts with a tilde name', '~user/x'],
  ])('refuses %s, which could match nothing', (_label, root) => {
    const r = parse({ enabled: true, roots: [root] });
    expect(r.success).toBe(false);
  });
});
