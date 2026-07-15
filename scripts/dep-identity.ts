import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export interface PackageOccurrence {
  anchor: string;
  name: string;
  version: string;
  logicalPath: string;
  realPath: string;
}

export interface DependencyIdentityConflict {
  name: string;
  occurrences: PackageOccurrence[];
}

export interface DependencyIdentityReport {
  anchors: string[];
  occurrences: PackageOccurrence[];
  conflicts: DependencyIdentityConflict[];
}

export interface DependencyIdentityOptions {
  anchors: string[];
  include?: (packageName: string) => boolean;
}

export function isDefaultIdentityPackage(packageName: string): boolean {
  return (
    packageName === 'ai' ||
    packageName === 'zod' ||
    packageName.startsWith('@ai-sdk/') ||
    packageName.startsWith('@nestjs/')
  );
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listPackageDirectories(nodeModulesPath: string): string[] {
  if (!isDirectory(nodeModulesPath)) return [];

  const packages: string[] = [];
  for (const entry of readdirSync(nodeModulesPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = join(nodeModulesPath, entry.name);
    if (!isDirectory(entryPath)) continue;

    if (entry.name.startsWith('@')) {
      for (const scopedEntry of readdirSync(entryPath, { withFileTypes: true })) {
        if (scopedEntry.name.startsWith('.')) continue;
        const packagePath = join(entryPath, scopedEntry.name);
        if (isDirectory(packagePath)) packages.push(packagePath);
      }
      continue;
    }

    packages.push(entryPath);
  }

  return packages.sort();
}

function readPackageIdentity(packagePath: string): { name: string; version: string } | undefined {
  const manifestPath = join(packagePath, 'package.json');
  if (!existsSync(manifestPath)) return undefined;

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return undefined;
  }

  if (typeof manifest !== 'object' || manifest === null) return undefined;
  const name = 'name' in manifest ? manifest.name : undefined;
  const version = 'version' in manifest ? manifest.version : undefined;
  if (typeof name !== 'string' || typeof version !== 'string') return undefined;
  return { name, version };
}

function scanAnchor(anchor: string, include: (packageName: string) => boolean): PackageOccurrence[] {
  const resolvedAnchor = resolve(anchor);
  const rootNodeModules =
    basename(resolvedAnchor) === 'node_modules' ? resolvedAnchor : join(resolvedAnchor, 'node_modules');
  const occurrences: PackageOccurrence[] = [];
  const visitedNodeModules = new Set<string>();

  const walkNodeModules = (nodeModulesPath: string): void => {
    if (!isDirectory(nodeModulesPath)) return;

    const realNodeModules = realpathSync(nodeModulesPath);
    if (visitedNodeModules.has(realNodeModules)) return;
    visitedNodeModules.add(realNodeModules);

    for (const logicalPath of listPackageDirectories(nodeModulesPath)) {
      const identity = readPackageIdentity(logicalPath);
      if (!identity) continue;

      if (include(identity.name)) {
        occurrences.push({
          anchor: resolvedAnchor,
          name: identity.name,
          version: identity.version,
          logicalPath,
          realPath: realpathSync(logicalPath),
        });
      }

      walkNodeModules(join(logicalPath, 'node_modules'));
    }
  };

  walkNodeModules(rootNodeModules);
  return occurrences;
}

export function inspectDependencyIdentities(options: DependencyIdentityOptions): DependencyIdentityReport {
  const anchors = options.anchors.map((anchor) => resolve(anchor));
  const include = options.include ?? isDefaultIdentityPackage;
  const occurrences = anchors.flatMap((anchor) => scanAnchor(anchor, include));
  occurrences.sort((left, right) =>
    `${left.name}\0${left.anchor}\0${left.logicalPath}`.localeCompare(
      `${right.name}\0${right.anchor}\0${right.logicalPath}`,
    ),
  );

  const byName = new Map<string, PackageOccurrence[]>();
  for (const occurrence of occurrences) {
    const group = byName.get(occurrence.name) ?? [];
    group.push(occurrence);
    byName.set(occurrence.name, group);
  }

  const conflicts = [...byName.entries()]
    .filter(([, group]) => {
      const realPaths = new Set(group.map((occurrence) => occurrence.realPath));
      const versions = new Set(group.map((occurrence) => occurrence.version));
      return realPaths.size > 1 || versions.size > 1;
    })
    .map(([name, group]) => ({ name, occurrences: group }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { anchors, occurrences, conflicts };
}

export function formatDependencyIdentityReport(report: DependencyIdentityReport): string {
  if (report.conflicts.length === 0) {
    return `Dependency identity check passed (${report.occurrences.length} matching installations across ${report.anchors.length} anchor(s)).`;
  }

  const lines = [`Dependency identity check failed with ${report.conflicts.length} conflict(s):`];
  for (const conflict of report.conflicts) {
    lines.push(`- ${conflict.name}`);
    for (const occurrence of conflict.occurrences) {
      lines.push(
        `  version=${occurrence.version} anchor=${occurrence.anchor} logical=${occurrence.logicalPath} real=${occurrence.realPath}`,
      );
    }
  }
  return lines.join('\n');
}
