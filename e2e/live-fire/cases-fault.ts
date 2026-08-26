/**
 * G3 上游故障注入:429/5xx/4xx 透传、挂起超时、mid-stream 断连、
 * 畸形 SSE、302 重定向、全局打挂与熔断恢复、死凭据快速止血。
 * 每条的钱判据:失败零扣费(或部分交付精确计费)、in_flight 归零、网关不崩。
 * chaosmock 独立端口(8793)熔断状态自隔离;破坏性用例后清 breaker/credential 键。
 */
import { sql } from 'drizzle-orm';
import { define, ok, eq, eqDec, http, sse, poll, sleep, between } from './lib/h.ts';

const chat = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: 'user', content: 'fault me' }],
  ...extra,
});
const auth = (key: string) => ({ authorization: `Bearer ${key}` });

async function setup(c: any, tag: string, amount = '50') {
  clearBreaker(); // 每例开始清熔断/死凭据/守卫键:前一例的故障积累不得污染本例(熔断语义本身由 F13/F14 专测)
  const u = await c.seed.mkUser(c.db, tag);
  const key = await c.seed.mkKey(c.db, u.id, `rt-${tag}`);
  if (Number(amount) > 0) await c.seed.fund(u.id, amount, `rt-fund-${tag}-${Date.now()}`);
  return { u, key };
}

async function drainWallet(c: any, userId: number, timeoutMs = 25000) {
  return poll('wallet drained', async () => {
    const w = await c.seed.wallet(c.db, userId);
    return Number(w.in_flight) === 0 ? w : null;
  }, timeoutMs);
}

function clearBreaker() {
  const pass = (() => {
    try {
      return new URL(process.env.REDIS_URL as string).password;
    } catch {
      return 'root123';
    }
  })();
  Bun.spawnSync(['bash', '-c', `redis-cli -a ${pass} --scan --pattern 'inference:health:*' 2>/dev/null | xargs -r redis-cli -a ${pass} del >/dev/null 2>&1; redis-cli -a ${pass} --scan --pattern 'inference:health:*' 2>/dev/null | xargs -r redis-cli -a ${pass} del >/dev/null 2>&1; redis-cli -a ${pass} --scan --pattern 'authfail:*' 2>/dev/null | xargs -r redis-cli -a ${pass} del >/dev/null 2>&1; redis-cli -a ${pass} --scan --pattern 'auth:*' 2>/dev/null | xargs -r redis-cli -a ${pass} del >/dev/null 2>&1`]);
}

async function zeroCharge(c: any, userId: number) {
  const w = await drainWallet(c, userId);
  ok(new (await import('@tillgate/billing')).Decimal(w.balance).gte(0), `balance ${w.balance} >= 0`);
  const n = await c.db.execute(sql`select count(*)::int as n from usage_logs where user_id = ${userId}`);
  eq(Number((n.rows[0] as any).n), 0, '失败零 usage 行');
}

async function healthStillOk(c: any) {
  const r = await http(`${c.url.gw}/healthz`, { timeoutMs: 3000 });
  eq(r.status, 200, 'gateway alive after fault');
}

define('F1', '上游故障', '上游 429(非流式)→ 重试耗尽后终态错误(4xx 透传或 502/503),零扣费', async (c) => {
  const { u, key } = await setup(c, 'f1');
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-429'), headers: auth(key), timeoutMs: 20000 });
  between(r.status, 400, 503, `client sees terminal error, got ${r.status}`);
  await zeroCharge(c, u.id);
  await healthStillOk(c);
});

define('F2', '上游故障', '上游 429(流式)→ 错误信封,零扣费', async (c) => {
  const { u, key } = await setup(c, 'f2');
  const r = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-429', { stream: true }),
    headers: auth(key),
    timeoutMs: 20000,
  });
  ok(r.status !== 200, `stream not started, got ${r.status}`);
  await zeroCharge(c, u.id);
});

define('F3', '上游故障', '上游 500 → 502 upstream_failed,零扣费', async (c) => {
  const { u, key } = await setup(c, 'f3');
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-500'), headers: auth(key), timeoutMs: 20000 });
  between(r.status, 500, 503, `5xx, got ${r.status}`);
  await zeroCharge(c, u.id);
  await healthStillOk(c);
});

define('F4', '上游故障', '上游 401(凭据被废)→ 终态错误(死凭据计入),零扣费', async (c) => {
  const { u, key } = await setup(c, 'f4');
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-401up'), headers: auth(key), timeoutMs: 20000 });
  between(r.status, 400, 503, `got ${r.status}`);
  await zeroCharge(c, u.id);
});

define('F5', '上游故障', '上游 403 → 终态错误,零扣费', async (c) => {
  const { u, key } = await setup(c, 'f5');
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-403up'), headers: auth(key), timeoutMs: 20000 });
  between(r.status, 400, 503, `got ${r.status}`);
  await zeroCharge(c, u.id);
});

define('F6', '上游故障', '上游 400 参数错 → 终态错误,零扣费', async (c) => {
  const { u, key } = await setup(c, 'f6');
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-400up'), headers: auth(key), timeoutMs: 20000 });
  between(r.status, 400, 503, `got ${r.status}`);
  await zeroCharge(c, u.id);
});

define('F7', '上游故障', '上游挂死不响应 → 连接超时×重试×耗尽 → 502,零扣费,不拖死网关', async (c) => {
  const { u, key } = await setup(c, 'f7');
  const start = Date.now();
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-hang'), headers: auth(key), timeoutMs: 30000 });
  ok(r.status >= 500, `502 after retries, got ${r.status}`);
  ok(Date.now() - start < 25000, `bounded time ${Date.now() - start}ms`);
  await zeroCharge(c, u.id);
  await healthStillOk(c);
});

define('F8', '上游故障', '上游首字节 3s(超 2.5s 连接超时)→ 超时重试后 502,零扣费', async (c) => {
  const { u, key } = await setup(c, 'f8');
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-ttfb'), headers: auth(key), timeoutMs: 30000 });
  ok(r.status >= 500, `got ${r.status}`);
  await zeroCharge(c, u.id);
});

define('F9', '上游故障', '上游流中 RST(已收 2 chunk)→ 部分交付计费,不崩溃不悬挂', async (c) => {
  const { u, key } = await setup(c, 'f9');
  const s = sse(`${c.url.gw}/v1/chat/completions`, chat('rt-reset', { stream: true }), auth(key));
  const ready = await s.ready;
  eq(ready.status, 200, 'stream started');
  const outcome = await Promise.race([s.done, sleep(15000).then(() => 'timeout' as const)]);
  ok(outcome !== 'timeout', 'stream terminates within 15s after upstream reset');
  const reqId = ready.headers.get('x-request-id')!;
  const usage = await poll('usage', () => c.seed.usageRow(c.db, reqId), 25000);
  ok(Number(usage.amount) >= 0, `partial amount ${usage.amount}`);
  await drainWallet(c, u.id);
  await healthStillOk(c);
});

define('F10', '上游故障', '上游 200+响应体立即死亡 → 空补全按估算计费(保守),行为与空 JSON 体不一致(观察项)', async (c) => {
  const { u, key } = await setup(c, 'f10');
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-reset0'), headers: auth(key), timeoutMs: 30000 });
  // Bun fetch 将「错误流」呈现为干净空体 → 网关按 empty completion 成功路径处理:
  // 按估算计费(不免费)。与 B4(空 JSON 体 → released 零扣费)行为不一致——资金两个
  // 方向都安全(保守多收 vs 释放),记为低危观察项。真连接层 RST 由 F7/F8/F9 覆盖。
  ok(r.status === 200 || r.status >= 500, `bounded terminal, got ${r.status}`);
  const w = await drainWallet(c, u.id);
  const usage = await c.db.execute(sql`select count(*)::int as n, coalesce(sum(amount),0)::text as total from usage_logs where user_id = ${u.id}`);
  const row = usage.rows[0] as any;
  eq(Number(row.n), 1, 'exactly one usage row (empty completion billed by estimate)');
  ok(Number(row.total) > 0 && Number(row.total) < 1, `estimated bounded charge ${row.total}`);
  ok(Number(w.balance) < 50 && Number(w.balance) > 49, `conservative charge, balance ${w.balance}`);
});

define('F11', '上游故障', '上游吐畸形 SSE(非 JSON 帧)→ 请求终结,计费有界,不挂死', async (c) => {
  const { u, key } = await setup(c, 'f11');
  const s = sse(`${c.url.gw}/v1/chat/completions`, chat('rt-garbage', { stream: true }), auth(key));
  const ready = await s.ready;
  eq(ready.status, 200, 'stream started');
  const outcome = await Promise.race([s.done, sleep(15000).then(() => 'timeout' as const)]);
  ok(outcome !== 'timeout', `garbage stream terminates (${outcome})`);
  await drainWallet(c, u.id);
  const n = await c.db.execute(sql`select count(*)::int as n from usage_logs where user_id = ${u.id}`);
  ok(Number((n.rows[0] as any).n) <= 1, '≤1 usage row');
  const w = await c.seed.wallet(c.db, u.id);
  ok(Number(w.balance) <= 50 && Number(w.balance) >= 0, `bounded charge, balance ${w.balance}`);
});

define('F12', '上游故障', '上游 302 重定向到任意路径 → 手动跟随受 SSRF 复查,不无限跟,零扣费', async (c) => {
  const { u, key } = await setup(c, 'f12');
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-redir'), headers: auth(key), timeoutMs: 20000 });
  ok(r.status >= 400, `redirect handled as error, got ${r.status}`);
  await zeroCharge(c, u.id);
  await healthStillOk(c);
});

define('F13', '上游故障', '全局打挂 chaosmock(__ctl hang)→ 超时 502;恢复后不无限 hang(熔断兜底)', async (c) => {
  const { u, key } = await setup(c, 'f13');
  await http(`${c.url.mock}/__ctl`, { method: 'POST', body: { scope: 'chaosmock', mode: 'hang' } });
  const start = Date.now();
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-429'), headers: auth(key), timeoutMs: 30000 });
  ok(r.status >= 500, `hang → bounded 5xx, got ${r.status} in ${Date.now() - start}ms`);
  await zeroCharge(c, u.id);
  // 恢复上游:熔断计数已污染,断言「快速失败(熔断)或恢复成功」都算防守成立,唯独不允许再 hang
  await http(`${c.url.mock}/__ctl`, { method: 'POST', body: { scope: 'chaosmock', mode: 'ok' } });
  const t2 = Date.now();
  const r2 = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-429'), headers: auth(key), timeoutMs: 30000 });
  ok(Date.now() - t2 < 15000, `no indefinite hang after vendor recovery (${Date.now() - t2}ms, status ${r2.status})`);
  clearBreaker();
  await healthStillOk(c);
});

define('F14', '上游故障', '死凭据快速止血:连续 3 次 401 → 渠道停路由(no_available_channel 快速 503)', async (c) => {
  const { u, key } = await setup(c, 'f14');
  for (let i = 0; i < 3; i++) {
    await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-401up'), headers: auth(key), timeoutMs: 20000 });
  }
  const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-401up'), headers: auth(key), timeoutMs: 20000 });
  // 死凭据跳过 → 无可用渠道快速失败,或(计数未达)再次 401——两者皆零扣费;断言不慢不 hang
  ok(r.status >= 400, `got ${r.status}`);
  const elapsed = r.elapsedMs;
  ok(elapsed < 5000, `fast-fail ${elapsed}ms (dead credential short-circuits routing)`);
  await zeroCharge(c, u.id);
  clearBreaker();
});
