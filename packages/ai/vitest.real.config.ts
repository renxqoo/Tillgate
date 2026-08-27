import { defineConfig } from 'vitest/config';

// 真上游 real 门（*.real.test.ts：花真钱，显式 opt-in）：
// 默认 vitest.config.ts 以文件名排除 real 文件（vitest 4 的 CLI 文件过滤
// 与 --exclude 均不能穿透配置级 exclude），本配置是运行 real 集成的唯一入口
// （package.json test:real；装置同根 e2e/vitest.real.config.ts 先例）。
export default defineConfig({
  test: {
    include: ['__test__/*.real.test.ts'],
    environment: 'node',
  },
});
