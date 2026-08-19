import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 根 .env 载入（REDIS_URL 带密码——装配 Redis 必配；与主配置同 loader）
const rootEnv = (() => {
  try {
    const raw = readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8');
    return Object.fromEntries(
      raw
        .split('\n')
        .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
        .map((line) => {
          const eq = line.indexOf('=');
          return [line.slice(0, eq), line.slice(eq + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
})();

/** E2E 通道（真网关进程 + 平台 key + 真上游）：显式 `pnpm test:e2e` 运行 */
export default defineConfig({
  test: {
    include: ['src/__tests__/e2e-*.test.ts'],
    fileParallelism: false,
    env: rootEnv,
  },
});
