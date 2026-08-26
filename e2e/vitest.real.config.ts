import { defineConfig } from 'vitest/config';

// 真上游 real 门（*.real.test.ts：花真钱，显式 opt-in）：
// E2E_REAL_UPSTREAM=1 + DB/Redis env 时运行，否则 skipIf 全跳过。
// 从 apps/gateway 目录用其 vitest 执行（同默认 e2e 门）。
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
    include: ['gateway/*.real.test.ts', 'security/*.real.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 120_000,
  },
});
