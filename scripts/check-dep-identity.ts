import { createPackageNameInclude, formatDependencyIdentityReport, inspectDependencyIdentities } from './dep-identity';

interface CliOptions {
  anchors: string[];
  packages: string[];
  json: boolean;
}

function readOptionValue(args: string[], index: number, errorMessage: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(errorMessage);
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const anchors: string[] = [];
  const packages: string[] = [];
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--anchor') {
      const anchor = readOptionValue(args, index, '--anchor requires a path');
      anchors.push(anchor);
      index += 1;
      continue;
    }
    if (argument === '--package') {
      const packagePattern = readOptionValue(args, index, '--package requires an exact package name or prefix/*');
      packages.push(packagePattern);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { anchors: anchors.length > 0 ? anchors : ['.'], packages, json };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const include = options.packages.length > 0 ? createPackageNameInclude(options.packages) : undefined;
  const report = inspectDependencyIdentities({ anchors: options.anchors, include });
  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : formatDependencyIdentityReport(report)}\n`);
  if (report.conflicts.length > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
