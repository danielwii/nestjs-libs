import { formatDependencyIdentityReport, inspectDependencyIdentities } from './dep-identity';

interface CliOptions {
  anchors: string[];
  json: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const anchors: string[] = [];
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--anchor') {
      const anchor = args[index + 1];
      if (!anchor) throw new Error('--anchor requires a path');
      anchors.push(anchor);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { anchors: anchors.length > 0 ? anchors : ['.'], json };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = inspectDependencyIdentities({ anchors: options.anchors });
  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : formatDependencyIdentityReport(report)}\n`);
  if (report.conflicts.length > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
