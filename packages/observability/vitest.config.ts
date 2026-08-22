import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 铁律 14:包根 __test__/ 平铺,真实凭证集成以 *.real.test.ts 文件名区分,默认门禁按文件名排除
    include: ['__test__/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 口径(IMPLEMENTATION.md §5 如实申报):
      // - src/index.ts 与 src/composition.ts:出口桶(纯 re-export)
      // - src/adapters/postgres/**:SQL/DDL 行为由 postgres.real.test.ts 承担(默认门禁不含真实 PG)
      // - 纯类型声明文件零运行时语句(v8 会把模块装载计为未覆盖)
      exclude: [
        'src/index.ts',
        'src/composition.ts',
        'src/adapters/postgres/**',
        'src/tracing/types.ts',
        'src/audit/types.ts',
        'src/request-log/types.ts',
      ],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
