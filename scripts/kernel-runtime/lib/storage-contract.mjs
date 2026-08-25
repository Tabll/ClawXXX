import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

export const REQUIRED_STORAGE_SCENARIOS = [
  'new',
  'prompt',
  'cancel',
  'compact',
  'branch',
  'restart',
  'cron',
  'channel',
];

const FORBIDDEN_PATHS = [
  /(?:^|\/)sessions\.json$/i,
  /(?:^|\/)(?:sessions|transcripts?|trajector(?:y|ies)|cron-history|scheduler-history|message-history|usage-history)(?:\/|$)/i,
  /(?:^|\/)[^/]*\.trajectory(?:-path)?\.json$/i,
  /(?:^|\/)[^/]*(?:session|transcript|trajectory|cron|message|usage)[^/]*\.(?:db|sqlite|sqlite3)$/i,
];

export function scanRuntimeDataDirectory(root, scenarioResults) {
  for (const scenario of REQUIRED_STORAGE_SCENARIOS) {
    if (scenarioResults?.[scenario] !== true) throw new Error(`Storage scenario was not completed: ${scenario}`);
  }
  const paths = scanRuntimeDataPaths(root);
  return {
    schemaVersion: 1,
    ok: paths.violations.length === 0,
    authority: 'clawx-data-service',
    nativeDurableHistory: false,
    scenarios: Object.fromEntries(REQUIRED_STORAGE_SCENARIOS.map((scenario) => [scenario, true])),
    ...(scenarioResults?.evidenceKind === 'verified-source-contract-suites'
      ? { scenarioEvidence: {
          evidenceKind: scenarioResults.evidenceKind,
          kernelId: scenarioResults.kernelId,
          suites: Array.isArray(scenarioResults.suites) ? scenarioResults.suites : [],
          ciRunId: scenarioResults.ciRunId,
        } }
      : {}),
    scannedPaths: paths.scannedPaths,
    violations: paths.violations,
  };
}

/**
 * Scan bytes produced by a real managed runtime without claiming that this
 * path-only probe executed the higher-level storage scenarios. The scenario
 * report and this clean-machine filesystem evidence are deliberately separate.
 */
export function scanRuntimeDataPaths(root) {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`Runtime data directory does not exist: ${root}`);
  const violations = [];
  const scanned = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        violations.push(`${path}: symlink is not allowed in managed runtime data`);
        continue;
      }
      scanned.push(path);
      if (entry.isDirectory()) {
        if (FORBIDDEN_PATHS.some((pattern) => pattern.test(path))) violations.push(`${path}: native durable history directory`);
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        violations.push(`${path}: non-regular filesystem entry`);
        continue;
      }
      const inEphemeralDiagnostics = path.startsWith('cache/') || path.startsWith('logs/');
      if (FORBIDDEN_PATHS.some((pattern) => pattern.test(path))
        || (!inEphemeralDiagnostics && basename(path).toLowerCase().endsWith('.jsonl'))) {
        violations.push(`${path}: native durable history file`);
      }
    }
  };
  visit(root);
  return {
    ok: violations.length === 0,
    scannedPaths: scanned,
    violations,
  };
}
