import { defineConfig } from 'vitest/config';

// 双形态进程冒烟配置（bun 源码 / node 产物子进程；不进默认门禁，手动执行记录在案）：
// bun run test:e2e:smoke
export default defineConfig({
  test: {
    root: __dirname,
    include: ['gateway/process-smoke.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
