// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('DataService SQL ownership boundary', () => {
  it('keeps node:sqlite imports in the owner store implementation only', () => {
    const productionFiles = [
      'electron/data/clawx-data-service.ts',
      'electron/data/data-service-rpc-server.ts',
      'electron/data/data-service-utility-host.ts',
      'electron/data/utility-process-entry.ts',
      'electron/data/clawx-blob-store.ts',
    ];
    for (const file of productionFiles) {
      expect(readFileSync(resolve(file), 'utf8'), file).not.toContain("from 'node:sqlite'");
    }
    expect(readFileSync(resolve('electron/data/clawx-data-store.ts'), 'utf8')).toContain("from 'node:sqlite'");
  });
});
