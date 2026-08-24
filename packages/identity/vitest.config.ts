import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // workspace 依赖(@tillgate/errors、@tillgate/db)经 development 条件直连源码(与 accounts/notifications 同约定)
    conditions: ['development'],
  },
  test: {
    include: ['__test__/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 排除口径(与 notifications 同款):barrel 出口、composition 子入口、
      // adapters(postgres/redis/smtp 行为由 *.real.test.ts 与注入 fetch 的适配器测试验证,
      // 不计入默认覆盖率)、纯类型 port 文件(v8 模块装载计为未覆盖函数)。
      exclude: [
        'src/index.ts',
        'src/composition.ts',
        'src/adapters/**',
        'src/ports/credential-store.ts',
        'src/ports/challenge-store.ts',
        'src/ports/mfa-store.ts',
        'src/ports/oauth-store.ts',
        'src/ports/anchor-store.ts',
        'src/ports/mailer.ts',
        'src/ports/captcha.ts',
        'src/ports/oauth-provider.ts',
        'src/ports/oauth-state-store.ts',
        'src/ports/session-tokens.ts',
        'src/ports/session-revocation-store.ts',
        'src/ports/secret-cipher.ts',
        'src/ports/audit.ts',
        'src/ports/clock.ts',
        'src/ports/logger.ts',
      ],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
