/**
 * 架构边界门禁：
 * ① src 文件集合快照（新增/删除文件即红）；
 * ② Db/DbTx/drizzle 符号只在装配面（assembly/config/index/shutdown）；
 * ③ ./composition 子入口只在 assembly.ts（唯一装配根）；
 * ④ 跨包 import 只走包名 exports（禁 /src/ 深导入）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defined } from './defined.js';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith('.ts')) {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

/** 剥注释（符号检查不因注释误报） */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const files = walk(srcDir)
  .toSorted()
  .map((path) => ({ path, code: stripComments(readFileSync(`${srcDir}/${path}`, 'utf-8')) }));

const ASSEMBLY_FACE = new Set(['assembly.ts', 'config.ts', 'index.ts', 'shutdown.ts']);

describe('① src 文件集合快照（目标树机器锁死）', () => {
  it('文件集合与 DESIGN §3 目标目录一致', () => {
    expect(files.map((f) => f.path)).toEqual([
      'assembly.ts',
      'bridge-mappers.ts',
      'config.ts',
      'health.ts',
      'index.ts',
      'jobs/notify.ts',
      'jobs/partition.ts',
      'jobs/poll.ts',
      'jobs/reconcile.ts',
      'jobs/recovery.ts',
      'jobs/referral.ts',
      'jobs/settlement-sweep.ts',
      'jobs/settlement.ts',
      'queue/settlement-dispatch.ts',
      'queue/settlement-queue.ts',
      'scheduler.ts',
      'shutdown.ts',
      'wakeup/postgres-notify.ts',
    ]);
  });
});

describe('② Db 类型只在装配面（P5：非 assembly 代码只持闭包与纯契约）', () => {
  it('jobs/wakeup/health/scheduler 无 Db/DbTx/drizzle 符号', () => {
    for (const file of files.filter((f) => !ASSEMBLY_FACE.has(f.path))) {
      expect(/\btype Db\b|\bDbTx\b|drizzle/.test(file.code), `${file.path} leaks Db symbol`).toBe(
        false,
      );
    }
  });
});

describe('③ ./composition 子入口只在 assembly.ts（唯一装配根）', () => {
  it('非 assembly 文件不得 import 任何 composition 子入口', () => {
    for (const file of files.filter((f) => f.path !== 'assembly.ts')) {
      expect(file.code.includes('/composition'), `${file.path} imports composition`).toBe(false);
    }
  });
});

describe('④ 跨包 import 只走包名 exports', () => {
  it('禁 @tillgate/*/src 深导入（边界门禁的文本前置）', () => {
    for (const file of files) {
      for (const spec of file.code.matchAll(/from\s+'(@tillgate\/[^']+)'/g)) {
        const specifier = defined(spec[1], 'matchAll capture');
        expect(specifier.includes('/src/'), `${file.path} → ${specifier}`).toBe(false);
      }
    }
  });
});

describe('⑤ @tillgate/ai 只在装配面（ADR-0007 注入形态）', () => {
  it('ai import 仅 assembly.ts（createAi 构造后注入 createInference，业务代码不持 Ai）', () => {
    for (const file of files.filter((f) => f.path !== 'assembly.ts')) {
      expect(
        file.code.includes("from '@tillgate/ai'"),
        `${file.path} 违反 ADR-0007（ai 只允许装配面）`,
      ).toBe(false);
    }
  });
});
