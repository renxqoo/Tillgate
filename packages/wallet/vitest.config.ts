import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/__tests__/global-setup.ts'],
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 15_000,
    // 文件级串行：并发覆盖由各测试自带的 Promise.all/独立大池保证；
    // 跨文件并行只带来共享科目行（outside/revenue）的争用噪声（偶发死锁穿透重试预算）
    fileParallelism: false,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/__tests__/**'], // barrel 与测试基建不计入产品覆盖率
    },
  },
});
