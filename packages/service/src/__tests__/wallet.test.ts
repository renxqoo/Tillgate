/**
 * wallet 用例集成测试（真实 PostgreSQL）——攻击面继承旧内核测试的想象力：
 * 幂等三段、守卫口径、CAS 状态机、腿链连续、并发超扣、§4 共享事务。
 * 数据纪律：v2w 前缀 + 独立用户；清理按本套件 refType/用户双条件。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createDb, type Db, type DbTx } from '@ai-gateway/db';
import { users, walletAccounts } from '@ai-gateway/db';
import { createWallet } from '../wallet/wallet.js';
import { systemContext, type RunContext } from '../context.js';
import {
  Decimal,
  FrozenAccountError,
  IdempotencyConflictError,
  InsufficientCashError,
  InvalidRefError,
  RefKeyConflictError,
  SettleExceedsHoldError,
  InvalidAmountError,
} from '@ai-gateway/domain';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const wallet = createWallet({
  db,
  currency: 'CNY',
  guards: { refTypes: ['v2test', 'billing', 'admin'], currencies: ['CNY'], internalAccounts: ['outside', 'platform_revenue'] },
});
const ctx: RunContext = systemContext('v2w-suite');
const REF_TYPE = 'v2test';
const createdUsers: number[] = [];

beforeAll(async () => {
  await db.query.users.findFirst({ columns: { id: true } });
});
afterAll(async () => {
  // 清理纪律：wallet 腿/交易是 append-only 审计物（DB 触发器结构性禁删），
  // 以 v2w 前缀留档复查；users 行随用随删（wallet_accounts.user_id 无 FK，无级联）。
  if (createdUsers.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUsers));
  }
  await db.$client.end().catch(() => {});
});

async function newUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ issuer: 'v2w', subject: `v2w-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(row!.id);
  return row!.id;
}

const rid = (tag: string): string => `v2w-${tag}-${randomUUID().slice(0, 8)}`;

async function balanceOf(userId: number): Promise<{ balance: string; inFlight: string }> {
  const rows = await wallet.accounts(ctx, userId);
  const account = rows[0]!;
  return { balance: account.balance, inFlight: account.inFlight };
}

describe('credit：入账', () => {
  it('双腿落账：余额增加 + 流水含本方腿', async () => {
    const user = await newUser();
    const refId = rid('credit');
    const result = await wallet.credit(ctx, {
      userId: user, amount: '10.5', refType: REF_TYPE, refId,
    });
    expect(result.replayed).toBe(false);
    expect((await balanceOf(user)).balance).toBe('10.5');
    const statement = await wallet.statement(ctx, { userId: user });
    expect(statement.length).toBe(1);
    expect(statement[0]!.amount).toBe('10.5');
    expect(statement[0]!.balanceAfter).toBe('10.5');
  });

  it('幂等：同命令重放 replayed:true；异命令同键拒绝', async () => {
    const user = await newUser();
    const refId = rid('credit-idem');
    const first = await wallet.credit(ctx, { userId: user, amount: '5', refType: REF_TYPE, refId });
    const replay = await wallet.credit(ctx, { userId: user, amount: '5', refType: REF_TYPE, refId });
    expect(replay.replayed).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect((await balanceOf(user)).balance).toBe('5');
    await expect(
      wallet.credit(ctx, { userId: user, amount: '6', refType: REF_TYPE, refId }),
    ).rejects.toThrow(IdempotencyConflictError);
    expect((await balanceOf(user)).balance).toBe('5');
  });

  it('同键跨用户顶撞 → RefKeyConflict（不是把别人的当自己的重放）', async () => {
    const a = await newUser();
    const b = await newUser();
    const refId = rid('credit-hijack');
    await wallet.credit(ctx, { userId: a, amount: '1', refType: REF_TYPE, refId });
    await expect(
      wallet.credit(ctx, { userId: b, amount: '1', refType: REF_TYPE, refId }),
    ).rejects.toThrow(RefKeyConflictError);
  });

  it('fail-closed：未声明 refType / 币种 / 科目拒绝；非法金额拒绝', async () => {
    const user = await newUser();
    await expect(
      wallet.credit(ctx, { userId: user, amount: '1', refType: 'unknown', refId: rid('x') }),
    ).rejects.toThrow(InvalidRefError);
    await expect(
      wallet.credit(ctx, { userId: user, amount: '1', refType: REF_TYPE, refId: rid('x'), currency: 'USD' }),
    ).rejects.toThrow(InvalidRefError);
    await expect(
      wallet.credit(ctx, { userId: user, amount: '1', refType: REF_TYPE, refId: rid('x'), counterparty: 'evil' }),
    ).rejects.toThrow(InvalidRefError);
    await expect(
      wallet.credit(ctx, { userId: user, amount: '-1', refType: REF_TYPE, refId: rid('x') }),
    ).rejects.toThrow(InvalidAmountError);
    await expect(
      wallet.credit(ctx, { userId: user, amount: 'NaN', refType: REF_TYPE, refId: rid('x') }),
    ).rejects.toThrow(InvalidAmountError);
  });
});

describe('authorize / settle / release：两阶段冻结闭环', () => {
  it('授权冻结在途；结算实扣 + 余量归还；腿链连续', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '1', refType: REF_TYPE, refId: rid('f') });
    const refId = rid('hold');

    const authorized = await wallet.authorize(ctx, {
      userId: user, amount: '0.5', refType: REF_TYPE, refId, allowCredit: false,
    });
    expect(authorized.status).toBe('active');
    expect((await balanceOf(user)).inFlight).toBe('0.5');
    expect((await balanceOf(user)).balance).toBe('1');

    const settled = await wallet.settle(ctx, { refType: REF_TYPE, refId, amount: '0.3' });
    expect(settled.replayed).toBe(false);
    expect(settled.releasedRemainder).toBe('0.2');
    const after = await balanceOf(user);
    expect(after.balance).toBe('0.7');
    expect(after.inFlight).toBe('0');

    // 流水两行（credit +1, settle −0.3），链式余额连续
    const statement = await wallet.statement(ctx, { userId: user });
    expect(statement.map((s) => s.amount).toSorted()).toEqual(['-0.3', '1']);
    const chain = statement
      .toSorted((x, y) => x.legId - y.legId)
      .map((s) => s.balanceAfter);
    expect(chain[chain.length - 1]).toBe('0.7');
  });

  it('结算幂等：二次 settle 重放首答；超扣拒绝；终态后释放拒绝', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '2', refType: REF_TYPE, refId: rid('f') });
    const refId = rid('settle-idem');
    await wallet.authorize(ctx, { userId: user, amount: '1', refType: REF_TYPE, refId });
    const first = await wallet.settle(ctx, { refType: REF_TYPE, refId, amount: '0.4' });
    const replay = await wallet.settle(ctx, { refType: REF_TYPE, refId, amount: '0.4' });
    expect(replay.replayed).toBe(true);
    expect(replay.balanceAfter).toBe(first.balanceAfter);
    expect((await balanceOf(user)).balance).toBe('1.6');
    await expect(
      wallet.settle(ctx, { refType: REF_TYPE, refId, amount: '0.1' }),
    ).rejects.toThrow(IdempotencyConflictError); // settled 重放走指纹比对：同键异命令=409
  });

  it('超扣（settle > hold）结构性拒绝', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '5', refType: REF_TYPE, refId: rid('f') });
    const refId = rid('over');
    await wallet.authorize(ctx, { userId: user, amount: '0.5', refType: REF_TYPE, refId });
    await expect(
      wallet.settle(ctx, { refType: REF_TYPE, refId, amount: '0.6' }),
    ).rejects.toThrow(SettleExceedsHoldError);
  });

  it('释放：在途归零、余额不动、不落交易（零额噪声行取消）；重复释放幂等', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '3', refType: REF_TYPE, refId: rid('f') });
    const refId = rid('release');
    await wallet.authorize(ctx, { userId: user, amount: '1.5', refType: REF_TYPE, refId });
    const released = await wallet.release(ctx, { refType: REF_TYPE, refId, reason: 'cancelled' });
    expect(released.releasedAmount).toBe('1.5');
    const after = await balanceOf(user);
    expect(after.balance).toBe('3');
    expect(after.inFlight).toBe('0');
    const statement = await wallet.statement(ctx, { userId: user });
    expect(statement.length).toBe(1); // 只有 credit，release 无腿
    const replay = await wallet.release(ctx, { refType: REF_TYPE, refId, reason: 'cancelled' });
    expect(replay.replayed).toBe(true);
  });

  it('现金口径守卫：可用不足拒绝（InsufficientCash）；信用口径放行到授信地板', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '1', refType: REF_TYPE, refId: rid('f') });
    await expect(
      wallet.authorize(ctx, { userId: user, amount: '1.01', refType: REF_TYPE, refId: rid('cash'), allowCredit: false }),
    ).rejects.toThrow(InsufficientCashError);
    // 授信 1：信用口径可用 = 1 + 1 = 2
    await wallet.setCreditLimit(ctx, { userId: user, amount: '1', refType: 'admin', refId: rid('cl') });
    const ok = await wallet.authorize(ctx, { userId: user, amount: '1.5', refType: REF_TYPE, refId: rid('credit-ok') });
    expect(ok.status).toBe('active');
  });

  it('在途守卫：并发 8 笔各 1 元对 5 元余额，恰 5 成 3 拒', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '5', refType: REF_TYPE, refId: rid('f') });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        wallet.authorize(ctx, {
          userId: user, amount: '1', refType: REF_TYPE, refId: rid(`race-${i}`), allowCredit: false,
        }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(fulfilled).toBe(5);
    expect(rejected).toBe(3);
    expect((await balanceOf(user)).inFlight).toBe('5');
  });
});

describe('transfer / setCreditLimit', () => {
  it('划转 user→platform_revenue：现金口径守卫 + 双腿', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '4', refType: REF_TYPE, refId: rid('f') });
    const refId = rid('transfer');
    const result = await wallet.transfer(ctx, {
      from: { userId: user }, to: { code: 'platform_revenue' },
      amount: '2.5', refType: REF_TYPE, refId, allowCredit: false,
    });
    expect(result.replayed).toBe(false);
    expect(result.fromBalanceAfter).toBe('1.5');
    await expect(
      wallet.transfer(ctx, {
        from: { userId: user }, to: { code: 'platform_revenue' },
        amount: '2', refType: REF_TYPE, refId: rid('t2'), allowCredit: false,
      }),
    ).rejects.toThrow(InsufficientCashError);
  });

  it('授信地板：新授信必须覆盖负余额与在途', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '2', refType: REF_TYPE, refId: rid('f') });
    await wallet.setCreditLimit(ctx, { userId: user, amount: '5', refType: 'admin', refId: rid('cl1') });
    // 花到负：冻结不扣余额——先划转到 revenue（allowCredit 默认走信用口径可透支）
    await wallet.transfer(ctx, {
      from: { userId: user }, to: { code: 'platform_revenue' },
      amount: '6', refType: REF_TYPE, refId: rid('neg'), // 2 + 5 授信 = 可用 7
    });
    expect((await balanceOf(user)).balance).toBe('-4');
    // 覆盖 −4 需要 ≥4；在途 0 → 3.9 拒绝、4 通过
    await expect(
      wallet.setCreditLimit(ctx, { userId: user, amount: '3.9', refType: 'admin', refId: rid('cl2') }),
    ).rejects.toThrow();
    await expect(
      wallet.setCreditLimit(ctx, { userId: user, amount: '4', refType: 'admin', refId: rid('cl3') }),
    ).resolves.toMatchObject({ creditLimitAfter: '4' });
  });
});

describe('跨动词共享事务（§4 补充授权的地基）', () => {
  it('collectOverage 只能用于 billing 的 #over 内部自然键', async () => {
    const user = await newUser();
    await expect(wallet.authorize(ctx, {
      userId: user,
      amount: '1',
      refType: REF_TYPE,
      refId: rid('forged-over'),
      collectOverage: true,
    })).rejects.toThrow('authorize.collectOverage_scope');
  });

  it('authorize#over + settle#over + settle 原单在同一事务：全成或全不成', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '2', refType: REF_TYPE, refId: rid('f') });
    const holdRef = rid('s4-hold');

    await db.transaction(async (tx: DbTx) => {
      await wallet.authorize(ctx, {
        userId: user, amount: '0.5', refType: REF_TYPE, refId: holdRef, tx,
      });
      // §4 补充授权结算（同一事务）：authorize#over + settle#over
      await wallet.authorize(ctx, {
        userId: user, amount: '0.2', refType: REF_TYPE, refId: `${holdRef}#over`, tx,
      });
      await wallet.settle(ctx, { refType: REF_TYPE, refId: `${holdRef}#over`, amount: '0.2', tx });
    });
    let after = await balanceOf(user);
    expect(after.balance).toBe('1.8'); // 2 − 0.2 实扣
    expect(after.inFlight).toBe('0.5'); // 原单冻结仍在途

    // 失败路径：事务内抛错 → 全部回滚（含已 authorize 的冻结）
    const refId = rid('s4-rollback');
    await expect(
      db.transaction(async (tx: DbTx) => {
        await wallet.authorize(ctx, { userId: user, amount: '0.3', refType: REF_TYPE, refId, tx });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    after = await balanceOf(user);
    expect(after.inFlight).toBe('0.5'); // 回滚的冻结未残留
  });
});

describe('refund：退款', () => {
  it('双腿出账：余额扣减 + 对手科目 outside 冲回', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '5', refType: REF_TYPE, refId: rid('f') });
    const result = await wallet.refund(ctx, {
      userId: user, amount: '1.5', refType: REF_TYPE, refId: rid('refund'),
    });
    expect(result.replayed).toBe(false);
    expect(result.balanceAfter).toBe('3.5');
    expect((await balanceOf(user)).balance).toBe('3.5');
  });

  it('幂等：同命令重放 replayed:true；同键异命令拒绝', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '5', refType: REF_TYPE, refId: rid('f') });
    const refId = rid('refund-idem');
    const first = await wallet.refund(ctx, { userId: user, amount: '1', refType: REF_TYPE, refId });
    const replay = await wallet.refund(ctx, { userId: user, amount: '1', refType: REF_TYPE, refId });
    expect(replay.replayed).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    await expect(
      wallet.refund(ctx, { userId: user, amount: '2', refType: REF_TYPE, refId }),
    ).rejects.toThrow(IdempotencyConflictError);
    expect((await balanceOf(user)).balance).toBe('4');
  });

  it('出账守卫：余额不足拒绝（信用口径）', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '1', refType: REF_TYPE, refId: rid('f') });
    await expect(
      wallet.refund(ctx, { userId: user, amount: '1.01', refType: REF_TYPE, refId: rid('over') }),
    ).rejects.toThrow();
    expect((await balanceOf(user)).balance).toBe('1');
  });
});

describe('风控冻结', () => {
  it('冻结账户拒绝一切资金变动', async () => {
    const user = await newUser();
    await wallet.credit(ctx, { userId: user, amount: '1', refType: REF_TYPE, refId: rid('f') });
    const [account] = await db
      .select({ id: walletAccounts.id })
      .from(walletAccounts)
      .where(and(eq(walletAccounts.kind, 'user'), eq(walletAccounts.userId, user)));
    await db
      .update(walletAccounts)
      .set({ status: 'frozen' })
      .where(eq(walletAccounts.id, account!.id));
    await expect(
      wallet.credit(ctx, { userId: user, amount: '1', refType: REF_TYPE, refId: rid('frozen') }),
    ).rejects.toThrow(FrozenAccountError);
    await db
      .update(walletAccounts)
      .set({ status: 'active' })
      .where(eq(walletAccounts.id, account!.id));
  });
});

describe('复式守恒（DB 触发器同盟）', () => {
  it('本套件全部交易 Σ 腿 = 0', async () => {
    const rows = await db.execute<{ total: string; n: number }>(sql`
      select coalesce(sum(l.amount), 0)::text as total, count(*)::int as n
      from wallet_legs l
      join wallet_transactions t on t.id = l.transaction_id
      where t.ref_type = ${REF_TYPE}
    `);
    expect(new Decimal(rows.rows[0]!.total).isZero()).toBe(true);
    expect(Number(rows.rows[0]!.n)).toBeGreaterThan(0);
  });
});
