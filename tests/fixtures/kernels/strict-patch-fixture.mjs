import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// All config writes belong to the caller's disposable Git repository. Keep
// actual Git index/commit bytes, but avoid four git-config subprocess launches.
export function createStrictPatchFixture(path, content) {
  mkdirSync(path, { recursive: true });
  const commands = [];
  const git = args => {
    commands.push(args);
    return execFileSync('git', args, { cwd: path, windowsHide: true, timeout: 2_000 });
  };
  git(['init', '--quiet']);
  appendFileSync(join(path, '.git', 'config'), [
    '\n[core]', '\tautocrlf = false', '\teol = lf',
    '[user]', '\tname = ClawX Test', '\temail = tests@claw-x.invalid',
    '[commit]', '\tgpgsign = false', '',
  ].join('\n'));
  writeFileSync(join(path, 'value.txt'), content);
  git(['add', 'value.txt']);
  git(['commit', '--quiet', '-m', 'fixture']);
  return { path, commands };
}
