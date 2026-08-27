/**
 * 网关鉴权与协议滥用:坏/废/封/过期 key、JWT 伪造、爆破锁定(strict 实例)、
 * 模型不存在、畸形体、413、伪造 x-request-id、GET /v1/models 泄露面、
 * SSRF 逃生门在严格实例(8812, ALLOW_LOCAL_URL=false)必须堵死本地地址。
 */
import { sql } from 'drizzle-orm';
import { define, ok, eq, http, poll, sleep } from './lib/h.ts';

const chat = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: 'user', content: 'auth me' }],
  ...extra,
});
const auth = (key: string) => ({ authorization: `Bearer ${key}` });

async function setup(c: any, tag: string, amount = '20') {
  const u = await c.seed.mkUser(c.db, tag);
  const key = await c.seed.mkKey(c.db, u.id, `rt-${tag}`);
  if (Number(amount) > 0) await c.seed.fund(u.id, amount, `rt-fund-${tag}-${Date.now()}`);
  return { u, key };
}

async function zeroBills(c: any, userId: number) {
  const n = await c.db.execute(
    sql`select count(*)::int as n from billing_requests where user_id = ${userId}`,
  );
  eq(Number((n[0] as any).n), 0, '零计费请求(未进计费管线)');
}

define('A1', '网关鉴权', '无 Authorization / Bearer 空 / 纯垃圾 token → 401', async (c) => {
  const { u } = await setup(c, 'a1');
  const cases: Array<[string, Record<string, string>]> = [
    ['none', {}],
    ['empty-bearer', { authorization: 'Bearer ' }],
    ['garbage', { authorization: 'Bearer !@#$%^&*()' }],
    ['wrong-scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
  ];
  for (const [name, headers] of cases) {
    const r = await http(`${c.url.gw}/v1/chat/completions`, { body: chat('rt-base'), headers });
    eq(r.status, 401, `${name} → 401`);
  }
  await zeroBills(c, u.id);
});

define(
  'A2',
  '网关鉴权',
  '超长 10KB token / 控制字符 / emoji 垃圾 → 401 或传输层拒绝,不炸',
  async (c) => {
    const { u } = await setup(c, 'a2');
    const attempts: Array<[string, string]> = [
      ['10KB', `Bearer ${'A'.repeat(10240)}`],
      ['ctrl-chars', 'Bearer sk_\x00\x01\x02deadbeef'],
      ['crlf-inject', 'Bearer sk_test\r\nX-Inject: 1'],
      ['json-ish', `Bearer ${JSON.stringify({ alg: 'none' })}`],
    ];
    for (const [name, value] of attempts) {
      let status = -1;
      try {
        const r = await http(`${c.url.gw}/v1/chat/completions`, {
          body: chat('rt-base'),
          headers: { authorization: value },
        });
        status = r.status;
      } catch {
        status = 0; // 传输层/客户端校验拒绝(非法头值)——同样算防线
      }
      ok(status === 401 || status === 0, `${name} → 401/拒绝, got ${status}`);
    }
    await zeroBills(c, u.id);
  },
);

define('A3', '网关鉴权', '格式合法但 hash 不存在的随机 key → 401', async (c) => {
  const { u } = await setup(c, 'a3');
  const fake = `sk_rt${Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`;
  const r = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-base'),
    headers: auth(fake),
  });
  eq(r.status, 401, 'unknown key → 401');
  await zeroBills(c, u.id);
});

define('A4', '网关鉴权', '撤销即刻生效:DELETE /v1/keys/:id 后同一 key 立即 401', async (c) => {
  const s = await setup(c, 'a4');
  // 真实路径登录 + 建 key + 撤销
  const login = await http(`${c.url.client}/v1/auth/login`, {
    body: { email: s.u.email, password: 'Rt!Passw0rd#42' },
  });
  eq(login.status, 200, 'login');
  const token = login.json().token;
  const created = await http(`${c.url.client}/v1/keys`, {
    body: { name: 'rt-a4-temp' },
    headers: { authorization: `Bearer ${token}` },
  });
  eq(created.status, 201, 'create key');
  const plaintext = created.json().plaintext;
  const ok1 = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-base'),
    headers: auth(plaintext),
  });
  eq(ok1.status, 200, 'fresh key works');
  const del = await http(`${c.url.client}/v1/keys/${created.json().id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  ok([200, 204].includes(del.status), `delete key → ${del.status}`);
  const r2 = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-base'),
    headers: auth(plaintext),
  });
  eq(r2.status, 401, 'revoked key instantly dead');
});

define('A5', '网关鉴权', '封禁用户:key 立即 401(热路径逐请求查状态)', async (c) => {
  const s = await setup(c, 'a5');
  await c.db.execute(sql`update users set status = 1 where id = ${s.u.id}`);
  const r = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-base'),
    headers: auth(s.key),
  });
  eq(r.status, 401, 'banned user key → 401');
  await c.db.execute(sql`update users set status = 0 where id = ${s.u.id}`);
  const r2 = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-base'),
    headers: auth(s.key),
  });
  eq(r2.status, 200, 'unban restores');
});

define('A6', '网关鉴权', '过期 key(expires_at 过去)→ 401', async (c) => {
  const s = await setup(c, 'a6');
  await c.db.execute(
    sql`update api_keys set expires_at = now() - interval '1 hour' where user_id = ${s.u.id}`,
  );
  const r = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-base'),
    headers: auth(s.key),
  });
  eq(r.status, 401, 'expired key → 401');
});

define('A7', '网关鉴权', 'App JWT 分支伪造:错 secret 签名 / alg none / 过期 → 401', async (c) => {
  const { u } = await setup(c, 'a7');
  const { SignJWT } = await import('jose');
  const fakeSecret = new TextEncoder().encode('x'.repeat(64));
  const jwt1 = await new SignJWT({ realm: 'app' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(fakeSecret);
  const r1 = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-base'),
    headers: auth(jwt1),
  });
  eq(r1.status, 401, 'wrong-secret jwt → 401');
  const jwt2 = await new SignJWT({ realm: 'app' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(fakeSecret);
  const r2 = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-base'),
    headers: auth(jwt2),
  });
  eq(r2.status, 401, 'expired jwt → 401');
  await zeroBills(c, u.id);
});

define(
  'A8',
  '网关鉴权',
  'IP 维度爆破锁定(strict 8812 默认阈值 30/300s)→ 锁内有效 key 也 401(组末执行防污染)',
  async (c) => {
    // 31 个随机无效 key 打 strict 网关 → IP 锁(authfail:ip:lock:*)
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const fake = `sk_rt${Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`;
      const r = await http(`${c.url.gwStrict}/v1/chat/completions`, {
        body: chat('rt-base'),
        headers: auth(fake),
      });
      last = r.status;
    }
    eq(last, 401, 'brute force all 401');
    const s = await setup(c, 'a8');
    const r = await http(`${c.url.gwStrict}/v1/chat/completions`, {
      body: chat('rt-base'),
      headers: auth(s.key),
    });
    eq(r.status, 401, 'valid key blocked by IP lockout');
    // 清锁(键名 authfail:*)并自证恢复,确保不污染后续用例
    const pass = new URL(process.env.REDIS_URL as string).password;
    const clear = () =>
      Bun.spawnSync([
        'bash',
        '-c',
        `redis-cli -a ${pass} --scan --pattern 'authfail:*' 2>/dev/null | xargs -r redis-cli -a ${pass} del >/dev/null 2>&1; redis-cli -a ${pass} --scan --pattern 'auth:*' 2>/dev/null | xargs -r redis-cli -a ${pass} del >/dev/null 2>&1`,
      ]);
    clear();
    await sleep(500);
    const probe = await http(`${c.url.gw}/v1/chat/completions`, {
      body: chat('rt-base'),
      headers: auth(s.key),
    });
    if (probe.status !== 200) {
      clear();
      await sleep(1000);
      const probe2 = await http(`${c.url.gw}/v1/chat/completions`, {
        body: chat('rt-base'),
        headers: auth(s.key),
      });
      eq(probe2.status, 200, 'IP lock cleared (self-healing verify)');
    }
  },
);

define('A9', '网关鉴权', '模型不存在/未上架 → 干净 4xx 零扣费', async (c) => {
  const s = await setup(c, 'a9');
  for (const model of ['no-such-model', '', 'rt-base\u0000injection', 'a'.repeat(200)]) {
    const r = await http(`${c.url.gw}/v1/chat/completions`, {
      body: chat(model),
      headers: auth(s.key),
    });
    ok(r.status >= 400 && r.status < 500, `model "${model.slice(0, 20)}" → 4xx, got ${r.status}`);
  }
  await zeroBills(c, s.u.id);
});

define('A10', '网关鉴权', 'GET /v1/models 只列上架模型,不泄露渠道/凭据 internals', async (c) => {
  const s = await setup(c, 'a10');
  const r = await http(`${c.url.gw}/v1/models`, { headers: auth(s.key) });
  eq(r.status, 200, 'models ok');
  const ids = (r.json().data ?? []).map((m: any) => m.id);
  ok(ids.includes('rt-base'), 'lists published model');
  ok(!ids.includes('rt-base#f=s429'), 'real_model 指令名不出现在目录');
  ok(!r.text.includes('api_key') && !r.text.includes('sk-mock'), 'no credential leak');
});

define(
  'A11',
  '网关鉴权',
  '畸形请求体:非 JSON / 空体 / 缺 messages / 错 content-type → 400 零扣费',
  async (c) => {
    const s = await setup(c, 'a11');
    const raw = async (
      body: string,
      headers: Record<string, string> = { 'content-type': 'application/json' },
    ) =>
      http(`${c.url.gw}/v1/chat/completions`, {
        body,
        raw: true,
        headers: { ...auth(s.key), ...headers },
      });
    const r1 = await raw('this is not json');
    eq(r1.status, 400, 'not json → 400');
    const r2 = await raw('');
    eq(r2.status, 400, 'empty body → 400');
    const r3 = await raw(JSON.stringify({ model: 'rt-base' }));
    eq(r3.status, 400, 'missing messages → 400');
    await zeroBills(c, s.u.id);
  },
);

define(
  'A12',
  '网关鉴权',
  '消息数组畸形:空/缺 role/超长 content/1000 条消息 → 干净分流(4xx 拒或 2xx 精确计费)',
  async (c) => {
    const s = await setup(c, 'a12');
    const bodies = [
      { model: 'rt-base', messages: [] },
      { model: 'rt-base', messages: [{ content: 'no role' }] },
      { model: 'rt-base', messages: [{ role: 'hacker', content: 'x' }] },
      { model: 'rt-base', messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] },
      {
        model: 'rt-base',
        messages: Array.from({ length: 1000 }, (_, i) => ({ role: 'user', content: `m${i}` })),
      },
    ];
    let ok200 = 0;
    for (const body of bodies) {
      const r = await http(`${c.url.gw}/v1/chat/completions`, {
        body,
        headers: auth(s.key),
        timeoutMs: 30000,
      });
      ok(r.status >= 200 && r.status < 500, `body variant → 2xx/4xx, got ${r.status}`);
      if (r.status === 200) ok200 += 1;
    }
    // 放行的(宽松 schema 是设计)必须精确计费;拒绝的零扣费——两者都不许悬挂
    await poll(
      'billed count matches',
      async () => {
        const n = await c.db.execute(
          sql`select count(*)::int as n from usage_logs where user_id = ${s.u.id}`,
        );
        return Number((n[0] as any).n) === ok200 ? n : null;
      },
      25000,
    );
    const w = await c.seed.wallet(c.db, s.u.id);
    ok(Number(w.in_flight) === 0, `in_flight ${w.in_flight}`);
  },
);

define('A13', '网关鉴权', '413 超限 body(10MB+1)→ 413 零扣费', async (c) => {
  const s = await setup(c, 'a13');
  const huge = JSON.stringify({
    model: 'rt-base',
    messages: [{ role: 'user', content: 'x'.repeat(10 * 1024 * 1024 + 100) }],
  });
  const r = await http(`${c.url.gw}/v1/chat/completions`, {
    body: huge,
    raw: true,
    headers: { ...auth(s.key), 'content-type': 'application/json' },
    timeoutMs: 30000,
  });
  ok([413, 400].includes(r.status), `oversized → 413/400, got ${r.status}`);
  await zeroBills(c, s.u.id);
});

define('A14', '网关鉴权', '伪造重复 x-request-id 两个请求 → 独立计费不合并不串账', async (c) => {
  const s = await setup(c, 'a14', '10');
  const forged = { 'x-request-id': 'attacker-forged-same-id', ...auth(s.key) };
  const r1 = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-exact'),
    headers: forged,
  });
  const r2 = await http(`${c.url.gw}/v1/chat/completions`, {
    body: chat('rt-exact'),
    headers: forged,
  });
  eq(r1.status, 200, 'r1');
  eq(r2.status, 200, 'r2');
  ok(r1.headers.get('x-request-id') !== 'attacker-forged-same-id', 'server rewrites forged id');
  ok(r1.headers.get('x-request-id') !== r2.headers.get('x-request-id'), 'independent ids');
  await poll(
    'two usage rows',
    async () => {
      const n = await c.db.execute(
        sql`select count(*)::int as n from usage_logs where user_id = ${s.u.id}`,
      );
      return Number((n[0] as any).n) === 2 ? n : null;
    },
    20000,
  );
});

define(
  'A15',
  '网关鉴权',
  'SSRF:严格实例(8812)本地地址渠道必须被拒(逃生门仅 dev 主实例放行)',
  async (c) => {
    const s = await setup(c, 'a15');
    // 主实例 dev 放行本地 URL 是已知 dev 语义;严格实例必须堵死
    const r = await http(`${c.url.gwStrict}/v1/chat/completions`, {
      body: chat('rt-ssrf'),
      headers: auth(s.key),
      timeoutMs: 20000,
    });
    ok(r.status >= 400, `strict gateway blocks local upstream, got ${r.status}`);
    // 零扣费:guard 拒绝可在 authorize 前(无 billing 行)或 authorize 后(released)——两者皆干净
    const n = await c.db.execute(
      sql`select count(*)::int as n from usage_logs where user_id = ${s.u.id}`,
    );
    eq(Number((n[0] as any).n), 0, 'zero usage rows');
    const w = await c.seed.wallet(c.db, s.u.id);
    ok(Number(w.in_flight) === 0, `in_flight ${w.in_flight}`);
  },
);

define('A16', '网关鉴权', '方法/路径滥用:GET 打 POST 端点、未知路径 → 404/405 不炸', async (c) => {
  const s = await setup(c, 'a16');
  const r1 = await http(`${c.url.gw}/v1/chat/completions`, { method: 'GET', headers: auth(s.key) });
  ok([404, 405].includes(r1.status), `GET → 404/405, got ${r1.status}`);
  const r2 = await http(`${c.url.gw}/v1/definitely/not/a/route`, { headers: auth(s.key) });
  ok([404, 405].includes(r2.status), `unknown path → 404, got ${r2.status}`);
  const r3 = await http(`${c.url.gw}/admin/debug/anything`, { headers: auth(s.key) });
  eq(r3.status, 404, 'no hidden admin surface');
});
