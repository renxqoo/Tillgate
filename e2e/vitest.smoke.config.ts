import { defineConfig } from 'vitest/config';

// 双形态进程冒烟配置（bun 源码 / node 产物子进程；不进默认门禁，手动执行记录在案）：
// bun run test:e2e:smoke
export default defineConfig({
  test: {
    // bun-vitest 的 ssrTransform 会丢 zod v4 的 `export { z }` 再导出——
    // node_modules 全量外部化,由 bun 运行时原生解析(源码转换不受影响)
    server: {
      deps: {
        external: [/node_modules/],
      },
    },

    root: __dirname,
    include: ['gateway/process-smoke.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
