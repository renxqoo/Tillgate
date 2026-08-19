/**
 * 架构边界测试：本包只依赖 packages/db 与 drizzle-orm——
 * import 任何 app / 其他业务包即失败（四层铁律的机器强制）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED = new Set(['drizzle-orm', '@ai-gateway/db']);

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('repository 包边界：只准依赖 db 与 drizzle', () => {
  it('源码不存在越界 import', () => {
    const violations: string[] = [];
    for (const file of collectTsFiles(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/from\s+'([^'.][^']*)'/g)) {
        const specifier = match[1]!;
        const pkg = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier;
        if (!ALLOWED.has(pkg)) {
          violations.push(`${file.replace(SRC_ROOT + '/', '')} → ${specifier}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('源码不出现裸 SQL 标记之外的逃逸（sql 模板仅经 drizzle-orm）', () => {
    // 蓝天护栏：SQL 字面量必须走 drizzle 的 sql`` 模板（参数化），禁字符串拼接执行
    const violations: string[] = [];
    for (const file of collectTsFiles(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8');
      if (/\.raw\(/.test(text) && !file.endsWith('.repo.ts')) {
        violations.push(`${file.replace(SRC_ROOT + '/', '')} 出现 sql.raw（仅 .repo.ts 允许）`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
