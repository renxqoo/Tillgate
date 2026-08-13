import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 加载仓库根目录的 .env 到 process.env（测试/脚本工具用）。
 *
 * dev 运行时由 tsx 的 --env-file 加载；vitest 不自动读根 .env，
 * 集成测试（需要 DATABASE_URL/REDIS_URL 等）调用本函数补齐。
 *
 * 解析规则与 .env.example 注释行兼容：KEY=VALUE 行注入，已存在的环境变量不覆盖。
 * 从本文件所在目录向上逐级查找 .env，直到仓库根。
 */
export function loadRootEnvFile(fromDir: string = dirname(fileURLToPath(import.meta.url))): void {
  let dir = fromDir;
  for (let i = 0; i < 10; i++) {
    const file = resolve(dir, '.env');
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
