import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/__tests__/global-setup.ts'],
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 15_000,
    // 文件级串行：共享唯一索引行（同 operationId 并发语义）跨文件并行只带来争用噪声；
    // 并发语义由各测试自带的 Promise.all 验证
    fileParallelism: false,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/__tests__/**'],
    },
  },
});
