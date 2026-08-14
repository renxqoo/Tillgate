import { defineConfig } from 'tsup';
import { shared } from '../../tsup.config.base';

export default defineConfig({
  ...shared,
  entry: ['src/index.ts', 'src/graph.ts'],
  dts: true,
});
