import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/** src/sim/ から参照してはいけない DOM の API の名前。 */
const DOM_GLOBALS = new Set([
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'fetch',
  'performance',
  'Element',
  'MouseEvent',
  'KeyboardEvent',
  'PointerEvent',
  'Gamepad',
  'WebGLRenderingContext',
  'WebGL2RenderingContext',
]);
const DOM_PATTERN = /^HTML\w*Element$/;

export interface BoundaryViolation {
  file: string;
  line: number;
  reason: string;
}

function isThreeModule(specifier: string): boolean {
  return specifier === 'three' || specifier.startsWith('three/');
}

/** 識別子が値・型として参照されているか（プロパティ名や宣言の名前でないか）。 */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) {
    return false;
  }
  return true;
}

/** 1 つのファイルの中身から、three の import と DOM の API の参照を探す。 */
export function findViolationsInSource(file: string, source: string): BoundaryViolation[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: BoundaryViolation[] = [];
  const report = (node: ts.Node, reason: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push({ file, line: line + 1, reason });
  };

  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (isThreeModule(node.moduleSpecifier.text)) report(node, `"${node.moduleSpecifier.text}" を import している`);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const [arg] = node.arguments;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImport || isRequire) && arg && ts.isStringLiteralLike(arg) && isThreeModule(arg.text)) {
        report(node, `"${arg.text}" を import している`);
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      if (isThreeModule(node.argument.literal.text)) report(node, `"${node.argument.literal.text}" を import している`);
    } else if (ts.isIdentifier(node) && (DOM_GLOBALS.has(node.text) || DOM_PATTERN.test(node.text)) && isReference(node)) {
      report(node, `DOM の API "${node.text}" を参照している`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

/** ディレクトリ以下のすべてのソースから違反を探す（ARC-1）。 */
export function findSimBoundaryViolations(simDir: string): BoundaryViolation[] {
  return listSourceFiles(simDir).flatMap((path) =>
    findViolationsInSource(relative(simDir, path), readFileSync(path, 'utf8')),
  );
}
