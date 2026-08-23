import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * app 级架构门禁(§5.5/总纲 P5,机器验证不靠记忆):
 *   1. `./composition` 子入口只允许出现在 src/assembly.ts(§5.3 白名单:apps assembly);
 *   2. `@tokenlens/db` 的 Db/DbTx 类型与 createDb/ping 等装配件不出现在非装配代码;
 *      进程装配面(assembly.ts/index.ts/shutdown.ts/adapters/*)除外——P5「app 非
 *      assembly 代码不得引用任何 ./composition、repository、adapter 或 Db/DbTx 类型」
 *      (app.ts 的 pgSqlState 纯分类函数是文档化例外;config.ts 零 db 形态)。
 *   3. app 依赖面只走显式包名(禁 @tokenlens 各包 src 深导入,§5 硬约束)。
 *   4. src/adapters/* 桥接件只允许 assembly.ts 引用(装配面,gateway DESIGN 同口径)。
 */

const SRC = join(import.meta.dirname, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isDirectory()) return walk(join(dir, entry.name)).map((p) => `${entry.name}/${p}`);
      return entry.name.endsWith('.ts') ? [entry.name] : [];
    })
    .toSorted();
}

const FILES = walk(SRC);
const source = new Map<string, string>(
  FILES.map((name) => [name, readFileSync(join(SRC, name), 'utf8')]),
);
/** 进程装配面:依赖装配/桥接/生命周期收口(P5 白名单语义;adapters/* 计入装配面) */
const ASSEMBLY_FACE = new Set([
  'assembly.ts',
  'index.ts',
  'shutdown.ts',
  'config.ts',
  'adapters/upstream-probe.ts',
  'adapters/funding-resolver.ts',
  'adapters/accounts-bridges.ts',
  // P2 登录波桥接件(identity 审计桥/SMTP 管理员邮件/jti 吊销表——共享文件代为同步白名单)
  'adapters/identity-audit-bridge.ts',
  'adapters/redis-session-revocation.ts',
  'adapters/smtp-admin-mailer.ts',
]);

describe('admin-api 架构门禁', () => {
  it('src 文件集合快照(目标树 §3:五件套 + http 四层 + 装配面桥接件)', () => {
    expect(FILES).toEqual([
      'adapters/accounts-bridges.ts',
      'adapters/funding-resolver.ts',
      'adapters/identity-audit-bridge.ts',
      'adapters/redis-session-revocation.ts',
      'adapters/smtp-admin-mailer.ts',
      'adapters/upstream-probe.ts',
      'app.ts',
      'assembly.ts',
      'config.ts',
      'http/contracts/auth.ts',
      'http/contracts/billing-admin.ts',
      'http/contracts/catalog.ts',
      'http/contracts/common.ts',
      'http/contracts/control-plane.ts',
      'http/contracts/inference.ts',
      'http/contracts/marketing.ts',
      'http/contracts/models.ts',
      'http/contracts/notifications.ts',
      'http/contracts/observability.ts',
      'http/contracts/rates.ts',
      'http/contracts/settings.ts',
      'http/contracts/subscriptions.ts',
      'http/contracts/users.ts',
      'http/error-face.ts',
      'http/middleware/protocol.ts',
      'http/middleware/session.ts',
      'http/openapi/auth.ts',
      'http/openapi/billing-admin.ts',
      'http/openapi/catalog.ts',
      'http/openapi/control-plane.ts',
      'http/openapi/index.ts',
      'http/openapi/inference.ts',
      'http/openapi/marketing.ts',
      'http/openapi/models.ts',
      'http/openapi/notifications.ts',
      'http/openapi/observability.ts',
      'http/openapi/rates.ts',
      'http/openapi/settings.ts',
      'http/openapi/shared.ts',
      'http/openapi/users.ts',
      'http/presenters/billing.ts',
      'http/presenters/control-plane.ts',
      'http/presenters/keys.ts',
      'http/presenters/models.ts',
      'http/presenters/observability.ts',
      'http/presenters/ops.ts',
      'http/presenters/rates.ts',
      'http/presenters/users.ts',
      'http/routes/auth.ts',
      'http/routes/billing-operations.ts',
      'http/routes/catalog.ts',
      'http/routes/channel-funds.ts',
      'http/routes/channels.ts',
      'http/routes/fx.ts',
      'http/routes/keys.ts',
      'http/routes/marketing.ts',
      'http/routes/me.ts',
      'http/routes/models.ts',
      'http/routes/notifications.ts',
      'http/routes/ops-logs.ts',
      'http/routes/ops-orders.ts',
      'http/routes/ops-tasks.ts',
      'http/routes/ops-usage.ts',
      'http/routes/plans.ts',
      'http/routes/providers.ts',
      'http/routes/rate-cards.ts',
      'http/routes/redeem.ts',
      'http/routes/referrals.ts',
      'http/routes/settings.ts',
      'http/routes/subscriptions.ts',
      'http/routes/tracing.ts',
      'http/routes/users-funds.ts',
      'http/routes/users.ts',
      'http/routes/vouchers.ts',
      'index.ts',
      'shutdown.ts',
    ]);
  });

  it('composition 子入口只在 assembly.ts 引用', () => {
    for (const [name, code] of source) {
      if (name === 'assembly.ts') {
        expect(code).toContain('@tokenlens/billing/composition');
        expect(code).toContain('@tokenlens/control-plane/composition');
        expect(code).toContain('@tokenlens/observability/composition');
        continue;
      }
      expect(
        code.match(/from '@tokenlens\/[a-z-]+\/composition'/g) ?? [],
        `${name} 不得引用 composition 子入口`,
      ).toHaveLength(0);
    }
  });

  it('@tokenlens/db 装配件(Db/DbTx 类型、createDb/ping/closeDb)只在进程装配面', () => {
    for (const [name, code] of source) {
      if (ASSEMBLY_FACE.has(name)) continue;
      const references = /from '@tokenlens\/db'/.test(code);
      expect(
        references && !code.includes('pgSqlState'),
        `${name} 不得引用 @tokenlens/db(纯分类函数 pgSqlState 除外)`,
      ).toBe(false);
      expect(code, `${name} 不得出现 Db/DbTx 类型`).not.toMatch(/\btype Db\b|\bDbTx\b/);
    }
  });

  it('src/adapters/* 桥接件只被 assembly.ts 引用', () => {
    for (const [name, code] of source) {
      if (name === 'assembly.ts' || name.startsWith('adapters/')) continue;
      expect(code, `${name} 不得引用装配面桥接件`).not.toContain('../adapters/');
      expect(code, `${name} 不得引用装配面桥接件`).not.toContain('../../adapters/');
    }
  });

  it('跨包 import 只走包名(禁 src 深导入)', () => {
    for (const [name, code] of source) {
      const deepImports = [...code.matchAll(/from '(@tokenlens\/[^']+)'/g)]
        .map((match) => match[1]!)
        .filter((specifier) => !specifier.endsWith('composition'));
      for (const specifier of deepImports) {
        expect(specifier, `${name} 禁深导入 ${specifier}`).not.toMatch(/\/src\//);
      }
    }
  });

  it('@tokenlens/ai 只在装配面(ADR-0007:assembly.ts + upstream-probe port 实现)', () => {
    const allowed = new Set(['assembly.ts', 'adapters/upstream-probe.ts']);
    for (const [name, code] of source) {
      if (allowed.has(name)) continue;
      expect(
        code.includes("from '@tokenlens/ai'"),
        `${name} 违反 ADR-0007(ai 只允许装配面与 port 实现 adapter)`,
      ).toBe(false);
    }
  });
});
