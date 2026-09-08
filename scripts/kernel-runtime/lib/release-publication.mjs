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
  let currentRecord = current ? await readRequiredRecord(io, current.sequence, context) : undefined;
  if (currentRecord && digestJson(currentRecord.catalog) !== digestJson(current)) throw new Error('Current catalog does not match its immutable release record');
  let record;
  if (catalogs.partial) {
    // GitHub implements catalog replacement as delete + upload. A crash in
    // between may leave N/404 at any sequence, not just bootstrap. Reconstruct
    // the predecessor from its signed journal, never from an absent pointer.
    if (!catalogs.previous && current.sequence > 1) {
      catalogs.previous = (await readRequiredRecord(io, current.sequence - 1, context)).catalog;
    }
    if (currentRecord.previousCatalogSha256 !== (catalogs.previous ? digestJson(catalogs.previous) : null)) {
      throw new Error('Partial publication predecessor differs from the signed release record');
    }
    if (!candidate && (!catalogs.previous || fingerprint(catalogs.previous.artifacts) !== currentRecord.artifactsSha256)) {
      throw new Error('An interrupted new-runtime publication requires its original accepted candidate');
    }
    if (!catalogs.previous && !input.bootstrap) throw new Error('Resuming first publication requires explicit protected bootstrap');
    record = currentRecord;
    assertRetryCandidate(record, candidate, descriptors);
  } else {
    if (!current && (!input.bootstrap || !candidate)) throw new Error('First publication requires an explicitly approved bootstrap candidate');
    const next = await io.readRecord((current?.sequence ?? 0) + 1);
    if (next) {
      record = verifyReleaseRecord(next, context);
      if (record.previousCatalogSha256 !== (current ? digestJson(current) : null)) throw new Error('Pending release has a different predecessor');
      if (!candidate && (!current || fingerprint(current.artifacts) !== record.artifactsSha256)) {
        throw new Error('Pending runtime publication must resume with its original accepted candidate');
      }
      assertRetryCandidate(record, candidate, descriptors);
    } else {
      const unchanged = current && (!candidate || fingerprint(descriptors) === fingerprint(current.artifacts));
      const needsRenewal = current && Date.parse(current.expiresAt) - now.getTime() <= policy.renewBeforeHours * HOUR;
      if (unchanged && !needsRenewal) {
        // A duplicate event may repair a missing record mirror or finish cleanup,
        // but must not mint another sequence or re-upload retired package bytes.
        await io.writeRecord(currentRecord);
        await io.verifyOnline(current, true);
        return { mode: 'already-published', sequence: current.sequence,
          cleanup: await cleanRetiredRuntimes({ ...input, record: currentRecord, now }) };
      }
      const pending = [];
      for (const item of currentRecord?.retirements ?? []) {
        const receipt = await io.readReceipt(item);
        if (receipt) {
          verifyRetirementReceipt(receipt, item, { trustStore, now });
          // A receipt may exist on only one mirror after interruption. Repair
          // both before omitting its retirement from the next signed journal.
          await io.writeReceipt(item, receipt);
        } else pending.push(item);
      }
      record = createReleaseRecord({ ...input, descriptors: candidate ? descriptors : current.artifacts,
        source: candidate ?? currentRecord.source, previousCatalog: current,
        previousRecord: currentRecord ? { ...currentRecord, retirements: pending } : undefined, now });
    }
  }
  verifyCatalogEnvelope(record.catalog, trustStore, now);
  // Record/reservation first: even a crash before the first catalog PUT retains
  // exact issue time, sequence, predecessor, approved source and retirement list.
  await io.writeRecord(record);
  if (candidate) await io.uploadAssets(record.catalog);
  await io.verifyOnline(record.catalog, false);
  await assertSwitchableCatalogs(io, catalogs, record, context);
  await io.writeCatalog(record.catalog);
  await assertLiveCatalog(io, record.catalog, context);
  await io.verifyOnline(record.catalog, true);
  current = record.catalog;
  currentRecord = record;
  return { mode: catalogs.partial ? 'resumed-publication' : candidate ? 'published' : 'renewed',
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

export async function readCatalogState(io, { trustStore, now }) {
  const observed = await io.readCatalogs();
  if (!Array.isArray(observed) || observed.length !== 2) throw new Error('Both configured catalog mirrors must be observed');
  const present = observed.filter(Boolean);
  for (const catalog of present) verifyHistoricalCatalog(catalog, trustStore, now);
  if (!present.length) return { latest: undefined, previous: undefined, partial: false, observed };
  const sorted = [...present].sort((a, b) => a.sequence - b.sequence);
  const latest = sorted.at(-1);
  const previous = sorted[0].sequence < latest.sequence ? sorted[0] : undefined;
  if (previous && latest.sequence !== previous.sequence + 1) throw new Error('Catalog mirrors have a non-adjacent sequence fork');
  if (!previous && present.length === 2 && canonicalJson(sorted[0]) !== canonicalJson(latest)) throw new Error('Catalog mirrors have a same-sequence fork');
  return { latest, previous, partial: Boolean(previous || present.length !== 2), observed };
}

async function readRequiredRecord(io, sequence, context) {
  const record = await io.readRecord(sequence);
  if (!record) throw new Error('Production catalog lacks an immutable signed release record; manual reconciliation is required');
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
    throw new Error('Publication/cleanup requires the exact same live catalog on both mirrors');
  }
}
