import { fetchBoundedJson } from './release-http.mjs';
import { digestJson, recordName, receiptName, HOUR } from './release-record.mjs';
import { releaseDistribution } from './release-policy.mjs';

// This job has no production trust/signing secrets. Public data may only queue
// an approval or suppress needless runs, never authorize a write or deletion.
// The protected publisher independently verifies every signature and target.
export async function maintenanceHint({ policy, fetcher = fetch, now = new Date() }) {
  const distribution = releaseDistribution(policy);
  const github = distribution.mirrorBaseUrls[0];
  const read = url => fetchBoundedJson(url, { fetcher, allowMissing: true, redirect: 'follow', maxBytes: 8 * 1024 * 1024,
    headers: { 'Cache-Control': 'no-cache, no-store' } });
  const catalog = await read(distribution.catalogUrls[0]);
  if (!catalog) {
    // A missing pointer may be the delete/upload window, not an empty release.
    const first = await read(`${github}${recordName(1)}`);
    return first ? { eligible: true, reason: 'Missing catalog needs protected journal recovery' }
      : { eligible: false, reason: 'Initial bootstrap requires manual approval and an accepted build' };
  }
  const expiry = Date.parse(catalog.expiresAt);
  if (!Number.isFinite(expiry)) throw new Error('Invalid public catalog expiry hint');
  if (expiry - now.getTime() <= policy.renewBeforeHours * HOUR) return { eligible: true, reason: 'Catalog renewal due' };
  const record = await read(`${github}${recordName(catalog.sequence)}`);
  if (!record || digestJson(record.catalog) !== digestJson(catalog)) return { eligible: true, reason: 'Release record needs reconciliation' };
  if (await read(`${github}${recordName(catalog.sequence + 1)}`)) return { eligible: true, reason: 'Pending publication needs protected reconciliation' };
  if (!Array.isArray(record.retirements) || record.retirements.length > 1000) throw new Error('Invalid bounded retirement hint');
  for (const item of record.retirements) {
    if (!Number.isFinite(Date.parse(item.deleteAfter))) throw new Error('Invalid retirement time hint');
    if (Date.parse(item.deleteAfter) > now.getTime()) continue;
    const name = receiptName(item); // Locally computed hash, never a remote path.
    if (!await read(`${github}${name}`)) return { eligible: true, reason: 'Safe retirement or receipt repair due' };
  }
  return { eligible: false, reason: 'Catalog valid; no retirement due' };
}
