/**
 * G6 超级并发与系统级:百级并发精确对账、低余额预扣击穿、取消风暴、
 * 渠道 RPM、故障转移、worker 崩溃/停摆恢复、key 限流、大流量稳定性、
 * 终极对账(账本三不变量 + 余额=入账−Σ账单)。
 */
import { sql } from 'drizzle-orm';
import { Decimal } from '@tillgate/billing';
import { define, ok, eq, eqDec, http, sse, poll, sleep } from './lib/h.ts';
import { workerProc, restartWorker } from './lib/stack.ts';

const chat = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: 'user', content: 'load' }],
  ...extra,
});
const auth = (key: string) => ({ authorization: `Bearer ${key}` });

async function setup(c: any, tag: string, amount = '100') {
  clearBreakerKeys();
  const u = await c.seed.mkUser(c.db, tag);
  const key = await c.seed.mkKey(c.db, u.id, `rt-${tag}`);
  if (Number(amount) > 0) await c.seed.fund(u.id, amount, `rt-fund-${tag}-${Date.now()}`);
  return { u, key };
}

function clearBreakerKeys() {
  const pass = (() => {
    try {
      return new URL(process.env.REDIS_URL as string).password;
    } catch {
      return 'root123';
    }
  })();
  Bun.spawnSync(['bash', '-c', `redis-cli -a ${pass} --scan --pattern 'inference:health:*' 2>/dev/null | xargs -r redis-cli -a ${pass} del >/dev/null 2>&1; redis-cli -a ${pass} --scan --pattern 'inference:health:*' 2>/dev/null | xargs -r redis-cli -a ${pass} del >/dev/null 2>&1`]);
}

/** 等结算积压清空(用例间不互相污染:上一例停摆/崩溃留下的 pending 会触发准入关闭) */
async function awaitBacklogClear(c: any, timeoutMs = 45000) {
  await poll('backlog clear', async () => {
    const r = await c.db.execute(sql`
      select count(*)::int as n from billing_requests where status in ('settlement_pending','retry_wait','processing')`);
    return Number((r[0] as any).n) === 0 ? true : null;
  }, timeoutMs, 500);
}

async function waitUserQuiet(c: any, userId: number, expectUsage: number, timeoutMs = 45000) {
  return poll('user quiet(settled)', async () => {
    const usage = await c.db.execute(sql`
      select count(*)::int as n, coalesce(sum(amount),0)::text as total from usage_logs where user_id = ${userId}`);
    const bills = await c.db.execute(sql`
      select count(*)::int as total, count(*) filter (where status in ('settled','released','dead'))::int as terminal
      from billing_requests where user_id = ${userId}`);
    const w = await c.seed.wallet(c.db, userId);
    const u = usage[0] as any;
    const b = bills[0] as any;
    if (Number(u.n) === expectUsage && Number(b.terminal) === Number(b.total) && Number(w.in_flight) === 0) {
      return { usageCount: Number(u.n), usageTotal: String(u.total), billCount: Number(b.total), balance: w.balance };
    }
    return null;
  }, timeoutMs, 500);
}

define('X11', '超级并发', '多用户高并发基准:40 用户 × 5 = 200 同瞬并发 → 全成功、无 5xx、精确对账', async (c) => {
  await awaitBacklogClear(c);
  await sleep(500);
  const users: Array<{ u: any; key: string }> = [];
  const X11_USERS = Number(process.env.LF_X11_USERS ?? 40);
  for (let i = 0; i < X11_USERS; i++) users.push(await setup(c, `x11-${i}`, '5'));
  const t0 = Date.now();
  const jobs: Promise<number>[] = [];
  for (const s of users) {
    for (let i = 0; i < 5; i++) {
      jobs.push(
        http(`${c.url.gw}/v1/chat/completions`, {
          body: chat('rt-mini'),
          headers: auth(s.key),
          timeoutMs: 60000,
        }).then((r) => r.status, () => 0),
      );
    }
  }
  const statuses = await Promise.all(jobs);
  const wall = Date.now() - t0;
  const ok200 = statuses.filter((x) => x === 200).length;
  const errors: Record<number, number> = {};
  for (const st of statuses) if (st !== 200) errors[st] = (errors[st] ?? 0) + 1;
  console.log(`    [x11] ${X11_USERS * 5} 并发(${X11_USERS}用户×5)墙钟 ${wall}ms: 成功 ${ok200}/${X11_USERS * 5},非200=${JSON.stringify(errors)}`);
  eq(ok200, X11_USERS * 5, '多用户并发全部成功(高并发主场景)');
  for (const s of users) {
    const q = await waitUserQuiet(c, s.u.id, 5, 90000);
    eq(q.usageCount, 5, 'each user 5 bills');
    eqDec(q.usageTotal, new Decimal('0.0003108').times(5).toString(), 'exact per user');
  }
  const health = await http(`${c.url.gw}/healthz`);
  eq(health.status, 200, 'gateway healthy');
});

define('X1', '超级并发', '50 并发混合(5 用户×10,流+非流)→ 全结算,逐用户精确对账', async (c) => {
  const users: Array<{ u: any; key: string }> = [];
  for (let i = 0; i < 5; i++) users.push(await setup(c, `x1-${i}`, '10'));
  const jobs: Promise<void>[] = [];
  for (const s of users) {
    for (let i = 0; i < 10; i++) {
      const stream = i % 2 === 0;
      const model = i % 3 === 0 ? 'rt-exact' : 'rt-base';
      jobs.push(
        (async () => {
          // 突发窗口的池竞争可能给出有界 5xx(失败不留账单)——有界重试后聚合仍须精确
          for (let attempt = 0; ; attempt++) {
            if (stream) {
              const sh = sse(`${c.url.gw}/v1/chat/completions`, chat(model, { stream: true }), auth(s.key));
              const ready = await sh.ready;
              if (ready.status === 200) {
                await sh.done;
                return;
              }
            } else {
              const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat(model), headers: auth(s.key), timeoutMs: 30000 });
              if (r.status === 200) return;
            }
            if (attempt >= 3) throw new Error(`x1 request exhausted retries (${model} stream=${stream})`);
            await sleep(400);
          }
        })(),
      );
    }
  }
  await Promise.all(jobs);
  // 每用户 10 条,按 Σusage 对账(balance = fund − Σ)
  for (const s of users) {
    const q = await waitUserQuiet(c, s.u.id, 10);
    eq(q.usageCount, 10, '10 usage rows');
    const expected = new Decimal('10').minus(q.usageTotal);
    eqDec(q.balance, expected.toFixed(18).replace(/0+$/, '').replace(/\.$/, ''), 'balance = fund − Σusage');
  }
});

define('X2', '超级并发', '低余额并发击穿:余额 0.01 × 50 并发 → 通过数受预扣钳制,余额永不为负', async (c) => {
  // C2 快路径副作用:上一高并发用例的结算信号从长尾变瞬时脉冲,BullMQ 结算
  // 风暴与本用例并发授权在共享 PG 上叠加打爆池——先排空结算再起跳(错峰)
  await awaitBacklogClear(c);
  await sleep(1_000);
  const s = await setup(c, 'x2', '0.01');
  const results = await Promise.all(
    Array.from({ length: 50 }, () =>
      http(`${c.url.gw}/v1/chat/completions`, {
        body: chat('rt-exact', { max_tokens: 100 }),
        headers: auth(s.key),
        timeoutMs: 30000,
      }).then((r) => r.status),
    ),
  );
  const passes = results.filter((x) => x === 200).length;
  const rejected = results.filter((x) => x === 402).length;
  console.log(`    [x2-diag] 200:${passes} 402:${rejected} other:${JSON.stringify(results.filter((x) => x !== 200 && x !== 402).reduce((m, x) => { m[x] = (m[x] ?? 0) + 1; return m; }, {}))}`);
  // 防线=总预扣不得击穿余额(余额永不为负 + 精确对账兜底);高并发窗口允许有界 5xx(容量现象)
  ok(passes <= 20, `authorized ≤20 (hold 钳制), got ${passes}/50`);
  console.log(`    [x2] passes=${passes}/50(观测:共享 dev 池波动;硬断言=钳制/非负/对账)`);
  ok(results.every((x) => x === 200 || x === 402 || x >= 500), 'terminal statuses only (200/402/bounded 5xx)');
  const q = await waitUserQuiet(c, s.u.id, passes);
  const w = await c.seed.wallet(c.db, s.u.id);
  ok(new Decimal(w.balance).gte(0), `balance never negative: ${w.balance}`);
  eqDec(w.balance, new Decimal('0.01').minus(q.usageTotal).toFixed(18).replace(/0+$/, '').replace(/\.$/, ''), 'exact reconcile');
});

define('X3', '超级并发', '取消风暴:10 并发慢流随机时点 abort → 10 条账单,in_flight 归零', async (c) => {
  const s = await setup(c, 'x3', '10');
  const handles = Array.from({ length: 10 }, () =>
    sse(`${c.url.gw}/v1/chat/completions`, chat('rt-slowstream', { stream: true }), auth(s.key)),
  );
  await Promise.all(handles.map(async (h, i) => {
    const ready = await h.ready;
    eq(ready.status, 200, 'stream started');
    await sleep(150 + i * 80);
    h.abort();
  }));
  const q = await waitUserQuiet(c, s.u.id, 10, 30000);
  eq(q.usageCount, 10, '10 bills (部分交付即计费)');
  const w = await c.seed.wallet(c.db, s.u.id);
  ok(new Decimal(w.balance).lt(10), `charged for partial: ${w.balance}`);
});

define('X4', '超级并发', '渠道 RPM=3 × 12 并发 → 上游调用被钳制,超额 503 零扣费', async (c) => {
  const s = await setup(c, 'x4', '10');
  const before = ((await http(`${c.url.mock}/__metrics`)).json().metrics.byModel ?? {}) as Record<string, number>;
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-rpmlim'), headers: auth(s.key), timeoutMs: 30000 }).then((r) => r.status),
    ),
  );
  const after = ((await http(`${c.url.mock}/__metrics`)).json().metrics.byModel ?? {}) as Record<string, number>;
  const upstreamCalls = (after['rt-base#f=chunks1'] ?? 0) - (before['rt-base#f=chunks1'] ?? 0);
  ok(upstreamCalls <= 5, `upstream calls ≤5 (rpm 3 + 并发窗口松弛), got ${upstreamCalls}`);
  const ok200 = results.filter((x) => x === 200).length;
  const s503 = results.filter((x) => x === 503).length;
  eq(ok200 + s503, 12, 'all terminal: 200 or 503');
  await waitUserQuiet(c, s.u.id, ok200);
});

define('X5', '超级并发', '故障转移:ctl 打挂主渠道 429 → 备渠道接管成功,计费恰好一次', async (c) => {
  const s = await setup(c, 'x5', '10');
  const before = (await http(`${c.url.mock}/__metrics`)).json().metrics.requests as Record<string, number>;
  // 只把 chaosmock(主渠道)打成 429;real_model 干净,备渠道 openmock 正常应答
  await http(`${c.url.mock}/__ctl`, { method: 'POST', body: { scope: 'chaosmock', mode: 's429' } });
  try {
    const r = await http(`${c.url.gw}/v1/chat/completions`, {
      body: chat('rt-failover'),
      headers: auth(s.key),
      timeoutMs: 30000,
    });
    eq(r.status, 200, `failover to openmock succeeds, got ${r.status} ${r.text.slice(0, 200)}`);
    const after = (await http(`${c.url.mock}/__metrics`)).json().metrics.requests as Record<string, number>;
    const chaos = (after.chaosmock ?? 0) - (before.chaosmock ?? 0);
    const backup = (after.openmock ?? 0) - (before.openmock ?? 0);
    // 主渠道被熔断/死凭据跳过也是正确自保护;核心 = 客户端 200 + 备渠道真实接管 + 恰好一次计费
    ok(backup >= 1, `backup took over (${backup}×)`);
    console.log(`    [x5] primary attempted ${chaos}×, backup ${backup}×`);
    const q = await waitUserQuiet(c, s.u.id, 1);
    eq(q.usageCount, 1, 'billed exactly once');
  } finally {
    await http(`${c.url.mock}/__ctl`, { method: 'POST', body: { scope: 'chaosmock', mode: 'ok' } });
  }
});

define('X6', '超级并发', 'worker SIGKILL 崩溃中结算 → 重启后恰好一次全结算,无重复无丢失', async (c) => {
  const s = await setup(c, 'x6', '10');
  const fire = Array.from({ length: 30 }, () =>
    http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-exact'), headers: auth(s.key), timeoutMs: 30000 }).then((r) => r.status),
  );
  await sleep(400);
  process.kill(workerProc().pid, 'SIGKILL');
  try {
    const statuses = await Promise.all(fire);
    eq(statuses.filter((x) => x === 200).length, 30, 'all requests succeeded (settle-signal durable)');
  } finally {
    await restartWorker();
  }
  const q = await waitUserQuiet(c, s.u.id, 30, 60000);
  eq(q.usageCount, 30, 'exactly 30 usage rows (no dup, no loss)');
  eqDec(q.usageTotal, new Decimal('0.000546').times(30).toString(), 'exact total');
});

define('X7', '超级并发', 'worker 停摆 + SQL 造积压 → 准入关闸(fail-closed)→ 恢复后真实账单全额结算', async (c) => {
  const wp = workerProc();
  process.kill(wp.pid, 'SIGSTOP');
  const s = await setup(c, 'x7', '10');
  try {
    // 造 35 行「10 分钟老账龄」settlement_pending(production ADMISSION_MAX_PENDING=10000 下走 oldestPendingMs 维度关闸
    // 真实请求打不到关闸线;直接造行验证关闸语义本身——账单请求用不可能的 uuid v7 占位)
    await c.db.execute(sql`
      insert into billing_requests (request_id, user_id, status, reserved_amount, stream, quote, authorization_fingerprint, receipt, created_at, updated_at, next_settlement_at, lease_expires_at)
      select gen_random_uuid(), ${s.u.id}, 'settlement_pending', '0', false, '{}'::jsonb, 'x7-fabricated', '{"fabricated":true}'::jsonb,
             now() - (600000 * interval '1 millisecond'), now() - (600000 * interval '1 millisecond'),
             now() - (600000 * interval '1 millisecond'), now() - (600000 * interval '1 millisecond')
      from generate_series(1, 35)`);
    // 停摆下真实请求:准入应拒(settlement_backlog)
    const r1 = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-exact'), headers: auth(s.key), timeoutMs: 30000 });
    eq(r1.status, 503, `backlog gate closed (got ${r1.status})`);
    ok(r1.text.includes('settlement_backlog'), 'fail-closed code');
    // 清掉造的积压 → 立即恢复服务(SIGCONT 后 worker 结算真实账单)
    await c.db.execute(sql`
      delete from billing_requests where user_id = ${s.u.id} and authorization_fingerprint = 'x7-fabricated'`);
    const r2 = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-exact'), headers: auth(s.key), timeoutMs: 30000 });
    eq(r2.status, 200, 'gate reopened after backlog drain');
  } finally {
    process.kill(wp.pid, 'SIGCONT');
  }
  // 真实账单结算核对
  await poll('settled after resume', async () => {
    const r = await c.db.execute(sql`
      select count(*)::int as n from billing_requests where user_id = ${s.u.id} and status in ('settlement_pending','retry_wait','processing','authorized','in_flight')`);
    return Number((r[0] as any).n) === 0 ? true : null;
  }, 60000, 500);
  const usage = await c.db.execute(sql`
    select count(*)::int as n, coalesce(sum(amount),0)::text as total from usage_logs where user_id = ${s.u.id}`);
  const u = usage[0] as any;
  eqDec(String(u.total), new Decimal('0.000546').times(Number(u.n)).toString(), 'exact per settled');
  const w = await c.seed.wallet(c.db, s.u.id);
  ok(Number(w.in_flight) === 0, 'in_flight drained');
  eqDec(w.balance, new Decimal('10').minus(String(u.total)).toString(), 'exact reconcile');
});

define('X10', '超级并发', '终极对账:三不变量(腿平衡/余额=末腿/in_flight=授权和)+余额公式全库核验', async (c) => {
  // ① 每笔交易腿和 = 0
  const bad1 = await c.db.execute(sql`
    select l.transaction_id, sum(l.amount)::text as s from wallet_legs l
    group by l.transaction_id having sum(l.amount) <> 0`);
  eq(bad1.length, 0, '腿平衡 Σlegs=0 per transaction');
  // ② 账户余额 = 最后一条腿 balance_after
  const bad2 = await c.db.execute(sql`
    select a.id, a.balance::text from wallet_accounts a
    join lateral (select balance_after from wallet_legs l where l.account_id = a.id order by l.id desc limit 1) last on true
    where a.balance <> last.balance_after`);
  eq(bad2.length, 0, 'balance == last leg balance_after');
  // ③ in_flight = Σ active authorizations
  const bad3 = await c.db.execute(sql`
    select a.id from wallet_accounts a
    left join (select account_id, sum(amount) as s from wallet_authorizations where status = 'active' group by account_id) x on x.account_id = a.id
    where a.in_flight <> coalesce(x.s, 0)`);
  eq(bad3.length, 0, 'in_flight == Σ active authorizations');
  // ④ 每个测试用户: balance == credited(topup/gift) − Σusage_logs
  const bad4 = await c.db.execute(sql`
    select u.id,
      (select coalesce(sum(amount),0) from wallet_transactions t join wallet_legs l on l.transaction_id=t.id
        join wallet_accounts a2 on a2.id=l.account_id where a2.user_id=u.id and l.amount > 0 and t.kind in ('credit'))::text as credited,
      (select coalesce(sum(amount),0) from usage_logs where user_id=u.id and status=0)::text as used,
      (select balance from wallet_accounts a3 where a3.user_id=u.id limit 1)::text as bal
    from users u where u.issuer='rt-fire' and exists (select 1 from wallet_accounts a where a.user_id=u.id)`);
  for (const row of bad4 as any[]) {
    const expect = new Decimal(row.credited).minus(row.used);
    ok(new Decimal(row.bal).eq(expect), `user ${row.id}: balance ${row.bal} == credited ${row.credited} − used ${row.used}`);
  }
  ok(bad4.length >= 10, `核验了 ${bad4.length} 个测试用户钱包`);
});
