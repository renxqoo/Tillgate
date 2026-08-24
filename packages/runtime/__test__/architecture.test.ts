/**
 * 边界测试（铁律 11：边界必须可执行）——参照 packages/observability 同名文件写法：
 * src import 白名单（仅 @tillgate/errors、ioredis、pino、pino-pretty、zod、node:*——
 * 结构方案 §5.1：runtime 只可依赖 errors，不反向依赖 observability）/ 双入口导出面快照 /
 * testing 子入口不进主入口（vitest 语义不得混入生产 bundle，IMPLEMENTATION §3.1）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as exports from '../src/index';
import * as testing from '../src/testing';
import { defined } from './defined';

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const SRC = join(import.meta.dirname, '../src');
const files = tsFiles(SRC);

/** 收集一个文件全部 import/export-from 的外部说明符（相对路径除外） */
function externalSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const spec = defined(match[1], 'match[1]');
    if (!spec.startsWith('.') && !spec.startsWith('#')) out.push(spec);
  }
  return out;
}

describe('依赖白名单（§5.1：runtime 只依赖 @tillgate/errors + ioredis/pino/pino-pretty/zod/node:）', () => {
  it('src 全部外部 import 落在白名单内', () => {
    const ALLOWED = /^(?:@tillgate\/errors|ioredis|pino|pino-pretty|zod|node:[\w:]+)$/;
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of externalSpecifiers(readFileSync(file, 'utf8'))) {
        if (!ALLOWED.test(spec)) offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('零 http/observability/ai/业务包/apps 引用（不反向依赖观察面与业务能力）', () => {
    const BANNED =
      /^@tillgate\/(http|observability|ai|api-client|accounts|billing|control-plane|inference|identity|notifications)$/;
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of externalSpecifiers(readFileSync(file, 'utf8'))) {
        if (BANNED.test(spec)) offenders.push(`${file}: ${spec}`);
      }
      if (/from\s+['"]\.\.\/\.\.\/\.\.\/apps\//.test(readFileSync(file, 'utf8'))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('双入口导出面快照（有意维护的公共接口——新增导出是契约变更）', () => {
  it('index.ts 值导出集合精确等于下表（rate-limiter/auth-guards 面属并行迁移单元，随其文档收口）', () => {
    expect(Object.keys(exports).toSorted()).toEqual([
      'assertRedisReachable',
      'authGuardUnavailable',
      'createAuthFailureGuard',
      'createCipher',
      'createKeyBruteForceGuard',
      'createLogger',
      'createRedisClient',
      'createRedisScriptRunner',
      'createShutdown',
      'createSlidingWindowLimiter',
      'parseSentinels',
      'rateLimitUnavailable',
      'secretSchema',
      'strictBooleanSchema',
    ]);
  });

  it('testing/index.ts 值导出集合精确等于下表（测试装置面）', () => {
    expect(Object.keys(testing).toSorted()).toEqual([
      'connectTestRedis',
      'disconnectTestRedis',
      'testRedisUrl',
      'waitForRedisReady',
    ]);
  });

  it('testing 不进主入口（vitest 语义不得混入生产 bundle——IMPLEMENTATION §3.1）', () => {
    const indexText = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(indexText).not.toMatch(/['"]\.\/testing/);
    for (const name of Object.keys(testing)) {
      expect(Object.keys(exports)).not.toContain(name);
    }
  });
});
