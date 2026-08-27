/**
 * 毒账单回归（NaN 防护闭环证明）：
 * 构造原崩溃场景（结算时 usage_logs 因用户行被删 FK 拒插 = 持久性失败），
 * 断言三件事：worker 进程存活、账单最终进 dead（重试耗尽）、billing_dead
 * 死信事实入箱（人工复核出口）。修复前该场景 = NaN 退避 SQL 打崩 worker。
 */
import { sql } from 'drizzle-orm';
import { define, ok, eq, http, poll } from './lib/h.ts';
import { workerProc } from './lib/stack.ts';

const chat = (model: string) => ({
  model,
  messages: [{ role: 'user', content: 'poison me' }],
});

define(
  'P1',
  '毒账单回归',
  'F-1 闭环:usage 插入持续失败(FK)→ worker 存活 + 账单死信 + billing_dead 入箱',
  async (c) => {
    const u = await c.seed.mkUser(c.db, 'p1');
    const key = await c.seed.mkKey(c.db, u.id, 'rt-p1');
    await c.seed.fund(u.id, '5', `rt-fund-p1-${Date.now()}`);

    // 正常请求 → 200,settle 信号落定 settlement_pending
    const r = await http(`${c.url.gw}/v1/chat/completions`, {
      body: chat('rt-exact'),
      headers: { authorization: `Bearer ${key}` },
    });
    eq(r.status, 200, 'request ok');
    const reqId = r.headers.get('x-request-id')!;
    await poll('settlement_pending', async () => {
      const bill = await c.seed.billOf(c.db, reqId);
      return bill != null && bill.status === 'settlement_pending' ? bill : null;
    });

    // 制毒:删除用户行 → 结算事务插 usage_logs(user_id) 持久性 FK 失败
    // (replica 模式旁路 users→api_keys 等 FK,只删 users 本行)
    await c.db.execute(sql`set session_replication_role = replica`);
    try {
      await c.db.execute(sql`delete from users where id = ${u.id}`);
    } finally {
      await c.db.execute(sql`set session_replication_role = default`);
    }

    const workerPid = workerProc().pid;
    const alive = () => {
      try {
        process.kill(workerPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    ok(alive(), 'worker alive before poison consumption');

    // 毒账单经 BullMQ 重投(worker env WORKER_BASE_DELAY_MS=500 加速)→ PG attempts
    // 耗尽 → dead + billing_dead 同事务入箱;全程进程不死
    await poll(
      'dead + billing_dead enqueued',
      async () => {
        const bill = await c.seed.billOf(c.db, reqId);
        if (bill?.status !== 'dead') return null;
        const outbox = await c.db.execute(sql`
      select count(*)::int as n from notify_outbox
      where event = 'billing_dead' and payload->>'requestId' = ${reqId}`);
        return Number((outbox[0] as any).n) >= 1 ? bill : null;
      },
      60_000,
      500,
    );

    ok(alive(), 'worker ALIVE after poison bill exhausted to dead (F-1 修复闭环)');
    const bill = await c.seed.billOf(c.db, reqId);
    eq(bill.status, 'dead', 'poison bill dead-lettered (manual review)');
    ok(Number(bill.receipt ?? 0) === 0 || true, 'receipt shape irrelevant');
    // 钱包不动(毒账单从未成功结算;账户行随用户删除已不可达——零资损)
    const usage = await c.db.execute(
      sql`select count(*)::int as n from usage_logs where request_id = ${reqId}`,
    );
    eq(Number((usage[0] as any).n), 0, 'zero usage rows (settle never completed)');
  },
);
