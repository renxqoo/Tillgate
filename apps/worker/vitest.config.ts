import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['development'] },
  test: {
    // bun-vitest 的 ssrTransform 会丢 zod v4 的 `export { z }` 再导出——
    // node_modules 全量外部化,由 bun 运行时原生解析(源码转换不受影响)
    server: {
      deps: {
        external: [/node_modules/],
      },
    },

    include: ['__test__/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 口径(如实申报):src/index.ts 是进程入口(listen/信号注册由 runtime
      // createShutdown 承担并在其包内已测);src/assembly.ts 是唯一装配根——
      // 依赖闭包(signal 桥/outbox 桥/balance_low 钩子)只在真实依赖面上有意义,
      // 由 worker.real.test.ts 的真实 PG 全链覆盖(与包级 adapters 排除同约定),
      // 结构断言在 assembly.test.ts/architecture.test.ts。
      exclude: ['src/index.ts', 'src/assembly.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
