import { defineConfig } from 'tsup';
import { shared } from '../../tsup.config.base';

export default defineConfig({
  ...shared,
  entry: [
    'src/index.ts',
    'src/metering.ts',
    'src/maintenance.ts',
    'src/migrations.ts',
    'src/testing.ts',
    'src/migrate-cli.ts',
  ],
  dts: true,
});
