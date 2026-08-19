import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/migrate-cli.ts'],
  dts: true,
  format: 'esm',
  clean: true,
  sourcemap: true,
});
