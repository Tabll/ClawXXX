import { canonicalJson } from './canonical.mjs';
import { assertCompleteSet, assertSourceDescriptors } from './release-policy.mjs';
import { verifyCatalogEnvelope } from '../verify-release-set.mjs';
import { createReleaseRecord, verifyReleaseRecord, verifyHistoricalCatalog, digestJson, fingerprint, HOUR,
  retirementDue, createRetirementReceipt, verifyRetirementReceipt } from './release-record.mjs';

// The I/O adapter owns scoped writes. This state machine remains deterministic
// and failure-injectable; it never discovers deletion targets by bucket listing.
export async function publishRuntimeRelease(input) {
  const { io, policy, trustStore, distribution, candidate, descriptors, now = new Date() } = input;
  const context = { policy, trustStore, distribution, now };
  if (candidate) { assertCompleteSet(descriptors, policy); assertSourceDescriptors(descriptors, candidate.sources); }
  const catalogs = await readCatalogState(io, context);
  let current = catalogs.latest;
  const journal = await readJournalState(io, current, context);
  const head = journal.head;
  let currentRecord = current ? journal.records.get(current.sequence) : undefined;
  const pending = head && (catalogs.partial || !current || head.sequence !== current.sequence);
  let record;
  const supersede = input.supersedePendingSha256;
  if (supersede !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(supersede) || !candidate || !head) throw new Error('Invalid explicit pending supersession');
    const predecessor = journal.records.get(head.sequence - 1);
    // A retry of a manual supersession must reuse the successor, even after its
    // pointer switched. Never mint another sequence for the same authorization.
    const retry = predecessor && digestJson(predecessor) === supersede
      && head.artifactsSha256 === fingerprint(descriptors) && digestJson(head.source) === digestJson(candidate);
    if (retry && !pending && Date.parse(head.catalog.expiresAt) - now.getTime() <= policy.renewBeforeHours * HOUR) {
      throw new Error('Supersession already completed; renew through normal protected maintenance without the supersession input');
    }
    if (!retry) {
      if (!pending || digestJson(head) !== supersede) throw new Error('Pending supersession digest differs from the reserved signed release intent');
      record = createReleaseRecord({ ...input, source: candidate, previousCatalog: head.catalog, previousRecord: head, now });
    }
  }
  if (!record && pending) {
    if (!current && head.sequence === 1 && !input.bootstrap) throw new Error('Resuming first publication requires explicit protected bootstrap');
    const previous = journal.records.get(head.sequence - 1)?.catalog;
    if (!candidate && (!previous || fingerprint(previous.artifacts) !== head.artifactsSha256)) {
      throw new Error('Pending runtime publication must resume with its original accepted candidate');
    }
    record = head;
    assertRetryCandidate(record, candidate, descriptors);
  } else if (!record) {
    if (!current && (!input.bootstrap || !candidate)) throw new Error('First publication requires an explicitly approved bootstrap candidate');
    const unchanged = current && (!candidate || fingerprint(descriptors) === fingerprint(current.artifacts));
    const needsRenewal = current && Date.parse(current.expiresAt) - now.getTime() <= policy.renewBeforeHours * HOUR;
    if (unchanged && !needsRenewal) {
      // Duplicate events may finish cleanup but never mint another sequence.
      await io.writeRecord(currentRecord);
      await io.verifyOnline(current, true);
      return { mode: 'already-published', sequence: current.sequence,
        cleanup: await cleanRetiredRuntimes({ ...input, record: currentRecord, now }) };
    }
    const retirements = [];
    for (const item of currentRecord?.retirements ?? []) {
      const receipt = await io.readReceipt(item);
      if (receipt) {
        verifyRetirementReceipt(receipt, item, { trustStore, now });
        await io.writeReceipt(item, receipt);
      } else retirements.push(item);
    }
    record = createReleaseRecord({ ...input, descriptors: candidate ? descriptors : current.artifacts,
      source: candidate ?? currentRecord.source, previousCatalog: current,
      previousRecord: currentRecord ? { ...currentRecord, retirements } : undefined, now });
  }
  verifyCatalogEnvelope(record.catalog, trustStore, now);
  // Record/reservation first: even a crash before the first catalog PUT retains
  // exact issue time, sequence, predecessor, approved source and retirement list.
  await io.writeRecord(record);
  if (candidate) await io.uploadAssets(record.catalog);
  await io.verifyOnline(record.catalog, false);
  await assertSwitchableCatalogs(io, catalogs, record, context);
  await assertJournalHead(io, record, context);
  await io.writeCatalog(record.catalog);
  // Let the existing bounded online verifier observe pointer propagation before
  // the strict final read. No cleanup is allowed while any source is stale.
  await io.verifyOnline(record.catalog, true);
  await assertLiveCatalog(io, record.catalog, context);
  current = record.catalog;
  currentRecord = record;
  return { mode: supersede ? 'superseded-publication' : pending ? 'resumed-publication' : candidate ? 'published' : 'renewed',
    sequence: current.sequence, sourceSha: currentRecord.source.sourceSha,
    cleanup: await cleanRetiredRuntimes({ ...input, record: currentRecord, now }) };
}

export async function cleanRetiredRuntimes(input) {
  const { io, policy, trustStore, distribution, record, now = new Date() } = input;
  const context = { policy, trustStore, distribution, now };
  verifyReleaseRecord(record, context);
  await assertLiveCatalog(io, record.catalog, context);
  await io.verifyOnline(record.catalog, true);
  const result = { deleted: [], deferred: [], alreadyCompleted: [] };
  for (const item of record.retirements) {
    const receipt = await io.readReceipt(item);
    if (receipt) {
      verifyRetirementReceipt(receipt, item, { trustStore, now });
      await io.writeReceipt(item, receipt);
      result.alreadyCompleted.push(item.identity);
      continue;
    }
    if (!retirementDue(item, policy, now)) { result.deferred.push({ identity: item.identity, deleteAfter: item.deleteAfter }); continue; }
    // Do not race a later catalog switch, including a manual external publisher.
    await assertLiveCatalog(io, record.catalog, context);
    await io.deleteRetirement(item, record.catalog);
    const completed = createRetirementReceipt(item, record, input);
    verifyRetirementReceipt(completed, item, { trustStore, now });
    await io.writeReceipt(item, completed);
    result.deleted.push(item.identity);
  }
  return result;
}

export async function readCatalogState(io, { trustStore, distribution, now }) {
  const observed = await io.readCatalogs();
  const count = distribution.catalogUrls.length;
  if (!count || !Array.isArray(observed) || observed.length !== count) throw new Error('All configured catalog sources must be observed');
  const present = observed.filter(Boolean);
  for (const catalog of present) verifyHistoricalCatalog(catalog, trustStore, now);
  if (!present.length) return { latest: undefined, previous: undefined, partial: false, observed };
  const sorted = [...present].sort((a, b) => a.sequence - b.sequence);
  const latest = sorted.at(-1);
  const previous = sorted[0].sequence < latest.sequence ? sorted[0] : undefined;
  for (const c of sorted) if (c.sequence === latest.sequence && canonicalJson(c) !== canonicalJson(latest)) throw new Error('Catalog mirrors have a same-sequence fork');
  return { latest, previous, partial: Boolean(previous || present.length !== count), observed };
}

async function recordSequences(io) {
  const sequences = (await io.readRecordSequences()).sort((a, b) => a - b);
  if (sequences.length > 1000 || sequences.some((n, i) => !Number.isSafeInteger(n) || n !== i + 1)) {
    throw new Error('Publication journal has a duplicate, gap or invalid sequence');
  }
  return sequences;
}

async function readJournalState(io, current, context) {
  const sequences = await recordSequences(io);
  if (current && (!sequences.length || current.sequence > sequences.at(-1))) {
    throw new Error('Production catalog lacks an immutable signed release record; manual reconciliation is required');
  }
  const records = new Map();
  // With no pointer, authenticate the entire chain; an absent sole pointer is
  // not evidence that production has never been initialized.
  const start = Math.max(1, (current?.sequence ?? 1) - 1);
  let previous;
  for (const n of sequences.filter(n => n >= start)) {
    const record = await readRequiredRecord(io, n, context);
    if ((previous && record.previousCatalogSha256 !== digestJson(previous.catalog))
      || (n === 1 && record.previousCatalogSha256 !== null)) throw new Error('Publication journal predecessor differs');
    if (n === current?.sequence && digestJson(record.catalog) !== digestJson(current)) throw new Error('Current catalog does not match its immutable release record');
    records.set(n, record);
    previous = record;
  }
  return { records, head: previous };
}

async function assertJournalHead(io, record, context) {
  const sequences = await recordSequences(io);
  if (sequences.at(-1) !== record.sequence || digestJson(await readRequiredRecord(io, record.sequence, context)) !== digestJson(record)) {
    throw new Error('Publication journal changed while preparing publication or cleanup');
  }
}

async function readRequiredRecord(io, sequence, context) {
  const record = await io.readRecord(sequence);
  if (!record) throw new Error('Production catalog lacks an immutable signed release record; manual reconciliation is required');
  if (record.sequence !== sequence) throw new Error('Publication journal filename and signed sequence differ');
  return verifyReleaseRecord(record, context);
}
function assertRetryCandidate(record, candidate, descriptors) {
  if (candidate && (record.artifactsSha256 !== fingerprint(descriptors) || digestJson(record.source) !== digestJson(candidate))) {
    throw new Error('Retry candidate differs from the reserved signed release intent');
  }
}
async function assertSwitchableCatalogs(io, state, record, context) {
  const observed = await readCatalogState(io, context);
  const allowed = new Set([...state.observed.map(c => c ? digestJson(c) : null), digestJson(record.catalog)]);
  if (observed.observed.some(c => !allowed.has(c ? digestJson(c) : null))) throw new Error('Catalog changed while preparing publication');
}
async function assertLiveCatalog(io, catalog, context) {
  verifyCatalogEnvelope(catalog, context.trustStore, context.now);
  const state = await readCatalogState(io, context);
  if (state.partial || state.observed.some(c => !c || digestJson(c) !== digestJson(catalog))) {
    throw new Error('Publication/cleanup requires the exact same live catalog on all configured sources');
  }
  const record = await readRequiredRecord(io, catalog.sequence, context);
  if (digestJson(record.catalog) !== digestJson(catalog)) throw new Error('Live catalog differs from its signed record');
  await assertJournalHead(io, record, context);
}
