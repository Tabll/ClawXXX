#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { sha256File, writeCanonicalJson } from './lib/canonical.mjs';
import { REQUIRED_STORAGE_SCENARIOS } from './lib/storage-contract.mjs';

const REQUIRED_SCENARIO_SUITES = [
  'tests/contract/data/blob-and-conversation-store.test.ts',
  'tests/contract/domains/channels-runtime.test.ts',
  'tests/contract/domains/scheduler.test.ts',
  'tests/contract/kernels/conversation-router.test.ts',
  'tests/contract/kernels/data-service-spike.test.ts',
  'tests/contract/kernels/history-cutover.test.ts',
  'tests/contract/kernels/kernel-driver-contract.test.ts',
];

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const type = args.get('--type');
const output = args.get('--output');
const kernelId = args.get('--kernel');
const suites = csv('--suites');
if (!output || !kernelId || !/^[a-z0-9][a-z0-9-]*$/.test(kernelId) || (type !== 'tests' && type !== 'scenarios')) {
  throw new Error('Usage: write-build-report --type tests|scenarios --kernel KERNEL --output FILE --suites SUITE[,SUITE] --vitest-report FILE [--completed SCENARIO[,SCENARIO]]');
}
if (suites.length === 0) throw new Error('Build evidence must name at least one completed test suite');
const vitestProof = verifyVitestProof(args.get('--vitest-report'), suites);
const common = {
  schemaVersion: 1,
  ok: true,
  kernelId,
  sourceDateEpoch: Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? '0', 10),
  ciRunId: process.env.GITHUB_RUN_ID ?? 'local',
};
let report;
if (type === 'tests') {
  report = { ...common, evidenceKind: 'verified-vitest-report', suites, vitestProof };
} else {
  const completed = csv('--completed');
  const missing = REQUIRED_STORAGE_SCENARIOS.filter((scenario) => !completed.includes(scenario));
  const unknown = completed.filter((scenario) => !REQUIRED_STORAGE_SCENARIOS.includes(scenario));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`Storage scenario evidence must exactly cover the required scenarios; missing=${missing.join(',') || 'none'} unknown=${unknown.join(',') || 'none'}`);
  }
  const missingSuites = REQUIRED_SCENARIO_SUITES.filter((suite) => !suites.includes(suite));
  const kernelSuite = suites.find((suite) => basename(suite).includes(kernelId));
  if (missingSuites.length > 0 || !kernelSuite) {
    throw new Error(`Storage scenario proof is incomplete; missingSuites=${missingSuites.join(',') || 'none'} kernelSpecificSuite=${kernelSuite ?? 'missing'}`);
  }
  report = {
    ...common,
    evidenceKind: 'verified-source-contract-suites',
    suites,
    vitestProof,
    completedScenarios: REQUIRED_STORAGE_SCENARIOS,
    ...Object.fromEntries(REQUIRED_STORAGE_SCENARIOS.map((scenario) => [scenario, true])),
  };
}
writeCanonicalJson(resolve(output), report);
process.stdout.write(`${JSON.stringify({ ok: true, type, output: resolve(output) })}\n`);

function csv(name) {
  return [...new Set((args.get(name) ?? '').split(',').map((value) => value.trim()).filter(Boolean))].sort();
}

function verifyVitestProof(reportPath, suites) {
  if (!reportPath) throw new Error('Build evidence requires --vitest-report from the completed Vitest invocation');
  const absolutePath = resolve(reportPath);
  const proof = JSON.parse(readFileSync(absolutePath, 'utf8'));
  if (proof?.success !== true
    || proof.numFailedTests !== 0
    || proof.numPendingTests !== 0
    || proof.numTodoTests !== 0
    || proof.numTotalTests !== proof.numPassedTests
    || !Array.isArray(proof.testResults)
    || proof.testResults.length === 0) {
    throw new Error('Vitest build proof is incomplete, failed, pending, or empty');
  }
  const passedFiles = proof.testResults
    .filter((result) => result?.status === 'passed'
      && Array.isArray(result.assertionResults)
      && result.assertionResults.length > 0
      && result.assertionResults.every((assertion) => assertion?.status === 'passed'))
    .map((result) => String(result.name).split(sep).join('/'));
  const missing = suites.filter((suite) => !passedFiles.some((file) => file.endsWith(`/${suite}`)));
  if (missing.length > 0) throw new Error(`Vitest proof does not contain passing results for: ${missing.join(',')}`);
  return {
    reportFile: basename(absolutePath),
    reportSha256: sha256File(absolutePath),
    totalTests: proof.numTotalTests,
    passedTests: proof.numPassedTests,
    verifiedSuites: suites.length,
  };
}
