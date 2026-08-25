#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, readJson, sha256Bytes, writeCanonicalJson } from './lib/canonical.mjs';

const FORBIDDEN_LICENSE = /^(?:UNLICENSED|NOASSERTION|NONE|SEE LICEN[CS]E)/i;
const COPYLEFT = /(?:^|[^A-Z])(?:GPL|LGPL|AGPL|MPL)-/i;
const PERMISSIVE_OR_BRANCH = /(?:MIT|Apache|BSD|ISC|0BSD|BlueOak|Unlicense)\s+OR\s+/i;

export function auditRuntimeLicenses(input) {
  const payloadRoot = resolve(input.payloadRoot);
  if (!existsSync(payloadRoot)) throw new Error(`Runtime payload does not exist: ${payloadRoot}`);
  const policy = input.policy ?? readJson(resolve(input.policyPath ?? join(process.cwd(), 'kernels', 'license-policy.json')));
  validatePolicy(policy);
  const allowed = new Set(policy.allowedLicenses);
  const records = [];

  for (const packagePath of packageJsonFiles(payloadRoot)) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid package.json during license audit: ${packagePath}: ${String(error)}`);
    }
    // Export maps and package-internal compatibility stubs can be named
    // package.json without representing a distributable package.
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') continue;
    const identity = `${pkg.name}@${pkg.version}`;
    const declared = declaredLicense(pkg);
    if (declared && FORBIDDEN_LICENSE.test(declared)) {
      throw new Error(`Forbidden license metadata ${declared} for ${identity}`);
    }

    const override = policy.overrides.find(item => item.name === pkg.name && item.version === pkg.version);
    let license = override?.license ?? declared;
    let resolution = override ? 'override' : 'declared';
    let evidence = override?.evidence;
    if (!license) {
      const inherited = policy.inheritance.find(item => (
        new RegExp(item.namePattern, 'u').test(pkg.name)
        && new RegExp(item.versionPattern, 'u').test(pkg.version)
      ));
      if (!inherited) throw new Error(`Missing and unreviewed license metadata for ${identity}`);
      license = inherited.license;
      resolution = 'inherited';
      evidence = inherited.evidence;
    }
    if (FORBIDDEN_LICENSE.test(license) || !allowed.has(license)) {
      throw new Error(`Unreviewed license ${license} for ${identity}`);
    }

    const obligation = requiresObligation(license)
      ? policy.obligations.find(item => (
        new RegExp(item.packagePattern, 'u').test(pkg.name)
        && new RegExp(item.licensePattern, 'u').test(license)
      ))
      : undefined;
    if (requiresObligation(license) && !obligation) {
      throw new Error(`Copyleft package ${identity} (${license}) has no explicit redistribution obligation record`);
    }
    records.push({
      name: pkg.name,
      version: pkg.version,
      license,
      resolution,
      ...(override && declared && declared !== license ? { declaredLicense: declared } : {}),
      ...(evidence ? { evidence } : {}),
      ...(obligation ? { obligationId: obligation.id } : {}),
      path: relative(payloadRoot, packagePath).replaceAll('\\', '/'),
    });
  }
  if (records.length === 0) throw new Error('Runtime payload contains no auditable packages');
  records.sort((left, right) => (
    left.name.localeCompare(right.name)
    || left.version.localeCompare(right.version)
    || left.path.localeCompare(right.path)
  ));
  const unique = new Map();
  for (const record of records) {
    const identity = `${record.name}@${record.version}`;
    const prior = unique.get(identity);
    if (prior && prior.license !== record.license) {
      throw new Error(`Conflicting licenses for duplicate package ${identity}: ${prior.license} / ${record.license}`);
    }
    if (!prior) unique.set(identity, record);
  }
  return {
    schemaVersion: 1,
    ok: true,
    kernelId: input.kernelId,
    policySha256: sha256Bytes(canonicalJson(policy)),
    packageFiles: records.length,
    uniquePackages: unique.size,
    obligationIds: [...new Set(records.flatMap(record => record.obligationId ? [record.obligationId] : []))].sort(),
    packages: records,
  };
}

function validatePolicy(policy) {
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.allowedLicenses)
    || !Array.isArray(policy.overrides) || !Array.isArray(policy.inheritance)
    || !Array.isArray(policy.obligations)) {
    throw new Error('License policy must be a complete v1 policy');
  }
  for (const item of [...policy.inheritance, ...policy.obligations]) {
    for (const key of ['namePattern', 'versionPattern', 'packagePattern', 'licensePattern']) {
      if (item[key] !== undefined) new RegExp(item[key], 'u');
    }
  }
}

function declaredLicense(pkg) {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return normalizeLicense(pkg.license);
  if (Array.isArray(pkg.licenses)) {
    const values = pkg.licenses
      .map(item => typeof item === 'string' ? item : item?.type)
      .filter(item => typeof item === 'string' && item.trim())
      .map(normalizeLicense);
    if (values.length > 0) return [...new Set(values)].join(' OR ');
  }
  return undefined;
}

function normalizeLicense(value) {
  const trimmed = value.trim();
  if (/^Apache(?: License)?(?:,? Version)? 2(?:\.0)?$/i.test(trimmed)) return 'Apache-2.0';
  return trimmed;
}

function requiresObligation(license) {
  return COPYLEFT.test(license) && !PERMISSIVE_OR_BRANCH.test(license);
}

function packageJsonFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Runtime license audit refuses symbolic links: ${path}`);
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isFile() && basename(path) === 'package.json') files.push(path);
    }
  }
  return files.sort();
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  for (const required of ['--payload', '--kernel', '--report']) {
    if (!args.get(required)) throw new Error(`Missing ${required}`);
  }
  const report = auditRuntimeLicenses({
    payloadRoot: args.get('--payload'),
    kernelId: args.get('--kernel'),
    policyPath: args.get('--policy'),
  });
  const output = resolve(args.get('--report'));
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeCanonicalJson(output, report);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    kernelId: report.kernelId,
    packages: report.uniquePackages,
    obligations: report.obligationIds,
    report: output,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
