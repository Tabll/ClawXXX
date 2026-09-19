// @vitest-environment node
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('reviewed September Channel package repairs', () => {
  it('loads the full official DingTalk entry and preserves canonical account identity', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import register, { dingtalkPlugin } from '@dingtalk-real-ai/dingtalk-connector';
      assert.equal(dingtalkPlugin.id, 'dingtalk');
      const cfg = { channels: { dingtalk: { defaultAccount: 'other', accounts: {
        default: { clientId: 'one', clientSecret: 'fixture-one' },
        other: { clientId: 'two', clientSecret: 'fixture-two' },
      } } } };
      assert.deepEqual(dingtalkPlugin.config.listAccountIds(cfg), ['default', 'other']);
      assert.equal(dingtalkPlugin.config.defaultAccountId(cfg), 'other');
      assert.equal(dingtalkPlugin.config.resolveAccount(cfg, 'default').clientId, 'one');
      assert.equal(dingtalkPlugin.config.resolveAccount(cfg, 'other').clientId, 'two');
      const methods = [];
      register({ runtime: {}, config: {}, logger: { info() {}, warn() {} },
        registerChannel({ plugin }) { assert.equal(plugin.id, 'dingtalk'); },
        registerGatewayMethod(name) { methods.push(name); }, registerService() {}, on() {},
      });
      assert.ok(methods.includes('dingtalk-connector.docs.create'));
      console.log('CLAWX_DINGTALK_REGISTERED');
    `], { cwd: process.cwd(), timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    expect(stdout).toContain('CLAWX_DINGTALK_REGISTERED');
  }, 40_000);

  it('loads the published Lark CJS entry in a bounded native Node process', async () => {
    const root = path.resolve('node_modules/@larksuite/openclaw-lark');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.type).toBe('commonjs');
    expect(existsSync(path.join(root, pkg.main))).toBe(true);
    // This loads the entire real plugin/SDK graph, not a unit-sized module.
    // Use a fresh native process (as the runtime does), without Vitest module
    // state, and kill a hung import before the per-test deadline expires.
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=commonjs', '-e', `
      const assert = require('node:assert/strict');
      const plugin = require(process.argv[1]);
      assert.equal(typeof (plugin.default ?? plugin).register, 'function');
      process.stdout.write('CLAWX_LARK_CJS_LOADED\\n');
    `, path.join(root, pkg.main)], {
      timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true,
    });
    expect(stdout).toContain('CLAWX_LARK_CJS_LOADED\n');
  }, 75_000);

  it('repairs both invalid import.meta sites as CommonJS syntax', () => {
    const root = path.resolve('node_modules/@larksuite/openclaw-lark');
    for (const file of ['src/core/version.js', 'src/core/token-store.js']) {
      const text = readFileSync(path.join(root, file), 'utf8');
      expect(() => new Script(text)).not.toThrow();
    }
  });
});
