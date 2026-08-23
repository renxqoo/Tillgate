import { defineConfig } from 'vitest/config';

/**
 * client-api 测试配置：契约测试（app.request + 内存替身）为默认门禁；
 * 真实 PG/Redis 全链走 app.real.test.ts（test:real 通道，按文件名排除）。
 * 覆盖率排除 src/index.ts（bootstrap）、src/assembly.ts 与 src/adapters/*
 * （装配根与 PG 集成件需真实基础设施——real 通道覆盖，如实申报不调阈值）。
 */
export default defineConfig({
  test: {
    include: ['__test__/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 15_000,
    coverage: {
      include: ['src/**'],
      exclude: ['src/index.ts', 'src/assembly.ts', 'src/adapters/**'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
