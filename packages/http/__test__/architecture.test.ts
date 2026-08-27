/**
 * 边界测试——边界必须可执行：
 * src import 白名单（仅 @tillgate/errors、hono、zod、@hono/node-server、node:*）/
 * index.ts 导出面快照（新增导出是契约变更）/
 * 断言零 @tillgate/db 与业务包引用（http 永不认识业务码）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as exports from '../src/index';
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
    const spec = defined(match[1], 'import specifier');
    if (!spec.startsWith('.') && !spec.startsWith('#')) out.push(spec);
  }
  return out;
}

describe('依赖白名单（§5.1：http 只依赖 @tillgate/errors + hono/zod/@hono/node-server/node:）', () => {
  it('src 全部外部 import 落在白名单内', () => {
    const ALLOWED =
      /^(?:@tillgate\/errors|hono(?:\/[\w/-]+)?|@hono\/node-server(?:\/[\w/-]+)?|zod|node:[\w:]+)$/;
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of externalSpecifiers(readFileSync(file, 'utf8'))) {
        if (!ALLOWED.test(spec)) offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('零 @tillgate/db 与业务/观测包引用（ADR-0001 D1 + ADR-0002：http 不 import db 与业务能力）', () => {
    const BANNED =
      /^@tillgate\/(db|runtime|observability|ai|api-client|accounts|billing|control-plane|inference|identity|notifications)$/;
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of externalSpecifiers(readFileSync(file, 'utf8'))) {
        if (BANNED.test(spec)) offenders.push(`${file}: ${spec}`);
      }
      // 只匹配真实 import 语句（注释中的包名不构成依赖）
      if (/from\s+['"]\.\.\/\.\.\/\.\.\/apps\//.test(readFileSync(file, 'utf8'))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('出口面快照（有意维护的公共接口——新增导出是契约变更）', () => {
  it('index.ts 值导出集合精确等于下表', () => {
    expect(Object.keys(exports).toSorted()).toEqual([
      'CATEGORY_STATUS_DEFAULTS',
      'DEFAULT_LOCALE',
      'GENERIC_INTERNAL_MESSAGE',
      'GENERIC_UNAVAILABLE_MESSAGE',
      'HttpErrors',
      'LOCALES',
      'LOCALE_COOKIE',
      'LOCALE_COOKIE_MAX_AGE',
      'PAGE_SIZE_DEFAULT',
      'PAGE_SIZE_MAX',
      'bodyParserLimit',
      'clientIpFromContext',
      'corsPreflight',
      'dbBudgetMiddleware',
      'errorBody',
      'errorHandler',
      'escapeLike',
      'generateRedeemCode',
      'htmlLang',
      'intParam',
      'isLocale',
      'jsonBody',
      'limitOffset',
      'listQuerySchema',
      'localeFromContext',
      'maskUpstreamKey',
      'operationId',
      'paginateQuery',
      'paginatedResult',
      'paginationQuerySchema',
      'parseAcceptLanguage',
      'parsePagination',
      'pgRejection',
      'query',
      'renderError',
      'requestIdMiddleware',
      'resolveLocale',
      'searchQuerySchema',
      'securityHeaders',
      'serveApp',
      'socketAddressFromContext',
      'sortOrderSchema',
      'sortQuerySchema',
      'suggestDbBudget',
      'timingSafeTokenEqual',
      'trustedClientIp',
    ]);
  });

  it('不导出 adapter/供应商类型与业务目录（包内部细节不出公共面）', () => {
    for (const name of Object.keys(exports)) {
      expect(name).not.toMatch(/^drizzle|^postgres|Repository$|Adapter$/i);
    }
  });
});
