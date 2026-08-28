/**
 * 架构边界门禁（机器锁定清单）：
 * - src 文件集合快照；
 * - /composition 子入口只在 assembly.ts ∪ adapters/*；
 * - @tillgate/db 装配与 Db/DbTx 类型只在进程装配面（assembly/config/index ∪ adapters/*）；
 * - http/** 不 import @tillgate/ai（ai 类型消费方自 inference 出口引用）；
 * - 跨包 import 只走包名（禁 /src/ 深导入；composition 后缀豁免）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defined } from './defined';

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
      'adapters/billing-timezone.ts',
      'adapters/catalog-port.ts',
    'adapters/reservation-policy.ts',
      'adapters/settle-wake.ts',
      'adapters/trace-port.ts',
      'app.ts',
      'assembly.ts',
      'config.ts',
      'db-budget.ts',
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
      'http/routes/inference-input.ts',
      'http/routes/modality-multipart.ts',
      'http/routes/models.ts',
      'http/routes/native-gemini.ts',
      'http/routes/oauth-token.ts',
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
  it('@tillgate/db import 与 Db 类型引用只在进程装配面 ∪ adapters/*', () => {
    for (const f of files) {
      if (assemblyFace.has(f) || isAdapter(f)) continue;
      const code = stripComments(sourceOf(f));
      expect(code.includes("from '@tillgate/db'"), f).toBe(false);
      expect(/\bDbTx\b/.test(code), f).toBe(false);
      expect(/import type \{[^}]*\bDb\b/.test(code), f).toBe(false);
    }
  });
});

describe('§3.6：app 运行时不直接 import ai', () => {
  it('http/** 与 app.ts 不引用 @tillgate/ai（ai 类型消费方自 inference 出口）', () => {
    for (const f of files) {
      if (!(f.startsWith('http/') || f === 'app.ts')) continue;
      expect(sourceOf(f).includes("from '@tillgate/ai'"), f).toBe(false);
    }
  });
});

describe('跨包 import 只走包名（§5.5）', () => {
  it('禁止 @tillgate/*/src 深导入（composition 子入口豁免）', () => {
    for (const f of files) {
      const specs = [...sourceOf(f).matchAll(/from '([^']+)'/g)].map((m) =>
        defined(m[1], 'import spec match group'),
      );
      for (const spec of specs) {
        if (!spec.startsWith('@tillgate/')) continue;
        expect(/^@tillgate\/[a-z-]+(\/composition)?$/.test(spec), `${f} → ${spec}`).toBe(true);
      }
    }
  });
});
