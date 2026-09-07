import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalJson, sha256File } from './canonical.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS = new Set(['In Progress', 'Accepted', 'Invalid', 'Rejected']);
const TOTAL_MS = 40 * 60_000;
const QUERY_MS = 90_000;
const SUBMIT_MS = 10 * 60_000;

// Never return/log execFile's message: it can contain command-line credentials.
export function boundedCommand(executable, args, timeoutMs) {
  return new Promise(resolveResult => {
    execFile(executable, args, {
      encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
      windowsHide: true, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => resolveResult({
      ok: !error, stdout, stderr,
      code: error?.code ?? 0,
      timedOut: error?.killed === true && error?.signal === 'SIGKILL',
    }));
  });
}

export function isTransientNotaryFailure(result) {
  const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  // Authentication, permissions and TLS validation are not transient failures.
  if (/statusCode:\s*(?:400|401|403)|HTTP(?: status)?[ :]+(?:400|401|403)|invalid credentials|unauthorized|forbidden|NSURLErrorDomain Code=-120\d/i.test(detail)) return false;
  if (result.timedOut) return true;
  if (['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(result.code)) return true;
  return /NSURLErrorDomain Code=-(?:1001|1003|1004|1005|1009)\b|statusCode:\s*(?:408|429|500|502|503|504)\b|HTTP(?: status)?[ :]+(?:408|429|500|502|503|504)\b/i.test(detail);
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function submissionIdentity(result) {
  const json = parseJson(result.stdout);
  if (json?.id !== undefined) {
    if (typeof json.id !== 'string' || !UUID.test(json.id)) throw new Error('Malformed notarization submission ID');
    return json.id.toLowerCase();
  }
  // notarytool can print the accepted request's URL when a later read fails.
  // Only recover an unambiguous Apple submission URL, never an arbitrary UUID.
  const ids = new Set([...`${result.stdout ?? ''}\n${result.stderr ?? ''}`.matchAll(
    /https:\/\/appstoreconnect\.apple\.com\/notary\/v2\/submissions\/([0-9a-f-]{36})(?=[?\s"),]|$)/gi,
  )].map(match => match[1].toLowerCase()).filter(id => UUID.test(id)));
  if (ids.size > 1) throw new Error('Ambiguous notarization submission IDs');
  return [...ids][0];
}

function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${canonicalJson(value)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Submit once, then recover only read-only status requests for that archive. */
export async function notarizeArchive({
  archivePath, keychainProfile, journalPath, reportPath,
  timeoutMs = TOTAL_MS,
  command = (args, timeout) => boundedCommand('xcrun', ['notarytool', ...args], timeout),
  now = () => performance.now(),
  sleep = ms => new Promise(done => setTimeout(done, ms)),
}) {
  if (!keychainProfile || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > TOTAL_MS) {
    throw new Error('A keychain profile and a positive notarization budget of at most 40 minutes are required');
  }
  const archive = resolve(archivePath);
  const journalFile = resolve(journalPath);
  const reportFile = resolve(reportPath);
  if (new Set([archive, journalFile, reportFile]).size !== 3) throw new Error('Archive, journal and report paths must be distinct');
  const archiveSha256 = sha256File(archive);
  for (const path of [journalFile, reportFile]) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let id;
  let polls = 0;
  let lastStatus;
  const deadline = now() + timeoutMs;
  const remaining = cap => {
    const ms = Math.min(cap, Math.ceil(deadline - now()));
    if (ms <= 0) throw new Error('Notarization deadline exceeded; resume the recorded submission, do not resubmit');
    return ms;
  };
  const report = (status, extra = {}) => atomicJson(reportFile, {
    schemaVersion: 1, ok: status === 'Accepted', status, archiveSha256,
    ...id ? { id } : {}, pollAttempts: polls, ...extra,
  });
  const recordId = () => atomicJson(journalFile, { schemaVersion: 1, archiveSha256, phase: 'submitted', id });
  report('Pending'); // A failed retry must not leave an earlier Accepted report.
  try {
    if (existsSync(journalFile)) {
      const saved = JSON.parse(readFileSync(journalFile, 'utf8'));
      if (saved.schemaVersion !== 1 || saved.archiveSha256 !== archiveSha256) throw new Error('Notarization journal does not match the exact archive');
      if (saved.phase !== 'submitted' || typeof saved.id !== 'string' || !UUID.test(saved.id)) {
        throw new Error('Previous submission outcome is uncertain; reconcile its ID before retrying, do not resubmit');
      }
      id = saved.id.toLowerCase();
    } else {
      // Exclusive creation is the write-ahead marker. A crash or an ambiguous
      // upload response cannot silently turn the next invocation into an upload.
      writeFileSync(journalFile, `${canonicalJson({ schemaVersion: 1, archiveSha256, phase: 'submitting' })}\n`, { flag: 'wx', mode: 0o600 });
      const submitted = await command(['submit', archive, '--keychain-profile', keychainProfile, '--no-wait', '--output-format', 'json'], remaining(SUBMIT_MS));
      id = submissionIdentity(submitted);
      if (id) recordId(); // Save before any wait, parsing or transient retry.
      if (!id) throw new Error('Submission outcome is uncertain or no ID was returned; reconcile before retrying, do not resubmit');
      if (!submitted.ok && !isTransientNotaryFailure(submitted)) throw new Error('Notarization submission failed; inspect the recorded submission and credentials');
    }
    let transientFailures = 0;
    for (;;) {
      const timeout = remaining(QUERY_MS);
      polls += 1;
      report('In Progress');
      const result = await command(['info', id, '--keychain-profile', keychainProfile, '--output-format', 'json'], timeout);
      remaining(QUERY_MS); // A late Accepted result is not deadline success.
      const response = parseJson(result.stdout);
      if (response?.id !== undefined && (typeof response.id !== 'string' || response.id.toLowerCase() !== id)) {
        throw new Error('Notarization response refers to a different submission');
      }
      if (!result.ok) {
        if (!isTransientNotaryFailure(result)) throw new Error('Non-retryable notarization status failure; check authentication, permissions or tool diagnostics');
        transientFailures += 1;
        if (transientFailures > 5) throw new Error('Notarization status retry limit exceeded; resume the recorded submission later');
        report('In Progress', { transientFailures });
        await sleep(remaining(Math.min(5_000 * 2 ** (transientFailures - 1), 30_000)));
        continue;
      }
      if (!response || typeof response.id !== 'string' || response.id.toLowerCase() !== id || !STATUS.has(response.status)) {
        throw new Error('Malformed or unknown notarization status response');
      }
      transientFailures = 0;
      lastStatus = response.status;
      if (lastStatus === 'Accepted') {
        // The archive must still be the one whose submission was persisted.
        if (sha256File(archive) !== archiveSha256) throw new Error('Archive changed during notarization');
        remaining(QUERY_MS);
        report('Accepted');
        return { id, status: 'Accepted', archiveSha256, pollAttempts: polls };
      }
      if (lastStatus !== 'In Progress') throw new Error(`Notarization ${lastStatus}; inspect notarytool log for submission ${id}`);
      await sleep(remaining(15_000));
    }
  } catch (error) {
    // Only our bounded classifications are persisted; stderr can contain secrets.
    const message = error instanceof Error ? error.message : 'Notarization failed';
    const safeMessage = /^(Notarization |Malformed |Ambiguous |A keychain |Archive |Previous submission |Submission outcome |Non-retryable )/.test(message) ? message : 'Notarization failed while executing the tool or persisting evidence';
    report('Failed', { error: safeMessage, ...lastStatus ? { lastStatus } : {} });
    throw new Error(safeMessage);
  }
}
