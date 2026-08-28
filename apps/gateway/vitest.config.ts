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

    // 包根 __test__/ 平铺；真实 PG/Redis 用例 *.real.test.ts 文件名区分
    include: ['__test__/*.test.ts'],
    environment: 'node',
    // 共享单实例 PG：文件级串行
    fileParallelism: false,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 进程入口与装配根排除口径（trace-receiver index.ts 同款申报）：
      // index.ts = listen/信号注册；assembly.ts = 装配面——由 __test__/gateway-stack.real.test.ts
      // 全栈验证（真 PG+Redis 装配闭环 4/4；默认门禁 env 未配时 skipIf），单测无注入缝不造假
      exclude: ['src/index.ts', 'src/assembly.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
