/**
 * schema 面结构断言(IMPLEMENTATION.md §4):表清单封闭、词表收敛(B4)、
 * payments 解除 ledger-core 反向依赖(B1)、词表谓词行为。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { is, Relations, type Table } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../src/schema/index.js';
import * as rootExports from '../../src/index.js';

/** v1 全量物理表清单(39 张)——新增/删除表必须先改本清单 */
const EXPECTED_TABLES = new Set([
  'users', 'admins', 'apps', 'api_keys', 'providers', 'channels', 'channel_recharges',
  'model_mappings', 'model_channels', 'rate_cards', 'rate_card_coefficients',
  'usage_logs', 'transactions', 'billing_requests', 'billing_reservations',
  'redeem_batches', 'redeem_codes', 'request_logs', 'audit_logs',
  'plans', 'user_subscriptions', 'organizations', 'org_members', 'org_invitations',
  'reconcile_discrepancies', 'trace_spans', 'payment_orders', 'referrals',
  'marketing_settings', 'notification_channels', 'notify_outbox', 'generation_tasks',
  'wallet_accounts', 'wallet_transactions', 'wallet_legs', 'wallet_authorizations',
  'ledger_operations', 'fx_rates', 'system_configs',
]);

function tableNames(namespace: object): Set<string> {
  return new Set(
    Object.values(namespace)
      .filter((v): v is Table => is(v, PgTable))
      .map((t) => getTableConfig(t as PgTable).name),
  );
}

describe('schema 表清单', () => {
  it('物理表集合与 v1 基线一致(39 张,封闭词表)', () => {
    expect(tableNames(schema)).toEqual(EXPECTED_TABLES);
  });

  it('根出口与 ./schema 子入口导出同一集合', () => {
    expect(tableNames(rootExports)).toEqual(EXPECTED_TABLES);
  });

  it('relations 导出 19 组', () => {
    const relationCount = Object.values(schema).filter((v) => is(v, Relations)).length;
    expect(relationCount).toBe(19);
  });
});

describe('词表收敛(B4:三套 → ACCOUNT_STATUS 一套)', () => {
  it('USER_STATUS / ADMIN_STATUS 已删除', () => {
    expect('USER_STATUS' in schema).toBe(false);
    expect('ADMIN_STATUS' in schema).toBe(false);
  });

  it('ACCOUNT_STATUS 保留且值域与 CHECK 约束一致(0/1/2)', () => {
    expect(schema.ACCOUNT_STATUS).toEqual({ ACTIVE: 0, BANNED: 1, DELETED: 2 });
  });

  it('isAccountUsable 仅 ACTIVE 为真', () => {
    expect(schema.isAccountUsable(schema.ACCOUNT_STATUS.ACTIVE)).toBe(true);
    expect(schema.isAccountUsable(schema.ACCOUNT_STATUS.BANNED)).toBe(false);
    expect(schema.isAccountUsable(schema.ACCOUNT_STATUS.DELETED)).toBe(false);
  });

  it('users/admins 的 status 列默认值 = ACCOUNT_STATUS.ACTIVE(0)', () => {
    for (const table of [schema.users, schema.admins]) {
      const statusColumn = getTableConfig(table).columns.find((c) => c.name === 'status');
      expect(statusColumn?.default).toBe(schema.ACCOUNT_STATUS.ACTIVE);
    }
  });
});

describe('依赖边界(IMPLEMENTATION.md §6:零内部依赖)', () => {
  const srcDir = fileURLToPath(new URL('../../src', import.meta.url));

  it('全部源文件 import 行无跨包依赖(payments FK 引本地,B1;白名单 db→无内部包)', () => {
    const importLines = readdirSync(srcDir, { recursive: true })
      .filter((f) => String(f).endsWith('.ts'))
      .flatMap((f) => readFileSync(`${srcDir}/${String(f)}`, 'utf8').match(/^import .*/gm) ?? []);
    const offenders = importLines.filter(
      (line) => line.includes('@ai-gateway/') || line.includes('@tokenlens/'),
    );
    expect(offenders).toEqual([]);
  });

  it('ledger_operations 本地表定义在包内(FK 目标)', () => {
    expect(tableNames({ ledgerOperations: schema.ledgerOperations })).toContain('ledger_operations');
  });
});
