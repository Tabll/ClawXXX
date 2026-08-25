import { defineConfig } from 'tsdown'

// The workspace default emits only index/invariant/startup. This package also
// ships the bounded control smoke executable referenced by the artifact
// descriptor, so its bin entry must be part of the production deploy.
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/bin.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
