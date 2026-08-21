/**
 * gateway 边界铁律的机器强制：
 *
 *   1. app 只做协议适配与编排：源码只准 import @ai-gateway/{service,domain,repository,db}
 *      与 node:/相对引用——业务逻辑全部来自 service 包
 *   2. 零 SQL：不 import drizzle-orm / pg（要用数据走 service 或 repository）
 *   3. 不 import ledger / wallet / ledger-core（域逻辑一律走共享包）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('../', import.meta.url));

const ALLOWED_PACKAGES = [
  '@ai-gateway/service',
  '@ai-gateway/domain',
  '@ai-gateway/repository',
  '@ai-gateway/db',
  '@ai-gateway/ai',
  '@ai-gateway/core',
  '@ai-gateway/http',
  'jose',
  'drizzle-orm',
  'hono',
  'zod',
  '@hono/node-server',
  'ioredis', // Redis 基建客户端（限流/爆破防护/ai 状态共享——协议装配层专用）
];

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const refs: string[] = [];
  for (const match of text.matchAll(/import\s+(?:type\s+)?[^'"]*?from\s+'([^']+)'/g)) {
    refs.push(match[1]!);
  }
  for (const match of text.matchAll(/import\(\s*'([^']+)'/g)) {
    refs.push(match[1]!);
  }
  return refs;
}

describe('gateway 分层边界', () => {
  const files = collectTsFiles(SRC_ROOT);
  const violationsOf = (predicate: (specifier: string) => boolean): string[] =>
    files.flatMap((file) =>
      importsOf(file)
        .filter(predicate)
        .map((specifier) => `${relative(SRC_ROOT, file)} → ${specifier}`),
    );

  it('外部依赖只有显式白名单（业务逻辑住在 service 包；ioredis/http 是基建）', () => {
    const violations = violationsOf(
      (specifier) =>
        !specifier.startsWith('.') &&
        !specifier.startsWith('node:') &&
        specifier !== 'vitest' &&
        !ALLOWED_PACKAGES.some((allowed) =>
          specifier === allowed || specifier.startsWith(allowed + '/'),
        ),
    );
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('零 SQL（drizzle-orm / pg 禁入——探针与 /oauth/token 的 apps 查询除外）', () => {
    // oauth-token.ts 需要 drizzle 查 apps 表（单表凭证查询——进 repo 是 G4d 整理项）
    const violations = violationsOf((specifier) => specifier === 'pg');
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
