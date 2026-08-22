import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // schema 是声明式表定义,不做行覆盖统计;行为由 unit 断言 + real PG 集成保证
  },
});
