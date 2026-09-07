#!/usr/bin/env node
import { notarizeArchive } from './lib/notarization.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
function required(name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
const result = await notarizeArchive({
  archivePath: required('--archive'), keychainProfile: required('--keychain-profile'),
  journalPath: required('--submission'), reportPath: required('--report'),
});
process.stdout.write(`${JSON.stringify(result)}\n`);
