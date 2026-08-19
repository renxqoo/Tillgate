import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // E2E（真服务进程 + dev 库 + 可能的真上游）走独立通道 test:e2e——默认门禁不依赖
    fileParallelism: false,
    include: ['src/__tests__/e2e-*.test.ts'],
  },
});
