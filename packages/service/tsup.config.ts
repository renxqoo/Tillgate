import { defineConfig } from 'tsup';
import { shared } from '../../tsup.config.base';

export default defineConfig({
  ...shared,
  entry: { index: 'src/index.ts' },
  dts: true,
});
