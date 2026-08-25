// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CredentialStagingVault } from '@electron/security/credential-staging-vault';
import { REDACTED_SECRET, redactSecrets } from '@electron/security/secret-redaction';

describe('Provider credential transport boundary', () => {
  it('uses expiring one-time handles and never returns a consumed value again', () => {
    let now = 1_000;
    const vault = new CredentialStagingVault({ ttlMs: 100, now: () => now });
    const handle = vault.stage('sk-one-time-secret-value');
    expect(handle).toMatch(/^credential-stage:\/\//);
    expect(handle).not.toContain('sk-one-time-secret-value');
    expect(vault.read(handle)).toBe('sk-one-time-secret-value');
    expect(vault.consume(handle)).toBe('sk-one-time-secret-value');
    expect(() => vault.read(handle)).toThrow(/invalid or expired/);

    const expiring = vault.stage('sk-expiring-secret-value');
    now += 101;
    expect(() => vault.read(expiring)).toThrow(/invalid or expired/);
  });

  it('redacts nested credentials and keeps raw Provider IPC out of the preload allowlist', () => {
    const secret = 'sk-super-private-value-123456';
    const redacted = redactSecrets({
      authorization: `Bearer ${secret}`,
      nested: { message: `request failed for ${secret}`, safe: 'provider unavailable' },
    });
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(JSON.stringify(redacted)).toContain(REDACTED_SECRET);

    const preload = readFileSync(join(process.cwd(), 'electron/preload/index.ts'), 'utf8');
    for (const channel of [
      'app:request',
      'provider:getApiKey',
      'provider:setApiKey',
      'provider:save',
      'provider:updateWithKey',
      'provider:validateKey',
    ]) {
      expect(preload).not.toContain(`'${channel}'`);
    }

    const secureInput = readFileSync(join(process.cwd(), 'electron/preload/secure-secret-input.js'), 'utf8');
    expect(secureInput).toContain("attachShadow({ mode: 'closed' })");
    expect(secureInput).toContain("ipcRenderer.invoke('credential:stage'");
    expect(secureInput).not.toContain('detail: { value:');
  });
});
