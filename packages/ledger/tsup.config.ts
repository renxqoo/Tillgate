import { defineConfig } from 'tsup';
import { shared } from '../../tsup.config.base';

export default defineConfig({
  ...shared,
  entry: {
    index: 'src/index.ts',
    rating: 'src/rating/index.ts',
    subscription: 'src/subscription/index.ts',
    'channel-budget': 'src/channel-budget/index.ts',
    billing: 'src/billing/domain.ts',
    settlement: 'src/settlement/index.ts',
    platform: 'src/platform/index.ts',
  },
  dts: true,
});
