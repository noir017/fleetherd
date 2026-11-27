import { describe, expect, it } from 'vitest';
import { collectImportsFromSource } from './import-graph.js';

describe('collectImportsFromSource', () => {
  it('does not swallow imports after /* in a line comment or string literal', () => {
    const src = [
      '// Profiles live under profiles/*.ts and hit /cgi-bin/*',
      "const glob = 'src/foo/*.ts';",
      "import { alpha } from './alpha.js';",
      "import { beta } from './beta.js';",
      '/* trailing block comment */',
      "export { gamma } from './gamma.js';",
    ].join('\n');

    expect(collectImportsFromSource(src)).toEqual(['./alpha.js', './beta.js', './gamma.js']);
    expect(collectImportsFromSource(src, 'file.ts', { valuesOnly: true })).toEqual([
      './alpha.js',
      './beta.js',
      './gamma.js',
    ]);
  });

  it('ignores fake import/export text inside comments and strings', () => {
    const src = [
      "// import { fake1 } from './fake1.js';",
      "/* export * from './fake2.js'; */",
      "const note = \"import { fake3 } from './fake3.js'\";",
      "import { real } from './real.js';",
    ].join('\n');

    expect(collectImportsFromSource(src)).toEqual(['./real.js']);
    expect(collectImportsFromSource(src, 'file.ts', { valuesOnly: true })).toEqual(['./real.js']);
  });

  it('treats a distant value re-export after `export type X = ...` as value-level', () => {
    const src = [
      'export type WebuiInstance = { id: string };',
      'export const filler = 1;',
      'export function helper(): number { return filler + 1; }',
      "export { TopicStore, type Topic } from './topics.js';",
    ].join('\n');

    expect(collectImportsFromSource(src)).toEqual(['./topics.js']);
    expect(collectImportsFromSource(src, 'file.ts', { valuesOnly: true })).toEqual(['./topics.js']);
  });

  it('treats `export type { ... } from` after `export const` as type-only', () => {
    const src = [
      'export const VERSION = 1;',
      "export type { Foo, Bar } from './types.js';",
    ].join('\n');

    expect(collectImportsFromSource(src)).toEqual(['./types.js']);
    expect(collectImportsFromSource(src, 'file.ts', { valuesOnly: true })).toEqual([]);
  });

  it('distinguishes import type, all-type named specifiers, and mixed/default imports', () => {
    const src = [
      "import type { A } from './type-decl.js';",
      "import { type B, type C as C2 } from './all-inline-type.js';",
      "export { type D, type E } from './all-inline-export.js';",
      "import Def, { type F } from './default-plus-type.js';",
      "import { val, type G } from './mixed-value-type.js';",
      "import './side-effect.js';",
      'export { Def, val };',
    ].join('\n');

    expect(collectImportsFromSource(src)).toEqual([
      './type-decl.js',
      './all-inline-type.js',
      './all-inline-export.js',
      './default-plus-type.js',
      './mixed-value-type.js',
      './side-effect.js',
    ]);
    expect(collectImportsFromSource(src, 'file.ts', { valuesOnly: true })).toEqual([
      './default-plus-type.js',
      './mixed-value-type.js',
      './side-effect.js',
    ]);
  });

  it('records ImportTypeNode as type-only and dynamic import() as value-level', () => {
    const src = [
      "export type S = import('./agent.js').AgentSession;",
      "export type Nested = import('./outer.js').Wrap<import('./inner.js').Item>;",
      "export async function load() { return import('./lazy.js'); }",
      'export async function loadTpl() { return import(`./tpl.js`); }',
    ].join('\n');

    expect(collectImportsFromSource(src)).toEqual([
      './agent.js',
      './outer.js',
      './inner.js',
      './lazy.js',
      './tpl.js',
    ]);
    expect(collectImportsFromSource(src, 'file.ts', { valuesOnly: true })).toEqual([
      './lazy.js',
      './tpl.js',
    ]);
  });
});
