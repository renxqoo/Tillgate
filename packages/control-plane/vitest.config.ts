import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 铁律 14:包根 __test__/ 平铺,真实凭证集成以 *.real.test.ts 文件名区分,默认门禁按文件名排除
    include: ['__test__/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 口径（IMPLEMENTATION.md §4 如实申报）：
      // - src/index.ts：出口桶（纯 re-export）
      // - src/adapters/postgres/**：SQL 行为由 postgres.real.test.ts 承担（默认门禁不含真实 PG，
      //   与铁律 14 真实凭证集成口径一致）
      // - src/ports/ 与 domain/list.ts 的纯类型声明文件：零运行时语句（v8 会把模块装载计为
      //   未覆盖函数）——唯一例外 cache.ts 带运行时实现，计入分母
      exclude: [
        'src/index.ts',
        'src/adapters/postgres/**',
        'src/domain/list.ts',
        'src/ports/audit-sink.ts',
        'src/ports/audit-store.ts',
        'src/ports/catalog-source.ts',
        'src/ports/channel-store.ts',
        'src/ports/fx-store.ts',
        'src/ports/model-store.ts',
        'src/ports/operations-store.ts',
        'src/ports/provider-store.ts',
        'src/ports/rate-card-store.ts',
        'src/ports/secret-cipher.ts',
        'src/ports/upstream-probe.ts',
        'src/ports/voucher-storage.ts',
      ],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
