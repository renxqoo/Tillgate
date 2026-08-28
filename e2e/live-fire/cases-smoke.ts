/**
 * 冒烟组:验证装置本身(栈健康/mock 上游/种子/网关链路/结算落账),
 * 装置不通则整场红队测试无意义。
 */
import { define, ok, eq, eqDec, http, sse, poll, sleep } from './lib/h.ts';

const chatBody = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: 'user', content: 'hello' }],
  ...extra,
});

define('S1', '冒烟', '全部服务健康', async (c) => {
  for (const [name, url] of Object.entries(c.url) as Array<[string, string]>) {
    if (name === 'mock') continue;
    const r = await http(`${url}/healthz`, { timeoutMs: 3000 });
    eq(r.status, 200, `${name} healthz`);
  }
  const m = await http(`${c.url.mock}/openmock/v1/models`, {
    headers: { authorization: 'Bearer sk-mock-openmock-k1' },
  });
  eq(m.status, 200, 'mock models');
});

define('S2', '冒烟', 'mock 上游直连:非流式 + 流式', async (c) => {
  const n = await http(`${c.url.mock}/openmock/v1/chat/completions`, {
    body: chatBody('rt-base'),
    headers: { authorization: 'Bearer sk-mock-openmock-k1' },
  });
  eq(n.status, 200, 'non-stream status');
  ok((n.json().usage?.total_tokens ?? 0) > 0, 'usage present');
  const s = sse(
    `${c.url.mock}/openmock/v1/chat/completions`,
    chatBody('rt-base', { stream: true }),
    {
      authorization: 'Bearer sk-mock-openmock-k1',
    },
  );
  const ready = await s.ready;
  eq(ready.status, 200, 'stream status');
  eq(await s.done, 'done', 'stream completed');
  ok(s.chunks.length > 2, `stream chunks=${s.chunks.length}`);
  ok(s.text.includes('[DONE]'), '[DONE] terminator');
});

define('S3', '冒烟', '种子链路:用户/密钥/admin 注资', async (c) => {
  const u = await c.seed.mkUser(c.db, 'smoke');
  c.smokeUser = u;
  const raw = await c.seed.mkKey(c.db, u.id, 'rt-smoke');
  c.smokeKey = raw;
  const bal = await c.seed.fund(u.id, '10', `rt-fund-smoke-${Date.now()}`);
  eqDec(bal, '10', 'fund balance');
  const w = await c.seed.wallet(c.db, u.id);
  eqDec(w.balance, '10', 'wallet balance after fund');
});

define('S4', '冒烟', '网关非流式走通 + 精确结算', async (c) => {
  const r = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chatBody('rt-exact'),
    headers: { authorization: `Bearer ${c.smokeKey}` },
  });
  eq(r.status, 200, `chat status ${r.text.slice(0, 200)}`);
  const reqId = r.headers.get('x-request-id');
  ok(reqId != null, 'x-request-id present');
  const usage = await poll(`usage row ${reqId}`, async () => {
    const row = await c.seed.usageRow(c.db, reqId);
    return row != null ? row : null;
  });
  // (100×2.1 + 40×8.4)/1e6 = 0.000546 元,分毫不差
  eqDec(usage.amount, '0.000546', 'exact billed amount');
  eq(Number(usage.input_tokens), 100, 'input tokens');
  eq(Number(usage.output_tokens), 40, 'output tokens');
  const bill = await c.seed.billOf(c.db, reqId);
  eq(bill.status, 'settled', 'billing_request settled');
  const w = await c.seed.wallet(c.db, c.smokeUser.id);
  eqDec(w.balance, '9.999454', 'wallet after one exact bill');
  eqDec(w.in_flight, '0', 'in_flight drained');
});

define('S5', '冒烟', '网关流式走通 + 结算', async (c) => {
  const s = sse(`${c.url.gw}/v1/chat/completions`, chatBody('rt-exact', { stream: true }), {
    authorization: `Bearer ${c.smokeKey}`,
  });
  const ready = await s.ready;
  eq(ready.status, 200, 'stream status');
  eq(await s.done, 'done', 'stream done');
  const reqId = ready.headers.get('x-request-id');
  const usage = await poll(`usage ${reqId}`, async () => c.seed.usageRow(c.db, reqId));
  eqDec(usage.amount, '0.000546', 'stream exact billed amount');
  await sleep(500);
  const w = await c.seed.wallet(c.db, c.smokeUser.id);
  eqDec(w.balance, '9.998908', 'wallet after two exact bills');
  eqDec(w.in_flight, '0', 'in_flight drained');
});
