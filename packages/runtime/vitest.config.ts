import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 铁律 14：包根 __test__/ 平铺，include 固定；真实 Redis 集成用例文件内 skipIf
    include: ['__test__/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 出口桶文件（纯 re-export）不计入分母；redis-integration 依赖真实 Redis
      // （REDIS_URL 未配置时用例自身 skipIf），不排除出 include。
      exclude: ['src/index.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
