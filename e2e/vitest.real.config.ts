import { defineConfig } from 'vitest/config';

// 真上游 real 门（*.real.test.ts：花真钱，显式 opt-in）：
// E2E_REAL_UPSTREAM=1 + DB/Redis env 时运行，否则 skipIf 全跳过。
// 从 apps/gateway 目录用其 vitest 执行（同默认 e2e 门）。
export default defineConfig({
  test: {
    root: __dirname,
    include: ['gateway/*.real.test.ts', 'security/*.real.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 120_000,
  },
});
