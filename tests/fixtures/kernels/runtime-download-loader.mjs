// Preloaded only by the offline download CLI regression tests. Production
// downloaders have no test URL, verification bypass or filesystem injection.
import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const fixture = JSON.parse(fs.readFileSync(process.env.CLAWX_RUNTIME_DOWNLOAD_FIXTURE, 'utf8'));
const audit = { stagingRoots: [], renames: [], requests: [] };
const saveAudit = () => fs.writeFileSync(fixture.auditPath, JSON.stringify(audit));
saveAudit();

// Model the Windows runner's C: system temp and D: checkout on every OS.
// Real fs operations still run; only a cross-volume rename is rejected.
os.tmpdir = () => fixture.systemTemp;
function volume(path) {
  const pathFromWorkspace = relative(fixture.workspace, resolve(path));
  return pathFromWorkspace !== '..' && !pathFromWorkspace.startsWith(`..${sep}`)
    && !isAbsolute(pathFromWorkspace) ? 'checkout' : 'system';
}
const originalMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = (...args) => {
  const directory = originalMkdtemp(...args);
  audit.stagingRoots.push(directory);
  saveAudit();
  return directory;
};
const originalRename = fs.renameSync;
fs.renameSync = (source, destination) => {
  const crossVolume = volume(source) !== volume(destination);
  audit.renames.push({ source, destination, crossVolume });
  saveAudit();
  if (crossVolume) {
    throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${source}' -> '${destination}'`), { code: 'EXDEV' });
  }
  return originalRename(source, destination);
};
syncBuiltinESMExports();

globalThis.fetch = async (input) => {
  const url = String(input);
  audit.requests.push(url);
  saveAudit();
  const response = fixture.responses.find((candidate) => candidate.url === url);
  if (!response) throw new Error(`Network access is forbidden in the download fixture: ${url}`);
  return new Response(response.path ? fs.readFileSync(response.path) : null, { status: response.status ?? 200 });
};
