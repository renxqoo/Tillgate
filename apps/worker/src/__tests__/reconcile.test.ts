/**
 * 周期对账哨兵集成套件（真 PG）——对账是「即使一切机制都有 bug，
 * 最后发现资损的哨兵」，须有测试钉住行为：
 *   净账本零告警 / 人为破坏不变量被捕获 + 告警入箱 / 小时 dedupe 幂等 /
 *   advisory lock 独占（他副本持锁时跳过不误报不漏报）。
 *
 * 破坏向量：直插 wallet_authorizations（active）造 in_flight 漂移——
 * 账户余额列有触发器保护不可直改，授权表无（生产 bug 的真实形态即投影脱节）。
 * 清理纪律：账本（legs/transactions/accounts）绝不删除——不可变设计，
 * 半删腿即制造真实漂移（对账必须能捕获）；
 * 测试残迹为平账历史（gift credit + 已解除授权），users/outbox 行照常清理。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { createWallet, systemContext } from '@ai-gateway/service';
import { runReconcileOnce } from '../tasks/reconcile.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const ctx = systemContext('v2rec-suite');
const wallet = createWallet({
  db,
  guards: { refTypes: ['gift'], currencies: ['CNY'], internalAccounts: ['outside', 'platform_revenue'] },
  currency: 'CNY',
});

const errors: Array<[string, unknown]> = [];
const logger = {
  error: (obj: unknown, msg: string) => errors.push([msg, obj]),
  warn: (obj: unknown, msg: string) => errors.push([msg, obj]),
};

const createdUsers: number[] = [];
const createdAuthIds: string[] = [];

async function newUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ issuer: 'v2rec', subject: `v2rec-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(row!.id);
  return row!.id;
}

async function userAccountId(userId: number): Promise<string> {
  const r = await db.$client.query<{ id: string }>(
    "select id from wallet_accounts where user_id = $1 and kind = 'user' order by id limit 1",
    [userId],
  );
  if (!r.rows[0]) throw new Error(`no wallet account for user ${userId}`);
  return r.rows[0].id;
}

async function outboxCount(): Promise<number> {
  const r = await db.$client.query<{ n: string }>(
    "select count(*)::text as n from notify_outbox where event = 'reconcile_discrepancy'",
  );
  return Number(r.rows[0]!.n);
}

/** 直插 active 授权造 in_flight 漂移（账户快照列 0 ≠ Σactive）——模拟投影脱节类生产 bug。
 *  授权表有 coherence 触发器（正是防线）：测试管道内临时停用注入，验证的是哨兵能发现。 */
async function breakInFlight(userId: number, amount: string): Promise<void> {
  const accountId = await userAccountId(userId);
  const client = await db.$client.connect();
  try {
    await client.query('begin');
    await client.query('alter table wallet_authorizations disable trigger wallet_authorizations_account_coherence_ck');
    const r = await client.query<{ id: string }>(
      `insert into wallet_authorizations (account_id, ref_type, ref_id, amount, status, expires_at)
       values ($1, 'billing', $2, $3, 'active', now() + interval '1 hour') returning id::text`,
      [accountId, `v2rec-brk-${randomUUID()}`, amount],
    );
    await client.query('alter table wallet_authorizations enable trigger wallet_authorizations_account_coherence_ck');
    await client.query('commit');
    createdAuthIds.push(r.rows[0]!.id);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

afterAll(async () => {
  if (createdAuthIds.length) {
    await db.$client.query('delete from wallet_authorizations where id::text = any($1)', [createdAuthIds]);
  }
  if (createdUsers.length) {
    await db.$client.query('delete from users where id = any($1)', [createdUsers]);
  }
  await db.$client.query("delete from notify_outbox where event = 'reconcile_discrepancy'");
  await db.$client.end();
});

describe('周期对账哨兵', () => {
  it('净账本：零违规、零告警、零错误日志', async () => {
    const before = await outboxCount();
    const r = await runReconcileOnce(db, logger);
    expect(r.discrepancies).toBe(0);
    expect(await outboxCount()).toBe(before);
    expect(errors).toHaveLength(0);
  });

  it('人为破坏 in_flight 快照 → 违规被捕获 + reconcile_discrepancy 告警入箱', async () => {
    const uid = await newUser();
    await wallet.credit(ctx, {
      userId: uid,
      amount: '3',
      refType: 'gift',
      refId: `v2rec-${randomUUID()}`,
      currency: 'CNY',
    });
    // 造平后的基线必须干净（防上一破坏残留串扰）
    expect((await runReconcileOnce(db, logger)).discrepancies).toBe(0);

    await breakInFlight(uid, '2.5');
    const before = await outboxCount();
    const r = await runReconcileOnce(db, logger);
    expect(r.discrepancies).toBeGreaterThanOrEqual(1);
    expect(await outboxCount()).toBe(before + 1);
    expect(errors.some(([msg]) => msg === 'reconciliation discrepancies')).toBe(true);

    // 小时 dedupe：同小时重跑不再入箱（dedupeKey 唯一冲突忽略）
    await runReconcileOnce(db, logger);
    expect(await outboxCount()).toBe(before + 1);

    // 解除伪造授权后回落干净
    await db.$client.query('delete from wallet_authorizations where id::text = any($1)', [[createdAuthIds.pop()!]]);
    errors.length = 0;
    expect((await runReconcileOnce(db, logger)).discrepancies).toBe(0);
  });

  it('advisory lock 独占：他副本持锁 → 跳过执行、不误报不漏报', async () => {
    // 告警按小时 dedupe：清箱隔离，使「释放后入箱」断言不受上一用例同小时行干扰
    await db.$client.query("delete from notify_outbox where event = 'reconcile_discrepancy'");
    const uid = await newUser();
    await wallet.credit(ctx, {
      userId: uid,
      amount: '2',
      refType: 'gift',
      refId: `v2rec-${randomUUID()}`,
      currency: 'CNY',
    });
    await breakInFlight(uid, '0.7');
    const before = await outboxCount();

    const client = await db.$client.connect();
    try {
      await client.query("select pg_advisory_lock(hashtext('ai-gateway:billing-reconcile'))");
      // 持锁期间：漂移存在但本轮跳过（返回 0 且不入箱——告警责任在持锁副本）
      const r = await runReconcileOnce(db, logger);
      expect(r.discrepancies).toBe(0);
      expect(await outboxCount()).toBe(before);
      await client.query("select pg_advisory_unlock(hashtext('ai-gateway:billing-reconcile'))");
    } finally {
      client.release();
    }
    // 释放后本副本接手：漂移被发现
    const r2 = await runReconcileOnce(db, logger);
    expect(r2.discrepancies).toBeGreaterThanOrEqual(1);
    expect(await outboxCount()).toBe(before + 1);

    await db.$client.query('delete from wallet_authorizations where id::text = any($1)', [[createdAuthIds.pop()!]]);
    errors.length = 0;
    expect((await runReconcileOnce(db, logger)).discrepancies).toBe(0);
  });
});
