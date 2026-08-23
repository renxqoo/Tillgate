/**
 * 架构门禁（P5 收紧 apps）：文件集快照 + composition/db 白名单 + 深导入禁令。
 * 与 gateway IMPLEMENTATION §3 同款口径；trace-receiver 为四文件精简版先例。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function readSources(sub: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const abs of listFiles(join(SRC, sub))) {
    map.set(abs.slice(SRC.length + 1), readFileSync(abs, 'utf8'));
  }
  return map;
}

const ALL = readSources('.');

describe('client-api 架构门禁', () => {
  it('src 顶层文件集快照（新增/删除须同步本清单）', () => {
    const topLevel = [...ALL.keys()].filter((f) => !f.includes('/'));
    expect(topLevel.toSorted()).toEqual(['app.ts', 'assembly.ts', 'config.ts', 'index.ts', 'shutdown.ts']);
  });

  it('./composition 只允许出现在 assembly 与 adapters 的 import 说明符', () => {
    for (const [file, source] of ALL) {
      if (file === 'assembly.ts' || file.startsWith('adapters/')) continue;
      const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const spec of specifiers) {
        expect(spec, `${file} 不得引用 composition 子入口`).not.toContain('/composition');
      }
    }
  });

  it('@tokenlens/db 与 Db/DbTx 类型只允许在 {index,config,assembly} ∪ adapters', () => {
    const assemblyFace = new Set(['index.ts', 'config.ts', 'assembly.ts']);
    for (const [file, source] of ALL) {
      if (assemblyFace.has(file) || file.startsWith('adapters/')) continue;
      // app.ts 的 pgSqlState 是纯 SQLSTATE 分类函数（trace-receiver 同款白名单例外）
      const withoutException = file === 'app.ts'
        ? source.replace(/import \{ pgSqlState \} from '@tokenlens\/db';/, '')
        : source;
      expect(withoutException, `${file} 不得依赖 db 包`).not.toMatch(/from '@tokenlens\/db'/);
      expect(withoutException, `${file} 不得出现 Db/DbTx 类型`).not.toMatch(/\b(Db|DbTx)\b/);
    }
  });

  it('http 层零 adapter/数据库/composition 依赖（协议层纯消费 facade 与注入读面）', () => {
    for (const [file, source] of ALL) {
      if (!file.startsWith('http/')) continue;
      expect(source, `${file} 不得 import adapters`).not.toContain("../adapters/");
      expect(source, `${file} 不得引用 composition`).not.toContain('/composition');
    }
  });

  it('跨包 import 只走显式 exports（禁 /src 深导入）', () => {
    for (const [file, source] of ALL) {
      const specifiers = [...source.matchAll(/from '(@tokenlens\/[^']+)'/g)].map((m) => m[1]);
      for (const s of specifiers) {
        expect(s, `${file} 深导入 ${s}`).not.toMatch(/\/src\//);
      }
    }
  });
});
