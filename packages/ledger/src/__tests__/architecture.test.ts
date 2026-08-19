/**
 * 架构边界测试：依赖铁律的机械强制（铁律见 docs/architecture.md）。
 *
 *   settlement → billing → {subscription, rating, channel-budget} → {wallet, ledger-core}
 *   platform 是根（不依赖任何域）；根 index.ts 只做再导出（可依赖一切）。
 *
 * 扫描 src 全部源文件的相对导入，越层/反向依赖即测试失败——铁律不再只靠
 * review 维持。外部依赖（@ai-gateway/* 与 npm 包）不受限；测试文件不受限。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 各节点允许依赖的内部域（platform = 根；root = src/index.ts 再导出口） */
const ALLOWED: Record<string, readonly string[]> = {
  platform: [],
  rating: ['platform'],
  subscription: ['platform'],
  'channel-budget': ['platform'],
  billing: ['platform', 'rating', 'subscription', 'channel-budget'],
  settlement: ['platform', 'rating', 'billing'],
  migration: ['platform'],
  root: ['platform', 'rating', 'subscription', 'channel-budget', 'billing', 'settlement', 'migration'],
};

function nodeOf(absPath: string): string | null {
  const rel = relative(SRC_ROOT, absPath).split(sep);
  if (rel.length <= 1) return 'root'; // src/index.ts（根出口）
  return rel[0]!;
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('依赖铁律：settlement → billing → {subscription, rating, channel-budget} → 内核', () => {
  it('src 内不存在越层/反向相对导入', () => {
    const violations: string[] = [];
    for (const file of collectTsFiles(SRC_ROOT)) {
      const from = nodeOf(file);
      if (from == null) {
        violations.push(`${relative(SRC_ROOT, file)}：无法归入任何域（应位于域目录下）`);
        continue;
      }
      const allowed = ALLOWED[from];
      if (!allowed) {
        violations.push(`${relative(SRC_ROOT, file)}：未知节点「${from}」（在 ALLOWED 登记或移入既有域）`);
        continue;
      }
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
        const specifier = match[1]!;
        const target = normalize(join(dirname(file), specifier));
        const to = nodeOf(target);
        if (to && to !== from && !allowed.includes(to)) {
          violations.push(
            `${relative(SRC_ROOT, file)} → ${specifier}（${from} 不得依赖 ${to}）`,
          );
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
