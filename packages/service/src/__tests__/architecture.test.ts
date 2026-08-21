/**
 * service 包边界铁律的机器强制：
 *
 *   1. 不写 SQL：源码禁 import drizzle-orm（测试允许——断言/清理要用）
 *   2. 依赖箭头唯一：只依赖 @ai-gateway/domain 与 @ai-gateway/repository；
 *      禁 @ai-gateway/db（Db/DbTx 类型经 repository 再导出）、禁一切旧包
 *   3. 包内方向：wallet / channel-budget / shared 互不引用，
 *      billing 可引用 wallet（预扣走钱包动词）；context 人人可引
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('../', import.meta.url));

const FORBIDDEN_PACKAGES = [
  '@ai-gateway/ledger',
  '@ai-gateway/wallet',
  '@ai-gateway/ledger-core',
  '@ai-gateway/db',
  'drizzle-orm',
  'pg',
];

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

function importsOf(file: string): Array<{ file: string; specifier: string }> {
  const text = readFileSync(file, 'utf8');
  const refs: Array<{ file: string; specifier: string }> = [];
  for (const match of text.matchAll(/import\s+(?:type\s+)?[^'"]*?from\s+'([^']+)'/g)) {
    refs.push({ file, specifier: match[1]! });
  }
  for (const match of text.matchAll(/import\(\s*'([^']+)'/g)) {
    refs.push({ file, specifier: match[1]! });
  }
  return refs;
}

describe('service 包边界', () => {
  const files = collectTsFiles(SRC_ROOT);
  const allImports = files.flatMap(importsOf);

  it('零 SQL 零 db 直连（drizzle-orm / @ai-gateway/db 禁入；类型经 repository）', () => {
    const violations = allImports
      .filter((ref) => FORBIDDEN_PACKAGES.includes(ref.specifier))
      .map((ref) => `${relative(SRC_ROOT, ref.file)} → ${ref.specifier}`);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('外部依赖只有 domain 与 repository', () => {
    const violations = allImports
      .filter((ref) => !ref.specifier.startsWith('.') && !ref.specifier.startsWith('node:'))
      .filter((ref) => ref.specifier !== '@ai-gateway/domain' && ref.specifier !== '@ai-gateway/repository')
      .map((ref) => `${relative(SRC_ROOT, ref.file)} → ${ref.specifier}`);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('包内单向：billing → wallet 允许；wallet/channel-budget/shared 不上行引用', () => {
    const rules: Array<{ from: string; forbidden: string[] }> = [
      { from: 'funding', forbidden: ['../billing/', '../settlement/'] },
      { from: 'wallet', forbidden: ['../billing/', '../channel-budget/', '../shared/', '../funding/', '../settlement/'] },
      { from: 'channel-budget', forbidden: ['../billing/', '../wallet/', '../funding/', '../settlement/'] },
      { from: 'shared', forbidden: ['../billing/', '../wallet/', '../channel-budget/', '../funding/', '../settlement/'] },
    ];
    const violations: string[] = [];
    for (const ref of allImports) {
      if (!ref.specifier.startsWith('.')) continue;
      const rel = relative(SRC_ROOT, ref.file);
      for (const rule of rules) {
        if (rel.startsWith(rule.from + '/') && rule.forbidden.some((f) => ref.specifier.startsWith(f))) {
          violations.push(`${rel} → ${ref.specifier}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
