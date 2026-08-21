/**
 * client-api 分层边界铁律的机器强制：
 *
 *   1. app 只做协议适配与编排：源码只准 import @ai-gateway/{service,domain,repository,
 *      db,core,http,identity,identity-core} 与 node:/相对引用——账户域业务在本 app services
 *   2. 零 SQL：不 import drizzle-orm / pg（要用数据走 repository 包的新仓储）
 *   3. 不直接 import 账本包（ledger / ledger-core / wallet，见 FROZEN_LEDGER_PACKAGES 清单）
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
  '@ai-gateway/core',
  '@ai-gateway/http',
  '@ai-gateway/identity',
  '@ai-gateway/identity-core',
  'hono',
  'zod',
  'jose',
  '@hono/node-server',
  'ioredis',
];

const FROZEN_LEDGER_PACKAGES = ['@ai-gateway/ledger', '@ai-gateway/ledger-core', '@ai-gateway/wallet'];

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'dist' || entry === '__tests__') continue;
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

describe('client-api 分层边界', () => {
  const files = collectTsFiles(SRC_ROOT);
  const violationsOf = (predicate: (specifier: string) => boolean): string[] =>
    files.flatMap((file) =>
      importsOf(file)
        .filter(predicate)
        .map((specifier) => `${relative(SRC_ROOT, file)} → ${specifier}`),
    );

  it('外部依赖只有显式白名单（账户域业务在本 app；identity 是共享认证基建）', () => {
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

  it('零 SQL（drizzle-orm / pg 禁入——数据访问一律走 repository 包）', () => {
    const violations = violationsOf(
      (specifier) => specifier === 'drizzle-orm' || specifier === 'pg' || specifier.startsWith('drizzle-orm/'),
    );
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('冻结包禁入', () => {
    const violations = violationsOf((specifier) =>
      FROZEN_LEDGER_PACKAGES.some((frozen) => specifier === frozen || specifier.startsWith(frozen + '/')),
    );
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
