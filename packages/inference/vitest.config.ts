import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 铁律 14：包根 __test__/ 平铺，include 固定；真实 Redis 集成用 REDIS_URL skipIf 门控
    include: ['__test__/*.test.ts'],
    environment: 'node',
    // workspace 依赖（@tokenlens/ai、@tokenlens/errors）经 development 条件直连源码，
    // 测试不经构建产物（http 包确立的跨包测试形态）
    resolve: { conditions: ['development'] },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 出口桶文件（纯 re-export）不计入分母;
      // adapters/generation-pg.ts = 纯 SQL/DDL(行为由 generation-pg.real.test.ts 承担,
      // 默认门禁不含真实 PG——observability adapters/postgres 桶同口径)
      exclude: ['src/index.ts', 'src/adapters/generation-pg.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
