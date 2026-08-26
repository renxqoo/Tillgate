import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // workspace 依赖(@tillgate/errors、@tillgate/db)经 development 条件直连源码(与 http/db 包同约定)
    conditions: ['development'],
  },
  test: {
    // bun-vitest 的 ssrTransform 会丢 zod v4 的 `export { z }` 再导出——
    // node_modules 全量外部化,由 bun 运行时原生解析(源码转换不受影响)
    server: {
      deps: {
        external: [/node_modules/],
      },
    },

    // 铁律 14:包根 __test__/ 平铺;真实 PG 集成以 *.real.test.ts 文件名区分,默认门禁排除
    include: ['__test__/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 出口桶(纯 re-export)不计入;postgres 适配器只能由真实 PG 语义覆盖
      // (IMPLEMENTATION §4,经 test:real 门执行),默认门禁分母排除——阈值本身不变
      exclude: ['src/index.ts', 'src/adapters/**'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
