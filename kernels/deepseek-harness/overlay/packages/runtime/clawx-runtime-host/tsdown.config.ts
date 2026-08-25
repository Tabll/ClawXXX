import { defineConfig } from 'tsdown'

// The runtime host has three public entries. The package-local build config is
// required because DSH's workspace default only emits index/invariant/startup.
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/home-lock.js', 'lib/types/host-bridge.js', 'lib/types/bin.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
