import { defineConfig } from 'vitest/config';

/** E2E 通道（真网关进程 + 平台 key + 真上游）：显式 `pnpm test:e2e` 运行 */
export default defineConfig({
  test: {
    include: ['src/__tests__/e2e-*.test.ts'],
    fileParallelism: false,
  },
});
