/**
 * 迁移回放容忍判定（replayTolerates）契约锁：
 * 白名单文件 + 42P01 + 服务端消息确为 relation 缺失，三重全过才容忍。
 * 回归锚点：Bun SQL 曾把 42P10（invalid reference——UPDATE...FROM 引用目标表）
 * 错映为 42P01，旧实现（只看错误码）静默放行该非法语句直通 e2e 世界——
 * 本用例在旧实现上必败。
 */
import { describe, expect, it } from 'vitest';
import { replayTolerates } from './kit';

/** 仿真实错误链：drizzle 包装层（Failed query…）→ Bun SQL PostgresError（真话在 cause） */
function pgError(sqlState: string, serverMessage: string): Error {
  const server = Object.assign(new Error(serverMessage), { errno: sqlState });
  return new Error('Failed query: UPDATE "generation_tasks" gt SET …', { cause: server });
}

describe('回放容忍三重判定（白名单 + 42P01 + relation 缺失消息）', () => {
  it('白名单文件 + 真 42P01（relation does not exist）→ 容忍', () => {
    expect(
      replayTolerates(
        pgError('42P01', 'relation "identity_session_anchors" does not exist'),
        '0055_session_anchors_backfill.sql',
      ),
    ).toBe(true);
  });

  it('白名单文件 + 错码 42P01 但消息是 invalid reference（Bun 映射错码现场）→ 响亮拒绝', () => {
    expect(
      replayTolerates(
        pgError('42P01', 'invalid reference to FROM-clause entry for table "gt"'),
        '0055_session_anchors_backfill.sql',
      ),
    ).toBe(false);
  });

  it('非白名单文件（新迁移）即使真缺关系 → 响亮拒绝（新迁移缺表是链缺陷，必须炸）', () => {
    expect(
      replayTolerates(
        pgError('42P01', 'relation "anything" does not exist'),
        '0106_model_channels_upstream_model.sql',
      ),
    ).toBe(false);
  });

  it('白名单文件 + 非 42P01 错码（如 42703）→ 响亮拒绝', () => {
    expect(
      replayTolerates(
        pgError('42703', 'column "nope" does not exist'),
        '0057_payment_orders_fk_ledger_operations.sql',
      ),
    ).toBe(false);
  });

  it('无 cause 链的裸错误 → 响亮拒绝（不因形状未知而误容）', () => {
    expect(
      replayTolerates(
        new Error('relation "x" does not exist'),
        '0055_session_anchors_backfill.sql',
      ),
    ).toBe(false);
  });
});
