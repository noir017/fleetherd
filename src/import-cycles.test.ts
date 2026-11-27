import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SRC_ROOT, collectImports, resolveTarget, walkProdTs } from './test-utils/import-graph.js';

/**
 * Ratchet test for file-level import cycles across `src/` (excluding `src/platform/webui/client/`).
 *
 * The allowlists below record known strongly connected components (size > 1). A new cycle fails
 * the test with its members; a resolved cycle also fails so its allowlist entry is removed and
 * the list only ever shrinks.
 */

const EXCLUDED_DIRS = new Set(['platform/webui/client']);

const ALLOWED_ALL_IMPORT_CYCLES: readonly (readonly string[])[] = [
  // B: daemon conversation / delegation / turn-runner cluster
  [
    'daemon/conversation-commands.ts',
    'daemon/conversation-context.ts',
    'daemon/conversation-controls.ts',
    'daemon/conversation-delegation.ts',
    'daemon/conversation-history.ts',
    'daemon/conversation-turns.ts',
    'daemon/conversation.ts',
    'daemon/delegation.ts',
    'daemon/turn-outcomes.ts',
    'daemon/turn-runner.ts',
  ],
  // C: types.ts <-> core/conversation.ts <-> config/schema.ts <-> config/instructions.ts
  [
    'config/instructions.ts',
    'config/schema.ts',
    'core/conversation.ts',
    'types.ts',
  ],
  // E: relay.ts <-> agy-relay.ts
  [
    'daemon/agy-relay.ts',
    'daemon/relay.ts',
  ],
];

const ALLOWED_VALUE_IMPORT_CYCLES: readonly (readonly string[])[] = [
  // A: delegation.ts <-> turn-runner.ts
  [
    'daemon/delegation.ts',
    'daemon/turn-runner.ts',
  ],
];

function buildImportGraph(valuesOnly: boolean): Map<string, string[]> {
  const files = walkProdTs(SRC_ROOT, { excludeDirs: EXCLUDED_DIRS });
  const nodes = new Set(files.map((f) => path.relative(SRC_ROOT, f).replace(/\\/g, '/')));
  const adj = new Map<string, string[]>();
  for (const node of nodes) adj.set(node, []);

  for (const file of files) {
    const fromRel = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
    const targets = new Set<string>();
    for (const spec of collectImports(file, { valuesOnly })) {
      const target = resolveTarget(file, spec);
      if (target.kind !== 'src') continue;
      const tsRel = target.rel.replace(/\.js$/, '.ts');
      if (nodes.has(tsRel)) {
        targets.add(tsRel);
      } else if (nodes.has(`${target.rel}/index.ts`)) {
        targets.add(`${target.rel}/index.ts`);
      }
    }
    adj.set(fromRel, [...targets].sort());
  }
  return adj;
}

function tarjanSccs(adj: ReadonlyMap<string, readonly string[]>): string[][] {
  let nextIndex = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const strongConnect = (v: string): void => {
    const vIdx = nextIndex++;
    index.set(v, vIdx);
    lowlink.set(v, vIdx);
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      if (component.length > 1) {
        component.sort();
        sccs.push(component);
      }
    }
  };

  for (const v of [...adj.keys()].sort()) {
    if (!index.has(v)) strongConnect(v);
  }
  return sccs;
}

function normalizeSccs(sccs: readonly (readonly string[])[]): string[][] {
  return sccs
    .map((c) => [...c].sort())
    .sort((a, b) => a.join('\n').localeCompare(b.join('\n')));
}

function assertCyclesMatchAllowlist(
  label: string,
  actual: readonly (readonly string[])[],
  allowlist: readonly (readonly string[])[]
): void {
  const normActual = normalizeSccs(actual);
  const normAllowed = normalizeSccs(allowlist);
  const actualByKey = new Map(normActual.map((c) => [c.join('\n'), c]));
  const allowedByKey = new Map(normAllowed.map((c) => [c.join('\n'), c]));

  const unexpected = [...actualByKey.entries()]
    .filter(([k]) => !allowedByKey.has(k))
    .map(([, c]) => c);
  const stale = [...allowedByKey.entries()]
    .filter(([k]) => !actualByKey.has(k))
    .map(([, c]) => c);

  if (unexpected.length > 0 || stale.length > 0) {
    const lines: string[] = [];
    for (const cycle of unexpected) {
      lines.push(`Unexpected ${label} import cycle (${cycle.length} files): ${cycle.join(', ')}`);
    }
    for (const cycle of stale) {
      lines.push(
        `Allowlisted ${label} import cycle no longer exists — remove it from the allowlist: ${cycle.join(', ')}`
      );
    }
    expect.fail(lines.join('\n'));
  }

  expect(normActual).toEqual(normAllowed);
}

describe('import cycles ratchet', () => {
  it('matches the allowlist for all imports (including type-only)', () => {
    const sccs = tarjanSccs(buildImportGraph(false));
    assertCyclesMatchAllowlist('all-import', sccs, ALLOWED_ALL_IMPORT_CYCLES);
  });

  it('matches the allowlist for value-level imports', () => {
    const sccs = tarjanSccs(buildImportGraph(true));
    assertCyclesMatchAllowlist('value-level', sccs, ALLOWED_VALUE_IMPORT_CYCLES);
  });
});
