import { defineConfig } from 'tsup';

export default defineConfig({
  format: ["cjs"],
  entry: ['./src/node.ts'],
  dts: false,
  shims: true,
  skipNodeModulesBundle: false,
  clean: true,
  target: 'es5',
  platform: 'node',
  minify: true,
  bundle: true,
  // https://github.com/egoist/tsup/issues/619
  noExternal: [/(.*)/],
  splitting: false,
  // sourcemap: true,
});