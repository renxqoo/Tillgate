import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 根 .env 加载（client-api 同款语义：只补缺不覆盖——进程环境优先，CI 直接注入 env）。
 */
function loadRootDotEnv(): Record<string, string> {
  const filled: Record<string, string> = {};
  try {
    const raw = readFileSync(join(import.meta.dirname, '..', '..', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value !== '' && process.env[key] === undefined) filled[key] = value;
    }
  } catch {
    // 无根 .env（CI 形态）——全靠进程环境
  }
  return filled;
}

/**
 * admin（Next.js 前端）测试配置：默认门禁 = 架构边界 + server 动作（mock fetch）+
 * 纯函数（URL 状态/图布局/tone）+ config 词表封闭性 + 关键 client 交互组件。
 *
 * 覆盖率口径（IMPLEMENTATION §7，如实申报不调阈值）：
 *   - 含：src/{server,lib,config}/** 与 features 内纯逻辑切片（*.ts 非 tsx）
 *   - 排除覆盖率：src/app/**（RSC 页面装配——行为由 server 动作测试 + build 类型门覆盖）、
 *     src/components 与 features 下 tsx；关键交互组件用 jsdom 渲染测试锁定，但不纳入
 *     server/lib/config 的既有覆盖率分母。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // bun-vitest 的 ssrTransform 会丢 zod v4 的 `export { z }` 再导出——
    // node_modules 全量外部化,由 bun 运行时原生解析(源码转换不受影响)
    server: {
      deps: {
        external: [/node_modules/],
      },
    },

    include: ['__test__/*.test.ts', '__test__/*.test.tsx'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 15_000,
    // server 动作测试断言锁定兜底基地址:钉住 ADMIN_API_BASE,
    // 防本机根 .env 的 dev 值(如 LAN IP)渗入断言 URL(CI 无 .env,形态一致)
    env: {
      ...loadRootDotEnv(),
      ADMIN_API_BASE: 'http://localhost:8082',
    },
    coverage: {
      include: ['src/server/**', 'src/lib/**', 'src/config/**'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
