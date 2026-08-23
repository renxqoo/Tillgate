/**
 * 架构边界门禁（trace-receiver 范式扩展；IMPLEMENTATION §3 机器锁定清单）：
 * - src 文件集合快照；
 * - /composition 子入口只在 assembly.ts ∪ adapters/*；
 * - @tokenlens/db 装配与 Db/DbTx 类型只在进程装配面（assembly/config/index ∪ adapters/*）；
 * - http/** 不 import @tokenlens/ai（§3.6：ai 类型消费方自 inference 出口引用）；
 * - 跨包 import 只走包名（禁 /src/ 深导入；composition 后缀豁免）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`));
    else if (entry.name.endsWith('.ts')) out.push(`${prefix}${entry.name}`);
  }
  return out.toSorted();
}

const files = walk(SRC);
const sourceOf = (f: string) => readFileSync(join(SRC, f), 'utf-8');
const assemblyFace = new Set(['assembly.ts', 'config.ts', 'index.ts']);
const isAdapter = (f: string) => f.startsWith('adapters/');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('src 文件集合快照', () => {
  it('目录结构即契约（新增/删除文件必须显式更新本快照）', () => {
    expect(files).toEqual([
      'adapters/billing-port.ts',
      'adapters/catalog-port.ts',
      'adapters/settle-wake.ts',
      'adapters/trace-port.ts',
      'app.ts',
      'assembly.ts',
      'config.ts',
      'http/contracts/generation.ts',
      'http/contracts/inference-endpoints.ts',
      'http/middleware/api-key.ts',
      'http/middleware/otel.ts',
      'http/middleware/rate-limit.ts',
      'http/middleware/request-log.ts',
      'http/openai-envelope.ts',
      'http/openai-error-face.ts',
      'http/routes/generation.ts',
      'http/routes/inference-endpoints.ts',
      'http/routes/modality-multipart.ts',
      'http/routes/models.ts',
      'http/routes/native-gemini.ts',
      'http/routes/oauth-token.ts',
      'http/sanitize.ts',
      'index.ts',
      'shutdown.ts',
    ]);
  });
});

describe('composition 子入口白名单（§5.3）', () => {
  it('只在 assembly.ts 与 adapters/* 出现（注释提及不算——只查 import 语句）', () => {
    for (const f of files) {
      if (f === 'assembly.ts' || isAdapter(f)) continue;
      const code = stripComments(sourceOf(f));
      expect(code.includes('/composition'), f).toBe(false);
    }
  });
});

describe('Db/DbTx 类型与装配细节不泄漏（P5）', () => {
  it('@tokenlens/db import 与 Db 类型引用只在进程装配面 ∪ adapters/*', () => {
    for (const f of files) {
      if (assemblyFace.has(f) || isAdapter(f)) continue;
      const code = stripComments(sourceOf(f));
      expect(code.includes("from '@tokenlens/db'"), f).toBe(false);
      expect(/\bDbTx\b/.test(code), f).toBe(false);
      expect(/import type \{[^}]*\bDb\b/.test(code), f).toBe(false);
    }
  });
});

describe('§3.6：app 运行时不直接 import ai', () => {
  it('http/** 与 app.ts 不引用 @tokenlens/ai（ai 类型消费方自 inference 出口）', () => {
    for (const f of files) {
      if (!(f.startsWith('http/') || f === 'app.ts')) continue;
      expect(sourceOf(f).includes("from '@tokenlens/ai'"), f).toBe(false);
    }
  });
});

describe('跨包 import 只走包名（§5.5）', () => {
  it('禁止 @tokenlens/*/src 深导入（composition 子入口豁免）', () => {
    for (const f of files) {
      const specs = [...sourceOf(f).matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      for (const spec of specs) {
        if (!spec.startsWith('@tokenlens/')) continue;
        expect(/^@tokenlens\/[a-z-]+(\/composition)?$/.test(spec), `${f} → ${spec}`).toBe(true);
      }
    }
  });
});
