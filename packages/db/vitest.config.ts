import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 铁律 14:包根 __test__/ 平铺,真实凭证集成以 *.real.test.ts 文件名区分,默认门禁按文件名排除
    include: ['__test__/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 出口桶文件(纯 re-export)不计入分母;schema 表定义经 import 即全量执行,计入分母
      exclude: ['src/index.ts', 'src/schema/index.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
