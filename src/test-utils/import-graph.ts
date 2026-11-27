import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;

const STATEMENT_RE =
  /(?:^|[\s;])(?:import|export)\s+(type\s+)?([\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;

export interface WalkOptions {
  /** Relative paths under `dir` (POSIX slashes) to skip when walking. */
  excludeDirs?: ReadonlySet<string>;
}

export function walkProdTs(dir: string, options?: WalkOptions): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (options?.excludeDirs) {
          const rel = path.relative(dir, full).replace(/\\/g, '/');
          if (options.excludeDirs.has(rel)) continue;
        }
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.test-helpers.ts')
      ) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function isAllTypeSpecifiers(clauseWithFrom: string | undefined): boolean {
  if (!clauseWithFrom) return false;
  const clause = clauseWithFrom.replace(/\s+from\s+$/, '').trim();
  const braced = /^\{([\s\S]*)\}$/.exec(clause);
  if (!braced) return false;
  const items = (braced[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 && items.every((item) => /^type\s+/.test(item));
}

export function collectImports(file: string, options?: { valuesOnly?: boolean }): string[] {
  const src = fs.readFileSync(file, 'utf8');
  // Strip line and block comments so commented-out examples don't trigger false positives.
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const specs: string[] = [];
  if (!options?.valuesOnly) {
    for (const m of stripped.matchAll(IMPORT_RE)) {
      if (m[1]) specs.push(m[1]);
    }
    return specs;
  }
  for (const m of stripped.matchAll(STATEMENT_RE)) {
    if (m[1]) continue;
    if (isAllTypeSpecifiers(m[2])) continue;
    if (m[3]) specs.push(m[3]);
  }
  return specs;
}

export function resolveTarget(
  fromFile: string,
  spec: string
): { kind: 'external'; name: string } | { kind: 'src'; rel: string; module: string } {
  if (!spec.startsWith('.')) return { kind: 'external', name: spec };
  const resolved = path.resolve(path.dirname(fromFile), spec);
  const rel = path.relative(SRC_ROOT, resolved).replace(/\\/g, '/');
  const first = rel.split('/')[0] ?? '';
  return { kind: 'src', rel, module: first };
}
