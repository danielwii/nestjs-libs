/**
 * Fails when skew-prone dependency families resolve to more than one installed
 * package identity below this repository. Run it in every consumer migration
 * after installing the exact peer family required by nestjs-libs.
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const families = ['ai', 'zod', '@nestjs', '@ai-sdk'] as const;
const root = process.cwd();
const nodeModules = join(root, 'node_modules');

function packageDirs(family: (typeof families)[number]): string[] {
  const base = join(nodeModules, family);
  if (!existsSync(base)) return [];
  if (!family.startsWith('@')) return [base];
  return readdirSync(base)
    .map((entry) => join(base, entry))
    .filter((entry) => existsSync(join(entry, 'package.json')));
}

const failures: string[] = [];
for (const family of families) {
  const packages = packageDirs(family);
  for (const pkg of packages) {
    const packageName = family.startsWith('@') ? `${family}/${pkg.split('/').at(-1)}` : family;
    const resolved = realpathSync(pkg);
    const nestedCandidates = readdirSync(nodeModules, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '.cache')
      .map((entry) => join(nodeModules, entry.name, 'node_modules', packageName))
      .filter((candidate) => existsSync(candidate));
    const identities = new Set([resolved, ...nestedCandidates.map((candidate) => realpathSync(candidate))]);
    if (identities.size > 1) failures.push(`${packageName}: ${[...identities].join(' <> ')}`);
  }
}

if (failures.length > 0) {
  console.error('Dependency identity split detected:\n' + failures.join('\n'));
  process.exit(1);
}

console.log('Dependency identity check passed for ai/@ai-sdk/@nestjs/zod.');
