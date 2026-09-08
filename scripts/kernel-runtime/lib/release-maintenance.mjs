import { fetchBoundedJson } from './release-http.mjs';
import { digestJson, recordName, receiptName, HOUR } from './release-record.mjs';

// This job has no production trust/signing secrets. Public data may only queue
// an approval or suppress needless runs, never authorize a write or deletion.
// The protected publisher independently verifies every signature and target.
export async function maintenanceHint({ policy, fetcher = fetch, now = new Date() }) {
  const cos = `https://${policy.cos.bucket}.cos.${policy.cos.region}.tencentcos.cn/${policy.cos.rootPrefix}/${policy.cos.kernelPrefix}/`;
  const github = `https://github.com/${policy.repository}/releases/download/${policy.githubReleaseTag}/`;
  const read = url => fetchBoundedJson(url, { fetcher, allowMissing: true, redirect: 'follow', maxBytes: 8 * 1024 * 1024,
    headers: { 'Cache-Control': 'no-cache, no-store' } });
  const catalogs = await Promise.all([`${cos}catalog.production.json`, `${github}kernel-catalog.production.json`].map(read));
  if (catalogs.every(c => !c)) return { eligible: false, reason: 'Initial bootstrap requires manual approval and an accepted build' };
  if (catalogs.some(c => !c) || digestJson(catalogs[0]) !== digestJson(catalogs[1])) {
    return { eligible: true, reason: 'Catalog mirrors need protected reconciliation' };
  }
  const catalog = catalogs[0];
  const expiry = Date.parse(catalog.expiresAt);
  if (!Number.isFinite(expiry)) throw new Error('Invalid public catalog expiry hint');
  if (expiry - now.getTime() <= policy.renewBeforeHours * HOUR) return { eligible: true, reason: 'Catalog renewal due' };
  const records = await Promise.all([`${cos}metadata/${recordName(catalog.sequence)}`, `${github}${recordName(catalog.sequence)}`].map(read));
  if (records.some(r => !r) || digestJson(records[0]) !== digestJson(records[1])) return { eligible: true, reason: 'Release record mirrors need reconciliation' };
  const record = records[0];
  if (!Array.isArray(record.retirements) || record.retirements.length > 1000) throw new Error('Invalid bounded retirement hint');
  for (const item of record.retirements) {
    if (!Number.isFinite(Date.parse(item.deleteAfter))) throw new Error('Invalid retirement time hint');
    if (Date.parse(item.deleteAfter) > now.getTime()) continue;
    const name = receiptName(item); // Locally computed hash, never a remote path.
    const receipts = await Promise.all([`${cos}metadata/${name}`, `${github}${name}`].map(read));
    if (receipts.some(r => !r) || digestJson(receipts[0]) !== digestJson(receipts[1])) return { eligible: true, reason: 'Safe retirement or receipt repair due' };
  }
  return { eligible: false, reason: 'Catalog valid; no retirement due' };
}
