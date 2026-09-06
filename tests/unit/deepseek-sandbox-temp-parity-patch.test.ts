// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function text(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('DeepSeek Harness Windows ambient-temp parity patch', () => {
  it('narrows the model-facing filesystem root without widening the Windows ACL runner', () => {
    const source = JSON.parse(text('kernels/deepseek-harness/source.json')) as {
      artifactVersion: string;
      patchRevision: number;
      patches: Array<{ path: string }>;
    };
    const patchPath = 'kernels/deepseek-harness/patches/0002-clawx-windows-sandbox-temp-parity.patch';
    const patch = text(patchPath);
    const targets = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)]
      .map((match) => [match[1], match[2]]);

    expect(source).toMatchObject({
      artifactVersion: '0.1.2-alpha.2+clawx.10',
      patchRevision: 10,
    });
    expect(source.patches.map((entry) => entry.path)).toEqual([
      'kernels/deepseek-harness/patches/0001-clawx-overlay-lockfile.patch',
      patchPath,
    ]);
    expect(targets).toEqual([
      ['packages/sandbox/sandbox/src/roots.ts', 'packages/sandbox/sandbox/src/roots.ts'],
      ['packages/sandbox/sandbox/tests/roots.spec.ts', 'packages/sandbox/sandbox/tests/roots.spec.ts'],
    ]);
    expect(patch).toContain("process.platform === 'win32'");
    expect(patch).toContain('? [policy.workspaceRoot]');
    expect(patch).toContain('expect(roots).toEqual([realpathSync.native(ws)])');
    expect(patch).not.toContain('sandbox-windows-acl/src');
  });

  it('runs the upstream roots regression and requires both real Windows denial probes', () => {
    const workflow = text('.github/workflows/kernel-runtime-build.yml');
    const host = text('kernels/deepseek-harness/overlay/packages/runtime/clawx-runtime-host/src/index.ts');
    const artifactSmoke = text('scripts/kernel-runtime/runtime-artifact-smoke.mjs');

    expect(workflow).toContain('packages/sandbox/sandbox/tests/roots.spec.ts');
    expect(host).toContain("windowsAmbientTempDenied: true | 'not-applicable'");
    expect(host).toContain('DeepSeek Harness Windows shell wrote the ambient temp root');
    expect(host).toContain('DeepSeek Harness file tool wrote the Windows ambient temp root');
    expect(host).toContain("ambientToolError.includes('[sandbox:')");
    expect(artifactSmoke).toContain(
      "windowsAmbientTempDenied !== (process.platform === 'win32' ? true : 'not-applicable')",
    );
  });
});
