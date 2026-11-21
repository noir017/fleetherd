import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static enforcement of the one-way dependency graph documented in `AGENTS.md#layering`.
 *
 * Keeps module boundaries machine-checked so an accidental cross-layer import fails in tests
 * instead of silently drifting.
 */
const SRC_ROOT = path.dirname(fileURLToPath(import.meta.url));

const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function walkProdTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkProdTs(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test-helpers.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function collectImports(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  // Strip line and block comments so commented-out examples don't trigger false positives.
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const specs: string[] = [];
  for (const m of stripped.matchAll(IMPORT_RE)) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

function resolveTarget(fromFile: string, spec: string): { kind: 'external'; name: string } | { kind: 'src'; rel: string; module: string } {
  if (!spec.startsWith('.')) return { kind: 'external', name: spec };
  const resolved = path.resolve(path.dirname(fromFile), spec);
  const rel = path.relative(SRC_ROOT, resolved).replace(/\\/g, '/');
  const first = rel.split('/')[0] ?? '';
  return { kind: 'src', rel, module: first };
}

interface LayerRule {
  module: string;
  /** Top-level `src/` modules or root files (`types.js`, `legacy-name.js`) allowed outside itself. */
  allowedSrc: ReadonlySet<string>;
  /** Specific external package prefixes forbidden in this layer. */
  forbiddenExternalPrefixes?: readonly string[];
  /** Optional fine-grained check for cross-module imports inside `allowedSrc`. */
  checkAllowedSrc?: (rel: string, fromRel: string) => string | undefined;
}

const RULES: readonly LayerRule[] = [
  {
    module: 'core',
    allowedSrc: new Set(['config', 'types.js']),
    forbiddenExternalPrefixes: ['@satorijs/', '@koishijs/'],
  },
  {
    module: 'config',
    allowedSrc: new Set(['platform', 'types.js', 'legacy-name.js']),
    checkAllowedSrc: (rel) =>
      rel.startsWith('platform/') && rel !== 'platform/config-schemas.js'
        ? `config/ may only import platform/config-schemas.js, not ${rel}`
        : undefined,
  },
  {
    module: 'platform',
    allowedSrc: new Set(['config', 'core', 'types.js', 'legacy-name.js']),
    checkAllowedSrc: (rel) =>
      rel.startsWith('config/') && rel !== 'config/load.js' && rel !== 'config/schema.js'
        ? `platform/ may only import config/load.js or config/schema.js, not ${rel}`
        : undefined,
  },
  {
    module: 'ipc',
    allowedSrc: new Set(['types.js', 'legacy-name.js']),
  },
  {
    module: 'history',
    allowedSrc: new Set(),
  },
  {
    module: 'remote',
    allowedSrc: new Set(),
  },
  {
    module: 'api-agent',
    allowedSrc: new Set(),
  },
  {
    module: 'daemon',
    allowedSrc: new Set(['config', 'core', 'history', 'ipc', 'legacy-name.js', 'platform', 'remote', 'types.js']),
  },
];

describe('module layering (AGENTS.md)', () => {
  for (const rule of RULES) {
    it(`${rule.module}/ respects its dependency boundary`, () => {
      const dir = path.join(SRC_ROOT, rule.module);
      const violations: string[] = [];

      for (const file of walkProdTs(dir)) {
        const fromRel = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
        for (const spec of collectImports(file)) {
          const target = resolveTarget(file, spec);
          if (target.kind === 'external') {
            // `core/proxy.ts` carries a single type-only import of `@satorijs/core` (`Context`).
            if (fromRel === 'core/proxy.ts' && target.name === '@satorijs/core') continue;
            for (const prefix of rule.forbiddenExternalPrefixes ?? []) {
              if (target.name.startsWith(prefix)) {
                violations.push(`${fromRel} imports forbidden package ${target.name}`);
              }
            }
            continue;
          }
          if (target.module === rule.module) continue;
          if (!rule.allowedSrc.has(target.module)) {
            violations.push(`${fromRel} imports ${target.rel} (forbidden from ${rule.module}/)`);
            continue;
          }
          const detail = rule.checkAllowedSrc?.(target.rel, fromRel);
          if (detail) violations.push(`${fromRel}: ${detail}`);
        }
      }

      expect(violations).toEqual([]);
    });
  }
});
