/**
 * 架构边界门禁(AGENT.md §0.11 / 总纲 §5.5):目录约定不靠记忆,靠本测试执行。
 * 规则来源 DESIGN §6(依赖白名单)与 §5 硬约束:
 * - domain:零基础设施(仅 errors + decimal.js + node: 内建 + 域内相对引用);
 * - application:本包 domain/ports + errors + db(事务壳与类型)——禁 drizzle/pg 直连、
 *   禁 adapters、禁 http/runtime;
 * - ports:类型契约(db 类型 + domain)——零 SQL/零实现依赖;
 * - adapters:ports/domain + db + drizzle——不出现在其他层的 import 里(除 accounts.ts 装配);
 * - 公共出口(index.ts)不得泄漏 Db/DbTx/adapters 符号。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

interface SourceFile {
  readonly path: string; // 相对 src/
  readonly layer: 'domain' | 'application' | 'ports' | 'adapters' | 'testing' | 'root';
  readonly imports: string[];
}

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith('.ts')) {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

function layerOf(path: string): SourceFile['layer'] {
  if (path.startsWith('domain/')) return 'domain';
  if (path.startsWith('application/')) return 'application';
  if (path.startsWith('ports/')) return 'ports';
  if (path.startsWith('adapters/')) return 'adapters';
  if (path.startsWith('testing/')) return 'testing';
  return 'root';
}

const files: SourceFile[] = walk(srcDir).map((path) => ({
  path,
  layer: layerOf(path),
  imports: [...readFileSync(`${srcDir}/${path}`, 'utf-8').matchAll(/from\s+'([^']+)'/g)].map(
    (m) => m[1]!,
  ),
}));

describe('分层依赖白名单(§5 硬约束的可执行形态)', () => {
  it('domain:仅 errors/decimal.js/node: 内建/域内相对引用(禁 db、drizzle、上层)', () => {
    for (const f of files.filter((x) => x.layer === 'domain')) {
      for (const spec of f.imports) {
        const ok =
          spec.startsWith('node:') ||
          spec === 'decimal.js' ||
          spec === '@tokenlens/errors' ||
          (spec.startsWith('./') && !spec.startsWith('../'));
        expect(ok, `${f.path} → ${spec}`).toBe(true);
      }
    }
  });

  it('application:本包 domain/ports + errors + db(事务壳);禁 drizzle/pg/adapters/http/runtime', () => {
    for (const f of files.filter((x) => x.layer === 'application')) {
      for (const spec of f.imports) {
        const ok =
          spec.startsWith('node:') ||
          spec === '@tokenlens/errors' ||
          spec === '@tokenlens/db' ||
          spec.startsWith('./') ||
          spec.startsWith('../domain/') ||
          spec.startsWith('../ports/');
        expect(ok, `${f.path} → ${spec}`).toBe(true);
      }
    }
  });

  it('ports:类型契约(db 类型 + domain);零 SQL/零实现依赖', () => {
    for (const f of files.filter((x) => x.layer === 'ports')) {
      for (const spec of f.imports) {
        const ok =
          spec.startsWith('node:') ||
          spec === '@tokenlens/errors' ||
          spec === '@tokenlens/db' ||
          spec.startsWith('./') ||
          spec.startsWith('../domain/');
        expect(ok, `${f.path} → ${spec}`).toBe(true);
      }
    }
  });

  it('adapters/testing:ports/domain + db + drizzle(实现层);root 装配面(accounts.ts)可引 adapters', () => {
    for (const f of files.filter((x) => x.layer === 'adapters' || x.layer === 'testing')) {
      for (const spec of f.imports) {
        const ok =
          spec.startsWith('node:') ||
          spec === '@tokenlens/db' ||
          spec === '@tokenlens/errors' ||
          spec === 'decimal.js' ||
          spec === 'drizzle-orm' ||
          spec.startsWith('drizzle-orm/') ||
          spec.startsWith('./') ||
          spec.startsWith('../');
        expect(ok, `${f.path} → ${spec}`).toBe(true);
      }
    }
  });

  it('adapters 不被 application/ports/testing 之外的层引用(装配点 = accounts.ts + composition 子入口——与 billing 同约定)', () => {
    for (const f of files) {
      if (
        f.path === 'accounts.ts' ||
        f.path === 'composition.ts' ||
        f.layer === 'adapters' ||
        f.layer === 'testing'
      ) {
        continue;
      }
      for (const spec of f.imports) {
        expect(
          spec.startsWith('../adapters/') || spec.startsWith('./adapters/'),
          `${f.path} → ${spec}`,
        ).toBe(false);
      }
    }
  });

  it('全包禁直连 pg/@tokenlens/http/@tokenlens/runtime(DESIGN §6 白名单)', () => {
    for (const f of files) {
      for (const spec of f.imports) {
        const banned = spec === 'pg' || spec === '@tokenlens/http' || spec === '@tokenlens/runtime';
        expect(banned, `${f.path} → ${spec}`).toBe(false);
      }
    }
  });
});

/** 剥离块注释与行注释后的代码面(符号检查不因注释误报) */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('公共出口封闭(§5.3:facade 与类型,不泄漏基础设施)', () => {
  const index = stripComments(readFileSync(`${srcDir}/index.ts`, 'utf-8'));

  it('index.ts 不 import adapters(装配细节不出公共面)', () => {
    expect(index.includes('./adapters')).toBe(false);
  });

  it('index.ts 不出现 Db/DbTx/drizzle 符号(签名零基础设施类型)', () => {
    expect(index.includes('DbTx')).toBe(false);
    expect(index.includes('drizzle')).toBe(false);
    expect(/\bDb\b/.test(index)).toBe(false);
  });

  it('facade 文件唯一(accounts.ts),且 verbs 绑定文件不含 SQL', () => {
    const roots = files.filter((f) => f.layer === 'root');
    expect(roots.map((f) => f.path).toSorted()).toEqual([
      'accounts.ts',
      'composition.ts',
      'index.ts',
    ]);
    const binder = stripComments(
      readFileSync(`${srcDir}/application/create-use-cases.ts`, 'utf-8'),
    );
    expect(binder.includes('drizzle')).toBe(false);
  });

  it('AccountStorePort(DbLike 存储契约)不走根出口,只在 ./composition(§5.3 收紧)', () => {
    expect(index.includes('AccountStorePort')).toBe(false);
    const composition = stripComments(readFileSync(`${srcDir}/composition.ts`, 'utf-8'));
    expect(composition.includes('AccountStorePort')).toBe(true);
  });

  it('domain/application/ports 不 import ../composition(装配子入口仅装配面可用)', () => {
    for (const f of files) {
      if (f.layer !== 'domain' && f.layer !== 'application' && f.layer !== 'ports') continue;
      for (const spec of f.imports) {
        expect(spec.includes('composition'), `${f.path} → ${spec}`).toBe(false);
      }
    }
  });
});
