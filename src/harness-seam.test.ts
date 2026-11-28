import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { HARNESSES } from './config/schema.js';
import { SRC_ROOT, walkProdTs } from './test-utils/import-graph.test-helpers.js';

/**
 * Ratchet for the harness seam (docs/refactor-plan-decoupling.md WP5): a branch on a harness name
 * belongs in `daemon/harness/` or `core/harness-facts.ts`. `config/instructions.ts` is exempt
 * because config loading needs `harnessKind` and config cannot import the daemon.
 *
 * Every other file that still branches is listed with its count; a new branch fails, and so does a
 * removed one, so the list only shrinks.
 */

const SEAM_DIRS = ['daemon/harness/'];
const SEAM_FILES = new Set(['core/harness-facts.ts', 'config/instructions.ts']);

/** Kept on purpose; the reasons are in docs/refactor-plan-decoupling.md §8. */
const ALLOWED_BRANCHES: Readonly<Record<string, number>> = {
  // zod refines for custom/agy-only fields, and agentDisplayName: config cannot import the daemon.
  'config/schema.ts': 5,
  // isApiAgent: a structural test of the definition, not per-harness data.
  'core/permission-levels.ts': 1,
  // Browser code cannot import the daemon.
  'platform/webui/client/features/topic/transcript/banners.ts': 1,
};

const NAMES: ReadonlySet<string> = new Set(HARNESSES);
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function isHarnessRef(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return /harness$/i.test(node.text);
  if (ts.isPropertyAccessExpression(node)) return /harness$/i.test(node.name.text);
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return isHarnessRef(node.expression);
  return false;
}

function isHarnessName(node: ts.Node): boolean {
  return ts.isStringLiteralLike(node) && NAMES.has(node.text);
}

/** Lines that compare a harness-valued expression with a harness name, or `case` one in a switch on it. */
function harnessBranchLines(src: string, fileName = 'file.ts'): number[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const at = (n: ts.Node): void => {
    lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      const { left, right } = node;
      if ((isHarnessName(left) && isHarnessRef(right)) || (isHarnessName(right) && isHarnessRef(left))) at(node);
    } else if (ts.isCaseClause(node) && isHarnessName(node.expression)) {
      if (isHarnessRef(node.parent.parent.expression)) at(node);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'includes' &&
      ts.isArrayLiteralExpression(node.expression.expression) &&
      node.expression.expression.elements.some(isHarnessName) &&
      node.arguments[0] !== undefined &&
      isHarnessRef(node.arguments[0])
    ) {
      at(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

function inSeam(rel: string): boolean {
  return SEAM_FILES.has(rel) || SEAM_DIRS.some((d) => rel.startsWith(d));
}

describe('harnessBranchLines', () => {
  it('finds comparisons, switch cases and includes() on a harness, and nothing else', () => {
    const src = [
      "if (def.harness === 'agy') {}", // 1
      "if ('custom' !== a?.harness) {}", // 2
      'switch (harness) {', // 3
      "  case 'claude': break;", // 4
      "  case 'codebuddy': break;", // 5
      '}',
      "if (['codex', 'dsh'].includes(def.harness)) {}", // 7
      "if (format === 'gemini') {}", // 8
      "switch (kind) { case 'opencode': break; }", // 9
      "const x = { harness: 'claude' };", // 10
    ].join('\n');
    expect(harnessBranchLines(src)).toEqual([1, 2, 4, 7]);
  });
});

describe('harness seam ratchet', () => {
  it('has no harness-name branch outside daemon/harness/ beyond the allowlist', () => {
    const found: Record<string, number[]> = {};
    for (const file of walkProdTs(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
      if (inSeam(rel)) continue;
      const lines = harnessBranchLines(fs.readFileSync(file, 'utf8'), file);
      if (lines.length > 0) found[rel] = lines;
    }

    const problems: string[] = [];
    for (const [rel, lines] of Object.entries(found)) {
      const allowed = ALLOWED_BRANCHES[rel] ?? 0;
      if (lines.length > allowed) {
        problems.push(
          `${rel}: ${lines.length} harness-name branch(es) (lines ${lines.join(', ')}), allowed ${allowed} — move them into the harness's profile (daemon/harness/) or core/harness-facts.ts`
        );
      }
    }
    for (const [rel, allowed] of Object.entries(ALLOWED_BRANCHES)) {
      const n = found[rel]?.length ?? 0;
      if (n < allowed) problems.push(`${rel}: ${n} harness-name branch(es), allowlisted ${allowed} — lower the allowlist`);
    }
    if (problems.length > 0) expect.fail(problems.join('\n'));
  });
});
