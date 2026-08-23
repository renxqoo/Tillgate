import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 铁律 14:包根 __test__/ 平铺,真实凭证集成以 *.real.test.ts 文件名区分,默认门禁按文件名排除
    include: ['__test__/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 口径(如实申报):src/index.ts 是进程入口(listen/信号注册/停机编排由 runtime
      // createShutdown 承担并在其包内已测)——config/assembly/app/http 全量纳入本包覆盖;
      // src/adapters/* 是装配面桥接件(仅 assembly 引用),由 assembly 测试与契约测试覆盖
      exclude: ['src/index.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
