import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 根 .env 载入（REDIS_URL 带密码——爆破防护/限流 fail-closed 依赖它；与 gateway e2e 同 loader）
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

export default defineConfig({
  test: {
    env: rootEnv,
    // E2E（真服务进程 + dev 库 + 可能的真上游）走独立通道 test:e2e——默认门禁不依赖
    fileParallelism: false,
    include: ['src/__tests__/e2e-*.test.ts'],
  },
});
