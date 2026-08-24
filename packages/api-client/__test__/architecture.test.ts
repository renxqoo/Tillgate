/**
 * 架构边界门禁(铁律 11):目录约定由机器验证。
 * - 根入口依赖闭包不得 import next/(总纲 §3 树注释)
 * - 全包禁止任何私有 @tillgate/* / @ai-gateway/* import(发布闭包,总纲 §5.1)
 * - package.json 依赖闭包无私有 workspace 包;exports 恰为 '.' 与 './next'
 * - 双出口运行时词表逐一锁定(§10.1 词表封闭性;收编 v1 api-path-contract.test)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkgRoot = join(__dirname, '..');
const srcRoot = join(pkgRoot, 'src');

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map((f) => join(dir, String(f)))
    .filter((f) => f.endsWith('.ts'));
}

/** import 语句形态的模块说明符匹配(注释中提到包名不算依赖) */
const NEXT_IMPORT = /(?:from\s+|import\()\s*['"][^'"]*next\//;
const PRIVATE_IMPORT = /(?:from\s+|import\()\s*['"](?:@tillgate|@ai-gateway)\//;

describe('边界:根入口闭包框架无关', () => {
  it('src/**(除 src/next/**)不存在任何 next/ 导入', () => {
    for (const file of listTsFiles(srcRoot)) {
      if (file.startsWith(join(srcRoot, 'next') + sep)) continue;
      const source = readFileSync(file, 'utf8');
      expect(source, `${relative(pkgRoot, file)} 不应 import next`).not.toMatch(NEXT_IMPORT);
    }
  });

  it('src/index.ts 不导入 ./next 子入口', () => {
    const source = readFileSync(join(srcRoot, 'index.ts'), 'utf8');
    expect(source).not.toMatch(NEXT_IMPORT);
  });
});

describe('边界:发布依赖闭包(总纲 §5.1)', () => {
  it('全包源码无 @tillgate/* 与 @ai-gateway/* 导入', () => {
    for (const file of listTsFiles(srcRoot)) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${relative(pkgRoot, file)} 不应依赖私有包`).not.toMatch(PRIVATE_IMPORT);
    }
  });

  it('package.json 无私有/ workspace 依赖,dependencies 为空', () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    const all = JSON.stringify({ ...pkg.peerDependencies, ...pkg.devDependencies });
    expect(all).not.toContain('@tillgate/');
    expect(all).not.toContain('@ai-gateway/');
    expect(all).not.toContain('workspace:');
  });

  it('exports 恰为 "." 与 "./next",且不指向 dist 之外路径', () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, Record<string, string>>;
    };
    expect(Object.keys(pkg.exports).toSorted()).toEqual(['.', './next']);
    for (const entry of Object.values(pkg.exports)) {
      for (const target of Object.values(entry)) {
        expect(target.startsWith('./src/') || target.startsWith('./dist/')).toBe(true);
      }
    }
  });
});

describe('路径契约(v1 api-path-contract 收编)', () => {
  it('调用封装不做路径翻译,只接受 /v1/* 正式路径', () => {
    const source = readFileSync(join(srcRoot, 'core', 'client.ts'), 'utf8');
    expect(source).not.toContain('function mapPath');
    expect(source).toContain("path.startsWith('/v1/')");
  });
});

describe('词表封闭:双出口运行时导出逐一锁定(§10.1)', () => {
  it('根入口运行时导出恰为 5 个公共符号', async () => {
    const root = await import('../src/index');
    expect(Object.keys(root).toSorted()).toEqual([
      'ApiError',
      'buildListQuery',
      'createAdminApiClient',
      'createClientApiClient',
      'createHttpClient',
    ]);
  });

  it('./next 子入口运行时导出恰为 25 个公共符号', async () => {
    const next = await import('../src/next/index');
    expect(Object.keys(next).toSorted()).toEqual([
      'ADMIN_SESSION_COOKIE',
      'DEFAULT_LOCALE',
      'LOCALES',
      'LOCALE_COOKIE',
      'LOCALE_COOKIE_MAX_AGE',
      'SESSION_COOKIE',
      'clearAdminSessionCookie',
      'clearSessionCookie',
      'createNextAdminApiClient',
      'createNextClientApiClient',
      'getAdminApiBase',
      'getAdminSessionToken',
      'getClientApiBase',
      'getSessionToken',
      'hasAdminSessionCookie',
      'hasSessionCookie',
      'htmlLang',
      'isLocale',
      'outgoingLocale',
      'outgoingUserIpHeader',
      'parseAcceptLanguage',
      'resolveLocale',
      'setAdminSessionToken',
      'setSessionToken',
      'trustedClientIp',
    ]);
  });
});
