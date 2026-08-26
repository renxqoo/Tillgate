import { defineConfig } from 'vitest/config';

// e2e 归组运行装置（重构方案 §933：根 e2e/ 不是 workspace 包）：
// - 依赖闭包经 e2e/node_modules 符号链接到 apps/gateway/node_modules（gateway 依赖
//   覆盖 e2e 所需全部模块；bun 不管理该链接——e2e 非 workspace）；
// - 从 apps/gateway 目录用其 vitest 执行（根脚本 test:e2e），配置经 -c 指向本文件。
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
    include: ['gateway/*.test.ts', 'security/*.test.ts'],
    // *.real.test.ts（真上游，花钱）不进默认门禁——显式 -c vitest.real.config.ts 运行
    exclude: ['**/node_modules/**', '**/*.real.test.ts'],
    environment: 'node',
    // 全真装配 + 共享 Redis（熔断/限流键按渠道 id 命名）——文件级串行（同 gateway 门禁纪律）
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
