/**
 * admin-api 分层边界铁律的机器强制：
 *
 *   1. app 只做协议适配与编排：源码只准 import v2 共享包 + ai 适配器包
 *      与 node:/相对引用——管理域业务在本 app services
 *   2. 零 SQL：不 import drizzle-orm / pg（要用数据走 repository 包）
 *      （测试文件豁免——测试直插造数/断言库态是白盒验证的一部分）
 *   3. 全新实现：不 import v1 冻结包（ledger / ledger-core / wallet / v1 apps）
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
  '@ai-gateway/ai',
  '@ai-gateway/tracing',
  'hono',
  'zod',
  'jose',
  '@hono/node-server',
  'ioredis',
];

const FROZEN_V1 = ['@ai-gateway/ledger', '@ai-gateway/ledger-core', '@ai-gateway/wallet'];

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'dist' || entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('admin-api 分层边界', () => {
  const files = collectTsFiles(SRC_ROOT);

  it('源码不 import 白名单外的包，不 import v1 冻结包', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const match of src.matchAll(/from '([^']+)'/g)) {
        const spec = match[1]!;
        if (!spec.startsWith('@ai-gateway/')) continue;
        if (FROZEN_V1.some((frozen) => spec === frozen || spec.startsWith(`${frozen}/`))) {
          offenders.push(`${relative(SRC_ROOT, file)} → ${spec}（v1 冻结包）`);
          continue;
        }
        const root = spec.split('/').slice(0, 2).join('/');
        if (!ALLOWED_PACKAGES.includes(root)) {
          offenders.push(`${relative(SRC_ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('零 SQL：源码不 import drizzle-orm / pg', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (/from '(drizzle-orm|pg)('|\/)/.test(src)) {
        offenders.push(relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('路由层不 import repository（会话 uid 由中间件注入，数据走 services）', () => {
    const offenders: string[] = [];
    const routesDir = join(SRC_ROOT, 'routes');
    for (const file of collectTsFiles(routesDir)) {
      const src = readFileSync(file, 'utf8');
      if (src.includes('@ai-gateway/repository')) {
        offenders.push(relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
