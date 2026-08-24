/**
 * 架构边界门禁(AGENT.md §0.11 / 总纲 §5.5):目录约定不靠记忆,靠本测试执行。
 * 规则来源 DESIGN §5(依赖白名单)与总纲 §5 硬约束(identity 无 Hono/无 runtime/
 * 不反向依赖业务能力包):
 * - domain:零基础设施(仅 errors + node: 内建 + 域内相对引用);
 * - application:本包 domain/ports + errors + db(事务壳与锁)——禁 drizzle 直连、
 *   禁 adapters、禁 hono/http/runtime/ai/业务能力包;
 * - ports:类型契约(db 类型 + domain)——零 SQL/零实现依赖;
 * - adapters:ports/domain + db + drizzle/jose/nodemailer(实现层)——仅被根装配面
 *   (identity.ts/composition.ts)引用;
 * - testing:包内测试装置(domain/ports/application/根 facade)——不进公共 exports;
 * - 公共出口(index.ts)不得泄漏 Db/DbTx/adapters 符号;composition 不进根出口。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defined } from './defined.js';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

interface SourceFile {
  readonly path: string; // 相对 src/
  readonly layer:
    | 'domain'
    | 'application'
    | 'ports'
    | 'adapters'
    | 'templates'
    | 'testing'
    | 'root';
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
  if (path.startsWith('testing/')) return 'testing';
  return 'root';
}

const files: SourceFile[] = walk(srcDir).map((path) => ({
  path,
  layer: layerOf(path),
  imports: [...readFileSync(`${srcDir}/${path}`, 'utf-8').matchAll(/from\s+'([^']+)'/g)].map((m) =>
    defined(m[1], 'match group'),
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

  it('application/templates:本包 domain/ports/templates + errors + db(事务壳与锁);禁 drizzle/adapters/http/runtime/ai', () => {
    for (const f of files.filter((x) => x.layer === 'application' || x.layer === 'templates')) {
      for (const spec of f.imports) {
        const ok =
          spec.startsWith('node:') ||
          spec === '@tillgate/errors' ||
          spec === '@tillgate/db' ||
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
          spec === '@tillgate/errors' ||
          spec === '@tillgate/db' ||
          spec.startsWith('./') ||
          spec.startsWith('../domain/');
        expect(ok, `${f.path} → ${spec}`).toBe(true);
      }
    }
  });

  it('adapters:ports/domain + db + drizzle/jose/nodemailer(实现层)', () => {
    for (const f of files.filter((x) => x.layer === 'adapters')) {
      for (const spec of f.imports) {
        const ok =
          spec.startsWith('node:') ||
          spec === '@tillgate/db' ||
          spec === '@tillgate/errors' ||
          spec === 'drizzle-orm' ||
          spec.startsWith('drizzle-orm/') ||
          spec === 'jose' ||
          spec.startsWith('jose/') ||
          spec === 'nodemailer' ||
          spec.startsWith('nodemailer/') ||
          spec.startsWith('./') ||
          spec.startsWith('../');
        expect(ok, `${f.path} → ${spec}`).toBe(true);
      }
    }
  });

  it('testing:domain/ports/application/根 facade + db(包内测试装置;不 import adapters)', () => {
    for (const f of files.filter((x) => x.layer === 'testing')) {
      for (const spec of f.imports) {
        const ok =
          spec.startsWith('node:') ||
          spec === '@tillgate/db' ||
          spec.startsWith('./') ||
          spec.startsWith('../domain/') ||
          spec.startsWith('../ports/') ||
          spec.startsWith('../application/') ||
          spec === '../identity.js';
        expect(ok, `${f.path} → ${spec}`).toBe(true);
      }
    }
  });

  it('adapters 只被根装配面引用(identity.ts/composition.ts)', () => {
    for (const f of files) {
      if (f.path === 'identity.ts' || f.path === 'composition.ts' || f.layer === 'adapters') {
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

  it('application/domain/ports 不 import ../composition(装配子入口仅装配面可用,§5.3)', () => {
    for (const f of files) {
      if (f.layer !== 'application' && f.layer !== 'domain' && f.layer !== 'ports') continue;
      for (const spec of f.imports) {
        expect(spec.includes('composition'), `${f.path} → ${spec}`).toBe(false);
      }
    }
  });

  it('全包禁 pg/hono/@tillgate/http/@tillgate/runtime/@tillgate/ai 与业务能力包(DESIGN §5 白名单)', () => {
    const banned = [
      'pg',
      'hono',
      '@tillgate/http',
      '@tillgate/runtime',
      '@tillgate/ai',
      '@tillgate/accounts',
      '@tillgate/billing',
      '@tillgate/inference',
      '@tillgate/control-plane',
      '@tillgate/notifications',
      '@tillgate/observability',
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

  it('index.ts 不 import adapters 与 testing(装配细节不出公共面)', () => {
    expect(index.includes('./adapters')).toBe(false);
    expect(index.includes('./testing')).toBe(false);
  });

  it('index.ts 不出现 Db/DbTx/drizzle 符号(签名零基础设施类型)', () => {
    expect(index.includes('DbTx')).toBe(false);
    expect(index.includes('drizzle')).toBe(false);
    expect(/\bDb\b/.test(index)).toBe(false);
  });

  it('index.ts 不导出 composition 符号(子入口独立,总纲 §5.3)', () => {
    expect(index.includes('identityWithinTx')).toBe(false);
  });

  it('存储 port 契约(DbLike 形态)不走根出口,只在 ./composition(§5.3 收紧)', () => {
    for (const storePort of [
      'CredentialStore',
      'ChallengeStore',
      'MfaStore',
      'OAuthStore',
      'AnchorStore',
    ]) {
      expect(index.includes(storePort), `index.ts 不应导出 ${storePort}`).toBe(false);
    }
    const composition = stripComments(readFileSync(`${srcDir}/composition.ts`, 'utf-8'));
    for (const storePort of [
      'CredentialStore',
      'ChallengeStore',
      'MfaStore',
      'OAuthStore',
      'AnchorStore',
    ]) {
      expect(composition.includes(storePort), `composition.ts 应导出 ${storePort}`).toBe(true);
    }
  });

  it('AUDIT_ACTIONS 审计词表封闭快照(DESIGN §2.6;新增动作先改清单)', async () => {
    const { AUDIT_ACTIONS } = await import('../src/domain/audit-events.js');
    expect([...AUDIT_ACTIONS].toSorted()).toEqual(
      [
        'credential.register',
        'credential.replay',
        'credential.authenticate',
        'password.change',
        'password.reset',
        'challenge.begin',
        'challenge.verify',
        'challenge.abort',
        'mfa.enroll',
        'mfa.confirm',
        'mfa.disable',
        'oauth.link',
        'oauth.unlink',
        'session.revoke',
      ].toSorted(),
    );
  });

  it('根装配面文件集合封闭(identity/composition/index)', () => {
    const roots = files.filter((f) => f.layer === 'root');
    expect(roots.map((f) => f.path).toSorted()).toEqual([
      'composition.ts',
      'identity.ts',
      'index.ts',
    ]);
  });
});
