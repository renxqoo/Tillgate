import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // bun-vitest 的 ssrTransform 会丢 zod v4 的 `export { z }` 再导出——
    // node_modules 全量外部化,由 bun 运行时原生解析(源码转换不受影响)
    server: {
      deps: {
        external: [/node_modules/],
      },
    },

    // 包根 __test__/ 平铺(不按 test/{core,next,pack}/ 分组,沿用既有包先例)
    include: ['__test__/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 口径:
      // - src/index.ts / src/next/index.ts:纯再导出桶,零自有逻辑
      // - src/dto/**:纯类型声明文件,零运行时语句(v8 会把模块装载计为未覆盖函数)
      exclude: ['src/index.ts', 'src/next/index.ts', 'src/dto/**'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
