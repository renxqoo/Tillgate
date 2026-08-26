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

    // 铁律 14:包根 __test__/ 平铺,真实 PG 集成以 *.real.test.ts 文件名区分,默认门禁按文件名排除
    include: ['__test__/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 口径(IMPLEMENTATION.md §5 如实申报):
      // - src/index.ts / src/composition.ts:出口桶(纯 re-export)
      // - src/adapters/postgres/**:SQL 行为由 postgres.real.test.ts 承担(默认门禁不含真实 PG,
      //   与铁律 14 真实凭证集成口径一致)
      // - src/adapters/smtp/**:外部 SDK(nodemailer)薄封装,传输行为不进默认门禁
      //   (v1 同口径:mailerFromEnv 无单测,渲染已沉 templates 由默认门禁覆盖)
      // - src/ports/** 纯类型声明文件:零运行时语句(v8 会把模块装载计为未覆盖函数)
      exclude: [
        'src/index.ts',
        'src/composition.ts',
        'src/adapters/postgres/**',
        'src/adapters/smtp/**',
        'src/ports/email-sender.ts',
        'src/ports/notify-store.ts',
        'src/ports/secret-cipher.ts',
        'src/ports/url-guard.ts',
        'src/ports/webhook-deliverer.ts',
      ],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
