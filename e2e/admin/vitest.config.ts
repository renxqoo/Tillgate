import { defineConfig } from 'vitest/config';

// e2e/admin 归组运行装置（重构方案 §9/P5「跨进程旅程迁入根 e2e/」）：
// 与 gateway/security 归组同院但独立配置——本目录测试从 apps/admin-api 目录用其
// vitest 执行（admin-api 依赖闭包含 identity 等 gateway 闭包没有的包）：
//   cd apps/admin-api && bun run test:e2e
// 全真装配（真实 PG + identity 签发真 admin 令牌）;文件级串行(资金幂等断言无并发噪声)。
export default defineConfig({
  test: {
    root: __dirname,
    include: ['*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
