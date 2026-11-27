import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.length === 0) return false;
  return bindings.elements.every((el) => el.isTypeOnly);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (!clause || !ts.isNamedExports(clause) || clause.elements.length === 0) return false;
  return clause.elements.every((el) => el.isTypeOnly);
}

export function collectImportsFromSource(
  src: string,
  fileName = 'file.ts',
  options?: { valuesOnly?: boolean }
): string[] {
  const valuesOnly = options?.valuesOnly ?? false;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, false);
  const specs: string[] = [];

  const record = (spec: string, typeOnly: boolean): void => {
    if (!valuesOnly || !typeOnly) specs.push(spec);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text, isTypeOnlyImport(node));
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text, isTypeOnlyExport(node));
      return;
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      record(node.argument.literal.text, true);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) record(arg.text, false);
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return specs;
}

export function collectImports(file: string, options?: { valuesOnly?: boolean }): string[] {
  return collectImportsFromSource(fs.readFileSync(file, 'utf8'), file, options);
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
