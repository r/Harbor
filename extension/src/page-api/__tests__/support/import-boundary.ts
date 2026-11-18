/// <reference types="node" />
/**
 * Helper for the import-boundary test: lists page-api's production files and
 * the relative imports each one makes.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function listProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue;
    const full = path.join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      out.push(...listProductionTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function importsOf(file: string): Array<{ specifier: string; typeOnly: boolean }> {
  const source = readFileSync(file, 'utf-8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Array<{ specifier: string; typeOnly: boolean }> = [];
  sourceFile.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push({ specifier: node.moduleSpecifier.text, typeOnly: !!node.importClause?.isTypeOnly });
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push({ specifier: node.moduleSpecifier.text, typeOnly: !!node.isTypeOnly });
    }
  });
  return out;
}

/**
 * `testFileUrl` is the import-boundary test's own `import.meta.url` (it
 * lives at page-api/__tests__/import-boundary.test.ts, so page-api/ is two
 * directories up). Returns a list of human-readable violation strings,
 * empty when every production file under page-api/ stays inside the
 * allowed boundary (same-directory, harbor-core.ts, browser-compat, or a
 * type-only import).
 */
export function findImportBoundaryViolations(testFileUrl: string): { files: string[]; violations: string[] } {
  const pageApiRoot = path.dirname(path.dirname(fileURLToPath(testFileUrl)));
  const files = listProductionTsFiles(pageApiRoot);

  const violations: string[] = [];
  for (const file of files) {
    for (const imp of importsOf(file)) {
      if (!imp.specifier.startsWith('.')) continue; // npm packages / node builtins

      const resolved = path.resolve(path.dirname(file), imp.specifier);
      const insidePageApi = resolved === pageApiRoot || resolved.startsWith(pageApiRoot + path.sep);
      if (insidePageApi) continue;

      if (imp.typeOnly) continue; // erased at build time; no runtime coupling
      if (path.basename(resolved) === 'browser-compat') continue;
      if (path.basename(file) === 'harbor-core.ts') continue; // the one allowed seam

      violations.push(`${path.relative(pageApiRoot, file)} imports "${imp.specifier}" (outside page-api/)`);
    }
  }
  return { files, violations };
}
