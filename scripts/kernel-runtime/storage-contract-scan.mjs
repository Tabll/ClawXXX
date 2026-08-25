#!/usr/bin/env node
import { resolve } from 'node:path';
import { readJson, writeCanonicalJson } from './lib/canonical.mjs';
import { scanRuntimeDataDirectory } from './lib/storage-contract.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const dataDir = args.get('--data-dir');
const scenariosPath = args.get('--scenarios');
const reportPath = args.get('--report');
if (!dataDir || !scenariosPath || !reportPath) {
  throw new Error('Usage: storage-contract-scan --data-dir DIR --scenarios FILE --report FILE');
}
const report = scanRuntimeDataDirectory(resolve(dataDir), readJson(resolve(scenariosPath)));
writeCanonicalJson(resolve(reportPath), report);
if (!report.ok) {
  process.stderr.write(`${report.violations.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ ok: true, scannedPaths: report.scannedPaths.length })}\n`);
}
