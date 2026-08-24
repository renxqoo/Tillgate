import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * app 级架构门禁(§5.5/总纲 P5,机器验证不靠记忆):
 *   1. `./composition` 子入口只允许出现在 src/assembly.ts(§5.3 白名单:apps assembly);
 *   2. `@tillgate/db` 的 Db/DbTx 类型与 createDb/ping 等装配件不出现在非装配代码
 *      (app.ts/config.ts);进程装配面(assembly.ts/index.ts)除外——P5「app 非 assembly
 *      代码不得引用任何 ./composition、repository、adapter 或 Db/DbTx 类型」。
 *   3. app 依赖面只走显式包名(禁 @tillgate 各包 src 深导入,§5 硬约束)。
 */

const SRC = join(import.meta.dirname, '../src');
const FILES = readdirSync(SRC)
  .filter((name) => name.endsWith('.ts'))
  .toSorted();
const source = new Map<string, string>(
  FILES.map((name) => [name, readFileSync(join(SRC, name), 'utf8')]),
);
/** 进程装配面:配置产出与依赖装配/生命周期收口(P5 白名单语义;app.ts 是唯一非装配面) */
const ASSEMBLY_FACE = new Set(['assembly.ts', 'config.ts', 'index.ts']);

describe('trace-receiver 架构门禁', () => {
  it('src 文件集合快照(四件套,一文件一职责)', () => {
    expect(FILES).toEqual(['app.ts', 'assembly.ts', 'config.ts', 'index.ts']);
  });

  it('composition 子入口只在 assembly.ts 引用', () => {
    for (const [name, code] of source) {
      if (name === 'assembly.ts') {
        expect(code).toContain('@tillgate/observability/composition');
        continue;
      }
      expect(code, `${name} 不得引用 composition 子入口`).not.toContain('/composition');
    }
  });

  it('@tillgate/db 装配件(Db/DbTx 类型、createDb/ping/closeDb)只在进程装配面', () => {
    for (const [name, code] of source) {
      const references = /from '@tillgate\/db'/.test(code) || /\b(Db|DbTx)\b/.test(code);
      if (ASSEMBLY_FACE.has(name)) {
        // 装配面允许(db 依赖装配唯一例外:app.ts 的 pgSqlState 纯分类函数不算装配件)
        continue;
      }
      expect(
        references && !code.includes('pgSqlState'),
        `${name} 不得引用 @tillgate/db(纯分类函数 pgSqlState 除外)`,
      ).toBe(false);
      expect(code, `${name} 不得出现 Db/DbTx 类型`).not.toMatch(/\btype Db\b|\bDbTx\b/);
    }
  });

  it('跨包 import 只走包名(禁 src 深导入/相对路径越界)', () => {
    for (const [name, code] of source) {
      const deepImports = [...code.matchAll(/from '(@tillgate\/[^']+)'/g)]
        .map((match) => match[1]!)
        .filter((specifier) => !specifier.endsWith('composition'));
      for (const specifier of deepImports) {
        expect(specifier.startsWith('@tillgate/'), `${name} 非法依赖 ${specifier}`).toBe(true);
        expect(specifier, `${name} 禁深导入 ${specifier}`).not.toMatch(/\/src\//);
      }
    }
  });
});
