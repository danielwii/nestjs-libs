import { createPackageNameInclude, inspectDependencyIdentities } from './dep-identity';

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import type { DependencyIdentityReport } from './dep-identity';

const tempRoots: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dep-identity-'));
  tempRoots.push(root);
  return root;
}

function createPackage(root: string, relativePath: string, name: string, version: string): string {
  const packagePath = join(root, relativePath);
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(join(packagePath, 'package.json'), JSON.stringify({ name, version }));
  return packagePath;
}

function createDirectorySymlink(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, 'dir');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('inspectDependencyIdentities', () => {
  it('passes multiple logical symlinks that resolve to one physical package', () => {
    const root = createRoot();
    const storePackage = createPackage(root, 'store/zod', 'zod', '4.4.3');
    createPackage(root, 'node_modules/host', 'host', '1.0.0');
    createDirectorySymlink(storePackage, join(root, 'node_modules/zod'));
    createDirectorySymlink(storePackage, join(root, 'node_modules/host/node_modules/zod'));

    const report = inspectDependencyIdentities({ anchors: [root] });

    expect(report.occurrences.filter((occurrence) => occurrence.name === 'zod')).toHaveLength(2);
    expect(report.conflicts).toEqual([]);
  });

  it('rejects same-version packages at two physical realpaths', () => {
    const root = createRoot();
    createPackage(root, 'node_modules/zod', 'zod', '4.4.3');
    createPackage(root, 'node_modules/host', 'host', '1.0.0');
    createPackage(root, 'node_modules/host/node_modules/zod', 'zod', '4.4.3');

    const report = inspectDependencyIdentities({ anchors: [root] });

    expect(report.conflicts.map((conflict) => conflict.name)).toEqual(['zod']);
    expect(report.conflicts[0]?.occurrences).toHaveLength(2);
  });

  it('finds a scoped package nested below another scoped package', () => {
    const root = createRoot();
    createPackage(root, 'node_modules/@ai-sdk/provider', '@ai-sdk/provider', '4.0.3');
    createPackage(root, 'node_modules/@openrouter/ai-sdk-provider', '@openrouter/ai-sdk-provider', '3.0.0');
    createPackage(
      root,
      'node_modules/@openrouter/ai-sdk-provider/node_modules/@ai-sdk/provider',
      '@ai-sdk/provider',
      '4.1.0',
    );

    const report = inspectDependencyIdentities({ anchors: [root] });

    expect(report.conflicts.map((conflict) => conflict.name)).toEqual(['@ai-sdk/provider']);
    expect(report.conflicts[0]?.occurrences.map((occurrence) => occurrence.version)).toEqual(['4.0.3', '4.1.0']);
  });

  it('compares package identities across multiple anchors', () => {
    const root = createRoot();
    const first = join(root, 'consumer');
    const second = join(root, 'libs');
    createPackage(first, 'node_modules/ai', 'ai', '7.0.28');
    createPackage(second, 'node_modules/ai', 'ai', '7.0.28');

    const report = inspectDependencyIdentities({ anchors: [first, second] });

    expect(report.conflicts.map((conflict) => conflict.name)).toEqual(['ai']);
    expect(report.conflicts[0]?.occurrences.map((occurrence) => occurrence.anchor)).toEqual([first, second]);
  });

  it('emits a machine-readable JSON report from the CLI', () => {
    const root = createRoot();
    createPackage(root, 'node_modules/ai', 'ai', '7.0.28');

    const result = spawnSync(
      process.execPath,
      [join(import.meta.dir, 'check-dep-identity.ts'), '--anchor', root, '--json'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as DependencyIdentityReport;
    expect(report.anchors).toEqual([root]);
    expect(report.occurrences).toHaveLength(1);
    expect(report.conflicts).toEqual([]);
  });

  it('matches repeated exact and prefix/* package filters without widening the package set', () => {
    const include = createPackageNameInclude(['zod', '@nestjs/*']);

    expect(include('zod')).toBe(true);
    expect(include('zod-validation-error')).toBe(false);
    expect(include('@nestjs/common')).toBe(true);
    expect(include('@nestjs/core')).toBe(true);
    expect(include('@nestjsx/core')).toBe(false);
    expect(include('ai')).toBe(false);
  });

  it('rejects wildcard syntax outside the supported prefix/* form', () => {
    expect(() => createPackageNameInclude(['@nestjs*'])).toThrow('Use an exact name or prefix/*.');
    expect(() => createPackageNameInclude(['/*'])).toThrow('Use an exact name or prefix/*.');
    expect(() => createPackageNameInclude([''])).toThrow('--package requires a non-empty package name');
  });

  it('isolates CLI evidence with repeatable --package while ignoring an unrelated AI conflict', () => {
    const root = createRoot();
    createPackage(root, 'node_modules/ai', 'ai', '7.0.28');
    createPackage(root, 'node_modules/host', 'host', '1.0.0');
    createPackage(root, 'node_modules/host/node_modules/ai', 'ai', '7.0.29');
    createPackage(root, 'node_modules/zod', 'zod', '4.4.3');
    createPackage(root, 'node_modules/@nestjs/common', '@nestjs/common', '11.1.28');
    createPackage(root, 'node_modules/@nestjs/core', '@nestjs/core', '11.1.28');

    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, 'check-dep-identity.ts'),
        '--anchor',
        root,
        '--package',
        'zod',
        '--package',
        '@nestjs/*',
        '--json',
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as DependencyIdentityReport;
    expect([...new Set(report.occurrences.map((occurrence) => occurrence.name))]).toEqual([
      '@nestjs/common',
      '@nestjs/core',
      'zod',
    ]);
    expect(report.conflicts).toEqual([]);
  });

  it('keeps the default package set so unrelated AI drift remains visible', () => {
    const root = createRoot();
    createPackage(root, 'node_modules/ai', 'ai', '7.0.28');
    createPackage(root, 'node_modules/host', 'host', '1.0.0');
    createPackage(root, 'node_modules/host/node_modules/ai', 'ai', '7.0.29');
    createPackage(root, 'node_modules/zod', 'zod', '4.4.3');

    const result = spawnSync(
      process.execPath,
      [join(import.meta.dir, 'check-dep-identity.ts'), '--anchor', root, '--json'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as DependencyIdentityReport;
    expect(report.conflicts.map((conflict) => conflict.name)).toEqual(['ai']);
    expect(report.occurrences.some((occurrence) => occurrence.name === 'zod')).toBe(true);
  });
});
