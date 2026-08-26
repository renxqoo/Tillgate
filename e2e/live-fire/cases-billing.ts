/**
 * G2 计费正确性与薅羊毛向量:上游 usage 伪造/缺失/畸形、中途断开、
 * 费率卡系数、日限额、重试幂等、多 choice 计费、无 DONE 终结流。
 * 钱的判据:金额按公式精确(Decimal 比较)、in_flight 归零、失败零扣费。
 */
import { sql } from 'drizzle-orm';
import { Decimal } from '@tillgate/billing';
import { define, ok, eq, eqDec, http, sse, poll, sleep, between } from './lib/h.ts';

const chat = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: 'user', content: 'hello redteam' }],
  ...extra,
});
const auth = (key: string) => ({ authorization: `Bearer ${key}` });

async function setup(c: any, tag: string, amount = '100') {
  const u = await c.seed.mkUser(c.db, tag);
  const key = await c.seed.mkKey(c.db, u.id, `rt-${tag}`);
  await c.seed.fund(u.id, amount, `rt-fund-${tag}-${Date.now()}`);
  return { u, key };
}

async function settleOf(c: any, reqId: string) {
  return poll(`settle ${reqId}`, async () => {
    const bill = await c.seed.billOf(c.db, reqId);
    if (bill == null) return null;
    if (['settled', 'released', 'dead'].includes(bill.status)) return bill;
    return null;
  });
}

async function latestBill(c: any, userId: number) {
  const r = await c.db.execute(sql`
    select request_id, status from billing_requests where user_id = ${userId} order by created_at desc limit 1`);
  return (r.rows[0] as any) ?? null;
}

define('B1', '计费·薅羊毛', '上游谎报 usage=0 但内容已交付 → 按估算计费防白嫖,终态干净', async (c) => {
  const { u, key } = await setup(c, 'b1');
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-zero'), headers: auth(key) });
  eq(r.status, 200, 'status');
  ok((r.json().choices ?? [])[0]?.message?.content?.length > 0, 'content was delivered');
  const bill = await settleOf(c, r.headers.get('x-request-id')!);
  eq(bill.status, 'settled', 'settled (usage 0 视同缺失 → 估算)');
  const usage = await c.seed.usageRow(c.db, r.headers.get('x-request-id')!);
  ok(Number(usage.amount) > 0, `estimated charge ${usage.amount} > 0 (内容交付不可白嫖)`);
  ok(Number(usage.amount) < 1, 'estimate bounded');
  const w = await c.seed.wallet(c.db, u.id);
  eqDec(w.in_flight, '0', 'in_flight 归零');
});

define('B2', '计费·薅羊毛', '上游伪造负 usage → 钳制 ≥ 0,绝不倒充', async (c) => {
  const { u, key } = await setup(c, 'b2');
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-neg'), headers: auth(key) });
  eq(r.status, 200, `status body=${r.text.slice(0, 300)}`);
  await settleOf(c, r.headers.get('x-request-id')!);
  const w = await c.seed.wallet(c.db, u.id);
  ok(new Decimal(w.balance).gte(0), `balance ${w.balance} >= 0`);
  between(Number(w.balance), 99, 100, '余额不被负 usage 推高');
});

define('B3', '计费·薅羊毛', '上游伪造巨型 usage(10 亿 token)→ 金额=公式精确值,#over 透支补扣', async (c) => {
  const { u, key } = await setup(c, 'b3', '20000');
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-huge'), headers: auth(key) });
  eq(r.status, 200, 'status');
  const reqId = r.headers.get('x-request-id')!;
  const usage = await poll(`usage ${reqId}`, () => c.seed.usageRow(c.db, reqId));
  // (1e6×2.1 + 1e9×8.4)/1e6 = 8402.1 元,分毫精确
  eqDec(usage.amount, '8402.1', 'huge billed amount exact');
  await poll('in_flight drain', async () => {
    const w = await c.seed.wallet(c.db, u.id);
    return Number(w.in_flight) === 0 ? w : null;
  });
  const w = await c.seed.wallet(c.db, u.id);
  eqDec(w.balance, '11597.9', '结算侧允许透支到精确负值');
});

define('B4', '计费·薅羊毛', '上游 200 空响应体 → 优雅失败,零扣费无悬挂', async (c) => {
  const { u, key } = await setup(c, 'b4');
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-empty'), headers: auth(key) });
  ok(r.status >= 400, `empty body → 4xx/5xx, got ${r.status}`);
  const bill = await poll('terminal bill', async () => {
    const row = await latestBill(c, u.id);
    return row != null && ['settled', 'released', 'dead'].includes(row.status) ? row : null;
  });
  eq(bill.status, 'released', 'released not charged');
  const w = await c.seed.wallet(c.db, u.id);
  eqDec(w.balance, '100', '零扣费');
});

define('B5', '计费·薅羊毛', '流式收完但上游不给 usage → 按估算计费 ≠ 0(不白嫖)', async (c) => {
  const { u, key } = await setup(c, 'b5');
  const s = sse(`${c.url.gw}/v1/chat/completions`, chat('rt-nousage', { stream: true }), auth(key));
  eq((await s.ready).status, 200, 'stream status');
  eq(await s.done, 'done', 'stream done');
  const reqId = (await s.ready).headers.get('x-request-id')!;
  const usage = await poll(`usage ${reqId}`, () => c.seed.usageRow(c.db, reqId));
  ok(Number(usage.amount) > 0, `estimated amount ${usage.amount} > 0`);
  ok(Number(usage.amount) < 1, `estimated amount ${usage.amount} bounded`);
});

define('B6', '计费·薅羊毛', '流式逐帧 usage + 中途断开 → 按最后帧精确计费(不多收不免费)', async (c) => {
  const { u, key } = await setup(c, 'b6');
  const s = sse(`${c.url.gw}/v1/chat/completions`, chat('rt-perframe', { stream: true }), auth(key));
  const ready = await s.ready;
  eq(ready.status, 200, 'stream status');
  await poll('≥2 chunks', () => (s.chunks.length >= 2 ? s.chunks.length : null));
  s.abort();
  const reqId = ready.headers.get('x-request-id')!;
  const usage = await poll(`usage ${reqId}`, () => c.seed.usageRow(c.db, reqId));
  between(Number(usage.amount), (100 * 2.1) / 1e6, (100 * 2.1 + 50 * 8.4) / 1e6, `partial amount ${usage.amount}`);
  const bill = await settleOf(c, reqId);
  eq(bill.status, 'settled', 'partial delivery settled');
});

define('B7', '计费·薅羊毛', '非流式客户端早断 → 至多 1 条账单,无悬挂无重复', async (c) => {
  const { u, key } = await setup(c, 'b7');
  const ctrl = new AbortController();
  const p = fetch(`${c.url.gw}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth(key) },
    body: JSON.stringify(chat('rt-base')),
    signal: ctrl.signal,
  });
  await sleep(250);
  ctrl.abort();
  await p.catch(() => {});
  await poll('terminal bill', async () => {
    const row = await latestBill(c, u.id);
    return row != null && ['settled', 'released', 'dead'].includes(row.status) ? row : null;
  }, 25000);
  const n = await c.db.execute(sql`select count(*)::int as n from usage_logs where user_id = ${u.id}`);
  ok(Number((n.rows[0] as any).n) <= 1, 'at most one usage row');
  await poll('in_flight drain', async () => {
    const w = await c.seed.wallet(c.db, u.id);
    return Number(w.in_flight) === 0 ? w : null;
  }, 30000);
});

define('B8', '计费·薅羊毛', '费率卡系数 0.5 → 金额恰为半价(逐分毫)', async (c) => {
  const full = await setup(c, 'b8a');
  const half = await setup(c, 'b8b');
  await c.db.execute(sql`insert into rate_cards (name) values ('rt-half') on conflict (name) do nothing`);
  await c.db.execute(sql`
    insert into rate_card_coefficients (rate_card_id, scope, coefficient)
    select id, 'global', '0.5' from rate_cards where name = 'rt-half'`);
  await c.db.execute(sql`
    update users set rate_card_id = (select id from rate_cards where name = 'rt-half') where id = ${half.u.id}`);
  for (const [tag, keyRaw] of [['full', full.key], ['half', half.key]] as const) {
    const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-exact'), headers: auth(keyRaw) });
    eq(r.status, 200, `${tag} status`);
    const usage = await poll(`${tag} usage`, () => c.seed.usageRow(c.db, r.headers.get('x-request-id')!));
    if (tag === 'full') eqDec(usage.amount, '0.000546', 'full price');
    else eqDec(usage.amount, '0.000273', 'half price exact');
  }
});

define('B9', '计费·薅羊毛', '用户日限额小于预扣估算 → 402 整单拒绝零扣费', async (c) => {
  const { u, key } = await setup(c, 'b9');
  await c.db.execute(sql`update users set daily_spend_limit = '0.001' where id = ${u.id}`);
  const r = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-exact', { max_tokens: 4096 }),
    headers: auth(key),
  });
  eq(r.status, 402, `daily limit reject, got ${r.status} ${r.text.slice(0, 120)}`);
  const n = await c.db.execute(sql`select count(*)::int as n from billing_requests where user_id = ${u.id}`);
  eq(Number((n.rows[0] as any).n), 0, 'zero billing rows');
  await c.db.execute(sql`update users set daily_spend_limit = null where id = ${u.id}`);
});

define('B10', '计费·薅羊毛', 'Key 日限额 → 402 整单拒绝零扣费', async (c) => {
  const { u, key } = await setup(c, 'b10');
  await c.db.execute(sql`update api_keys set daily_spend_limit = '0.001' where user_id = ${u.id}`);
  const r = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-exact', { max_tokens: 4096 }),
    headers: auth(key),
  });
  eq(r.status, 402, `key daily limit, got ${r.status}`);
  const n = await c.db.execute(sql`select count(*)::int as n from billing_requests where user_id = ${u.id}`);
  eq(Number((n.rows[0] as any).n), 0, 'zero billing rows');
});

define('B11', '计费·薅羊毛', '上游重试幂等:同 idempotency-key 重发不双花,最终失败零扣费', async (c) => {
  const { u, key } = await setup(c, 'b11');
  const before = ((await http(`${c.url.mock}/__metrics`)).json().metrics.idempotencyKeys ?? {}) as Record<string, number>;
  const r = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-ttfb'),
    headers: auth(key),
    timeoutMs: 30000,
  });
  ok(r.status >= 500, `timeout failover exhausted → 502, got ${r.status}`);
  const after = ((await http(`${c.url.mock}/__metrics`)).json().metrics.idempotencyKeys ?? {}) as Record<string, number>;
  const retried = Object.entries(after).filter(([k, n]) => n >= 2 && (before[k] ?? 0) < 2);
  ok(retried.length >= 1, '≥1 idempotency-key seen ≥2 times upstream (retry reuse)');
  const w = await poll('release', async () => {
    const x = await c.seed.wallet(c.db, u.id);
    return Number(x.in_flight) === 0 ? x : null;
  }, 25000);
  eqDec(w.balance, '100', '失败零扣费');
});

define('B12', '计费·薅羊毛', 'n=3 多 choice → 按 usage 计费一次,不按 choice 数翻倍', async (c) => {
  const { key } = await setup(c, 'b12');
  const r = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-nchoice', { n: 3 }),
    headers: auth(key),
  });
  eq(r.status, 200, 'status');
  eq((r.json().choices ?? []).length, 3, '3 choices');
  const usage = await poll('usage', () => c.seed.usageRow(c.db, r.headers.get('x-request-id')!));
  eqDec(usage.amount, '0.0003108', 'amount by usage not choices');
});

define('B13', '计费·薅羊毛', '上游回显伪造 model:改写默认关(§3.6 设计)→ 关键=计费仍按对外目录价', async (c) => {
  const { key } = await setup(c, 'b13');
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-wrongmodel'), headers: auth(key) });
  eq(r.status, 200, 'status');
  // responseModelRewrite 默认关:客户端看到上游回显值(设计决策,低危观察项,非缺陷)
  const seen = r.json().model;
  ok(['rt-wrongmodel', 'wrong-model-echo'].includes(seen), `model field passthrough/rewrite, got ${seen}`);
  // 钱的断言:计费不受回显影响,仍按对外目录价 × usage
  const usage = await poll('usage', () => c.seed.usageRow(c.db, r.headers.get('x-request-id')!));
  eqDec(usage.amount, '0.0003108', 'billing unaffected by model echo spoof');
});

define('B14', '计费·薅羊毛', '流式无 [DONE] 终结 → 正常收尾计费一次', async (c) => {
  const { u, key } = await setup(c, 'b14');
  const s = sse(`${c.url.gw}/v1/chat/completions`, chat('rt-nodone', { stream: true }), auth(key));
  eq((await s.ready).status, 200, 'status');
  await s.done;
  const reqId = (await s.ready).headers.get('x-request-id')!;
  const usage = await poll('usage', () => c.seed.usageRow(c.db, reqId));
  eqDec(usage.amount, '0.0003108', 'default usage(12,34) exact despite missing [DONE]');
});

define('B15', '计费·薅羊毛', '上游巨量内容洪流(64KB×2 chunk)→ 网关不崩,按 usage 计费', async (c) => {
  const { key } = await setup(c, 'b15');
  const r = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-big'),
    headers: auth(key),
    timeoutMs: 20000,
  });
  eq(r.status, 200, 'status');
  const usage = await poll('usage', () => c.seed.usageRow(c.db, r.headers.get('x-request-id')!));
  eqDec(usage.amount, '0.0003108', 'default usage exact');
});
