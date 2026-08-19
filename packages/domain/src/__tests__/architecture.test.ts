/**
 * domain 包边界铁律的机器强制：
 *
 *   1. 零外部世界：不 import drizzle-orm / @ai-gateway/* / pg / 任何 app——
 *      运行时依赖只有 decimal.js 与 node: 内建
 *   2. 域间方向（禁引表）：
 *      shared / wallet / rating 是核下层（被引用，不引用其他域）；
 *      billing 是结算编排域，允许下行引用 channel-budget 错误家谱，反向禁止
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 域间禁引表（未列出 = 允许） */
const FORBIDDEN_EDGES: Readonly<Record<string, readonly string[]>> = {
  shared: ['wallet', 'rating', 'billing', 'channel-budget', 'generation', 'subscription'],
  generation: ['wallet', 'rating', 'billing', 'channel-budget', 'subscription'],
  wallet: ['rating', 'billing', 'channel-budget', 'subscription'],
  rating: ['billing', 'channel-budget', 'subscription'],
  'channel-budget': ['billing', 'subscription'],
  subscription: ['billing', 'channel-budget', 'generation', 'rating'],
};

const isAllowedExternal = (specifier: string): boolean =>
  specifier.startsWith('node:') ||
  specifier === 'decimal.js' ||
  specifier.startsWith('decimal.js/');

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

interface ImportRef {
  file: string;
  specifier: string;
}

function importsOf(file: string): ImportRef[] {
  const text = readFileSync(file, 'utf8');
  const refs: ImportRef[] = [];
  for (const match of text.matchAll(/import\s+[^'"]*?from\s+'([^']+)'/g)) {
    refs.push({ file, specifier: match[1]! });
  }
  return refs;
}

/** 文件所属域（包根 index.ts 记为 'root'——方向规则豁免，它本来就是全量出口） */
function domainOf(file: string): string {
  const rel = relative(SRC_ROOT, file);
  return Object.keys(FORBIDDEN_EDGES).find((domain) => rel.startsWith(domain + '/')) ?? 'root';
}

/** 相对 import 解析后的目标域（解析出包外或包根则 null） */
function targetDomain(ref: ImportRef): string | null {
  const resolved = resolve(dirname(ref.file), ref.specifier);
  const rel = relative(SRC_ROOT, resolved);
  if (rel.startsWith('..')) return null;
  return (
    Object.keys(FORBIDDEN_EDGES).find(
      (domain) => rel === domain || rel.startsWith(domain + '/'),
    ) ?? null
  );
}

describe('domain 包边界', () => {
  const files = collectTsFiles(SRC_ROOT);
  const allImports = files.flatMap(importsOf);

  it('零外部依赖（drizzle / @ai-gateway/* / pg / app 全部禁入）', () => {
    const violations = allImports
      .filter((ref) => !ref.specifier.startsWith('.') && !isAllowedExternal(ref.specifier))
      .map((ref) => `${relative(SRC_ROOT, ref.file)} → ${ref.specifier}`);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('域间方向：核下层不引上层；channel-budget 不反向引用 billing', () => {
    const violations = allImports
      .filter((ref) => ref.specifier.startsWith('.'))
      .map((ref) => {
        const own = domainOf(ref.file);
        if (own === 'root') return null;
        const target = targetDomain(ref);
        if (target == null || target === own) return null;
        return FORBIDDEN_EDGES[own]?.includes(target)
          ? `${relative(SRC_ROOT, ref.file)}(${own}) → ${target}（禁引方向）`
          : null;
      })
      .filter((line): line is string => line != null);
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
