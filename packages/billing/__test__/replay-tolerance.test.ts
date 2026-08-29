/**
 * 迁移回放容忍判定（real-pg replayTolerates）契约锁：与 e2e/gateway/kit-replay.test.ts
 * 同源语义——白名单 + 42P01 + relation 缺失消息三重全过才容忍。
 * 回归锚点：Bun SQL 曾把 42P10（invalid reference）错映为 42P01 被旧实现静默放行。
 */
import { describe, expect, it } from 'vitest';
import { replayTolerates } from './real-pg.js';

function pgError(sqlState: string, serverMessage: string): Error {
  const server = Object.assign(new Error(serverMessage), { code: sqlState });
  return new Error('Failed query: ALTER TABLE …', { cause: server });
}

describe('real-pg 回放容忍三重判定', () => {
  it('白名单 + 真 42P01 → 容忍', () => {
    expect(
      replayTolerates(
        pgError('42P01', 'relation "ledger_operations" does not exist'),
        '0057_payment_orders_fk_ledger_operations.sql',
      ),
    ).toBe(true);
  });

  it('错码 42P01 但消息非 relation 缺失（Bun 映射错码现场）→ 拒绝', () => {
    expect(
      replayTolerates(
        pgError('42P01', 'invalid reference to FROM-clause entry for table "gt"'),
        '0056_ledger_operations_backfill.sql',
      ),
    ).toBe(false);
  });

  it('非白名单文件 → 拒绝', () => {
    expect(
      replayTolerates(
        pgError('42P01', 'relation "x" does not exist'),
        '0100_funds_center_module.sql',
      ),
    ).toBe(false);
  });

  it('白名单 + 非 42P01 → 拒绝', () => {
    expect(
      replayTolerates(
        pgError('28P01', 'password authentication failed'),
        '0055_session_anchors_backfill.sql',
      ),
    ).toBe(false);
  });
});
