import { defineConfig } from 'vitest/config';

export default defineConfig({
  // workspace 依赖（@tokenlens/errors）经 development 条件直连源码——
  // 测试不经构建产物（与 packages/http 同约定）
  resolve: {
    conditions: ['development'],
  },
  test: {
    // 铁律 14:包根 __test__/ 平铺;真实 PG 集成以 *.real.test.ts 文件名区分,默认门禁排除
    include: ['__test__/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 出口桶(纯 re-export)与纯类型契约文件(ports/、funding/source.ts——零运行时)
      // 不计入;postgres 适配器只能由真实 PG 语义覆盖(经 test:real 门执行),
      // 默认门禁分母排除——阈值本身不变(与 accounts 包同约定)
      exclude: [
        'src/index.ts',
        'src/adapters/**',
        'src/ports/**',
        'src/application/billing/funding/source.ts',
      ],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
