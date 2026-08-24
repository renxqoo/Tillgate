/**
 * 架构边界门禁(AGENT.md §0.11 / 总纲 §5.5):目录约定不靠记忆,靠本测试执行。
 * 规则来源 DESIGN §5(依赖白名单)与总纲 §5 硬约束:
 * - domain:零基础设施(仅 errors + node: 内建 + 域内相对引用);
 * - application:本包 domain/ports/templates + errors + db(事务壳与类型)——禁 drizzle/pg
 *   直连、禁 adapters、禁 http/runtime/ai(本包禁依赖 ai,SSRF 经 UrlGuard 注入);
 * - ports:类型契约(db 类型 + domain)——零 SQL/零实现依赖;
 * - adapters:ports/domain + db + drizzle/nodemailer(实现层)——不被其他层引用
 *   (唯一装配点 = notifications.ts/composition.ts 根装配面);
 * - 公共出口(index.ts)不得泄漏 Db/DbTx/adapters 符号;composition 不进根出口。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

interface SourceFile {
  readonly path: string; // 相对 src/
  readonly layer: 'domain' | 'application' | 'ports' | 'adapters' | 'templates' | 'root';
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
  if (path.startsWith('templates/')) return 'templates';
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
  it('domain:仅 errors/node: 内建/域内相对引用(禁 db、drizzle、上层)', () => {
    for (const f of files.filter((x) => x.layer === 'domain')) {
      for (const spec of f.imports) {
        const ok =
          spec.startsWith('node:') ||
          spec === '@tillgate/errors' ||
          (spec.startsWith('./') && !spec.startsWith('../'));
        expect(ok, `${f.path} → ${spec}`).toBe(true);
      }
    }
  });

  it('application/templates:本包 domain/ports/templates + errors + db(事务壳);禁 drizzle/adapters/http/runtime/ai', () => {
    for (const f of files.filter((x) => x.layer === 'application' || x.layer === 'templates')) {
      for (const spec of f.imports) {
        const ok =
          spec.startsWith('node:') ||
          spec === '@tillgate/errors' ||
          spec === '@tillgate/db' ||
          spec === '../errors' ||
          spec.startsWith('./') ||
          spec.startsWith('../domain/') ||
          spec.startsWith('../ports/') ||
          spec.startsWith('../templates/');
        expect(ok, `${f.path} → ${spec}`).toBe(true);
      }
    }
  });

  it('ports:类型契约(db 类型 + domain);零 SQL/零实现依赖', () => {
    for (const f of files.filter((x) => x.layer === 'ports')) {
      for (const spec of f.imports) {
        const ok =
          spec.startsWith('node:') ||
          spec === '@tillgate/errors' ||
          spec === '@tillgate/db' ||
          spec.startsWith('./') ||
          spec.startsWith('../domain/');
        expect(ok, `${f.path} → ${spec}`).toBe(true);
      }
    }
  });

  it('adapters:ports/domain + db + drizzle/nodemailer(实现层)', () => {
    for (const f of files.filter((x) => x.layer === 'adapters')) {
      for (const spec of f.imports) {
        const ok =
          spec.startsWith('node:') ||
          spec === '@tillgate/db' ||
          spec === '@tillgate/errors' ||
          spec === 'drizzle-orm' ||
          spec.startsWith('drizzle-orm/') ||
          spec === 'nodemailer' ||
          spec.startsWith('nodemailer/') ||
          spec.startsWith('./') ||
          spec.startsWith('../');
        expect(ok, `${f.path} → ${spec}`).toBe(true);
      }
    }
  });

  it('adapters 只被根装配面引用(notifications.ts/composition.ts)', () => {
    for (const f of files) {
      if (f.path === 'notifications.ts' || f.path === 'composition.ts' || f.layer === 'adapters')
        continue;
      for (const spec of f.imports) {
        expect(
          spec.startsWith('../adapters/') || spec.startsWith('./adapters/'),
          `${f.path} → ${spec}`,
        ).toBe(false);
      }
    }
  });

  it('全包禁 pg/@tillgate/http/@tillgate/runtime/@tillgate/ai 与业务能力包(DESIGN §5 白名单)', () => {
    const banned = [
      'pg',
      '@tillgate/http',
      '@tillgate/runtime',
      '@tillgate/ai',
      '@tillgate/accounts',
      '@tillgate/billing',
      '@tillgate/inference',
      '@tillgate/control-plane',
      '@tillgate/identity',
    ];
    for (const f of files) {
      for (const spec of f.imports) {
        expect(banned.includes(spec), `${f.path} → ${spec}`).toBe(false);
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

  it('根装配面文件集合封闭(notifications/composition/index/errors)', () => {
    const roots = files.filter((f) => f.layer === 'root');
    expect(roots.map((f) => f.path).toSorted()).toEqual([
      'composition.ts',
      'errors.ts',
      'index.ts',
      'notifications.ts',
    ]);
  });
});
