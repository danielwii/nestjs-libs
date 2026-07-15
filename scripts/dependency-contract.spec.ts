import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';
import ts from 'typescript';

interface PackageManifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function externalPackageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('@app/')) return undefined;
  if (!specifier.startsWith('@')) return specifier.split('/')[0];
  const [scope, name] = specifier.split('/');
  return scope && name ? `${scope}/${name}` : undefined;
}

function collectImports(filePath: string): { staticPackages: Set<string>; dynamicPackages: Set<string> } {
  const sourceText = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const staticPackages = new Set<string>();
  const dynamicPackages = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const packageName = externalPackageName(node.moduleSpecifier.text);
      if (packageName) staticPackages.add(packageName);
    }

    const requireArgument = ts.isCallExpression(node) ? node.arguments[0] : undefined;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      requireArgument !== undefined &&
      ts.isStringLiteral(requireArgument)
    ) {
      const packageName = externalPackageName(requireArgument.text);
      if (packageName) dynamicPackages.add(packageName);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { staticPackages, dynamicPackages };
}

describe('instrumentation dependency contract', () => {
  const root = join(import.meta.dir, '..');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageManifest;
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);

  const instrumentImports = collectImports(join(root, 'instrument.ts'));
  const aiOtelImports = collectImports(join(root, 'nest/src/boot/ai-sdk-otel.ts'));

  it('declares every static preload import as a dependency or peer dependency', () => {
    const staticPackages = new Set([...instrumentImports.staticPackages, ...aiOtelImports.staticPackages]);
    const missing = [...staticPackages].filter((packageName) => !declared.has(packageName));

    expect(missing).toEqual([]);
  });

  it('declares every dynamically loaded integration as an optional peer dependency', () => {
    const dynamicPackages = new Set([...instrumentImports.dynamicPackages, ...aiOtelImports.dynamicPackages]);
    const missing = [...dynamicPackages].filter(
      (packageName) =>
        manifest.peerDependencies?.[packageName] === undefined ||
        manifest.peerDependenciesMeta?.[packageName]?.optional !== true,
    );

    expect(missing).toEqual([]);
  });
});
