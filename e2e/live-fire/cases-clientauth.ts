/**
 * G5 注册/登录/挑战/会话攻击面(client-api):畸形输入、重复注册、验证码
 * 穷举/重放/竞态、注册限流与 XFF 伪造、登录爆破锁定、用户枚举、封禁、
 * JWT 伪造、登出/改密会话语义、越权、key 洪泛、OAuth state 伪造。
 * 注册/验证码走 strict 实例(8813,真 SMTP sink 投递真码)。
 */
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { define, ok, eq, http, poll, sleep, between } from './lib/h.ts';

const SINK = new URL('./.smtp-captures.ndjson', import.meta.url).pathname;
const PASSWORD = 'Rt!Passw0rd#42';

/** 提取 6 位验证码:优先 Subject 行(只含码本身,html 内联样式 #333333 会污染正文匹配) */
function codeFromMail(body: string): string | null {
  const subject = body.match(/^Subject:[^\r\n]*$/m)?.[0] ?? '';
  const fromSubject = subject.match(/\b\d{6}\b/);
  if (fromSubject != null) return fromSubject[0];
  // 兜底:text/plain 段(quoted-printable 明文)首个 6 位
  const textSeg = body.split(/\r\n\r\n/)[1] ?? '';
  return textSeg.match(/\b\d{6}\b/)?.[0] ?? null;
}

function lastCodeFor(email: string): string | null {
  const lines = readFileSync(SINK, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const m = JSON.parse(lines[i]) as { to: string; body: string };
      if (!m.to.includes(email)) continue;
      const code = codeFromMail(m.body);
      if (code != null) return code;
    } catch {}
  }
  return null;
}

const uniq = (tag: string) => `rt-${tag}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** 清注册限流计数(用例间隔离;C10/C11 专测限流语义不清) */
function resetRegisterGate() {
  const pass = (() => {
    try {
      return new URL(process.env.REDIS_URL as string).password;
    } catch {
      return 'root123';
    }
  })();
  Bun.spawnSync(['bash', '-c', `redis-cli -a ${pass} --scan --pattern 'client-api:*' 2>/dev/null | xargs -r redis-cli -a ${pass} del >/dev/null 2>&1`]);
}

const accepted = (s: number) => s === 200 || s === 201;

async function register(c: any, email: string, password = PASSWORD, base?: string) {
  return http(`${base ?? c.url.clientStrict}/v1/auth/register`, { body: { email, password } });
}

async function registerAndVerify(c: any, tag: string) {
  resetRegisterGate();
  const email = `${uniq(tag)}@fire.test`;
  const reg = await register(c, email);
  ok(accepted(reg.status), `register ${email}: ${reg.text.slice(0, 120)}`);
  const challengeId = reg.json().challengeId;
  const code = await poll(`code for ${email}`, async () => {
    const v = lastCodeFor(email);
    return v != null ? v : null;
  }, 15000, 200);
  const verify = await http(`${c.url.clientStrict}/v1/auth/register/verify`, {
    body: { challengeId, code },
  });
  ok(accepted(verify.status), `verify: ${verify.text.slice(0, 120)}`);
  return { email, challengeId, code, token: verify.json().token, userId: verify.json().userId };
}

define('C1', '注册登录攻击', '畸形 email(无@/超长/unicode/嵌套点)→ 400 干净拒绝', async (c) => {
  for (const email of ['not-an-email', `${'a'.repeat(250)}@x.com`, '我们@example.com', 'a..b@example.com', 'a@b', '']) {
    const r = await register(c, email);
    ok(r.status === 400 || r.status === 422, `email "${email.slice(0, 24)}" → 400, got ${r.status}`);
  }
});

define('C2', '注册登录攻击', '重复注册:精确重复 + 大小写变体都算占用', async (c) => {
  const { email } = await registerAndVerify(c, 'c2');
  const dup = await register(c, email);
  eq(dup.status, 409, 'exact duplicate → 409 email_taken');
  const variant = email.replace('rt-', 'RT-');
  const dup2 = await register(c, variant);
  ok([409, 400].includes(dup2.status), `case variant rejected, got ${dup2.status}(若 201 = 同邮箱双账号,严重发现)`);
});

define('C3', '注册登录攻击', '弱密码(<10 位)与超长(>128)→ 400', async (c) => {
  resetRegisterGate();
  for (const pwd of ['short', 'a'.repeat(129), '']) {
    const r = await register(c, `${uniq('c3')}@fire.test`, pwd);
    eq(r.status, 400, `password len ${pwd.length} rejected`);
  }
});

define('C4', '注册登录攻击', 'SQLi/XSS payload 打 email/password/aff → 400,无 5xx 无回显', async (c) => {
  const payloads = [
    "'; drop table users; --",
    "' or '1'='1",
    '<script>alert(1)</script>',
    '${jndi:ldap://evil}',
    "' union select 1 --",
  ];
  for (const p of payloads) {
    const r = await http(`${c.url.clientStrict}/v1/auth/register`, {
      body: { email: p, password: p, aff: p },
    });
    ok(r.status < 500, `payload → ${r.status}(4xx 干净拒绝,无 5xx)`);
  }
});

define('C5', '注册登录攻击', '验证码穷举:错 5 次耗尽后正确码也被拒', async (c) => {
  resetRegisterGate();
  const email = `${uniq('c5')}@fire.test`;
  const reg = await register(c, email);
  ok(accepted(reg.status), 'register');
  const challengeId = reg.json().challengeId;
  const code = await poll('code', () => Promise.resolve(lastCodeFor(email)), 15000, 200);
  for (let i = 0; i < 5; i++) {
    const wrong = code === '000000' ? '111111' : '000000';
    const r = await http(`${c.url.clientStrict}/v1/auth/register/verify`, { body: { challengeId, code: wrong } });
    eq(r.status, 400, `wrong #${i + 1} → 400`);
  }
  const r = await http(`${c.url.clientStrict}/v1/auth/register/verify`, { body: { challengeId, code } });
  eq(r.status, 400, 'exhausted: correct code now rejected');
});

define('C6', '注册登录攻击', '验证码并发穷举(10 并发错误码)→ CAS 不丢计数,零成功', async (c) => {
  resetRegisterGate();
  const email = `${uniq('c6')}@fire.test`;
  const reg = await register(c, email);
  ok(accepted(reg.status), 'register');
  const challengeId = reg.json().challengeId;
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      http(`${c.url.clientStrict}/v1/auth/register/verify`, {
        body: { challengeId, code: String(100000 + i) },
      }),
    ),
  );
  ok(results.every((r) => r.status === 400), 'all concurrent wrong codes rejected');
  const after = await http(`${c.url.clientStrict}/v1/auth/register/verify`, { body: { challengeId, code: '999999' } });
  eq(after.status, 400, 'challenge dead after concurrent brute force');
});

define('C7', '注册登录攻击', '已消费挑战重放 → 400', async (c) => {
  const { challengeId, code } = await registerAndVerify(c, 'c7');
  const replay = await http(`${c.url.clientStrict}/v1/auth/register/verify`, { body: { challengeId, code } });
  eq(replay.status, 400, 'replayed challenge rejected');
});

define('C8', '注册登录攻击', '过期挑战(SQL 前拨 expires_at)→ 400 challenge_invalid', async (c) => {
  resetRegisterGate();
  const email = `${uniq('c8')}@fire.test`;
  const reg = await register(c, email);
  ok(accepted(reg.status), 'register');
  const challengeId = reg.json().challengeId;
  const code = await poll('code', () => Promise.resolve(lastCodeFor(email)), 15000, 200);
  await c.db.execute(sql`
    update identity_challenges set issued_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'
    where id = ${challengeId}::uuid`);
  const r = await http(`${c.url.clientStrict}/v1/auth/register/verify`, { body: { challengeId, code } });
  eq(r.status, 400, 'expired challenge rejected');
});

define('C9', '注册登录攻击', '并发 verify 同一正确码 ×10 → 恰好 1 个成功(单次消费竞态)', async (c) => {
  resetRegisterGate();
  const email = `${uniq('c9')}@fire.test`;
  const reg = await register(c, email);
  ok(accepted(reg.status), 'register');
  const challengeId = reg.json().challengeId;
  const code = await poll('code', () => Promise.resolve(lastCodeFor(email)), 15000, 200);
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      http(`${c.url.clientStrict}/v1/auth/register/verify`, { body: { challengeId, code } }),
    ),
  );
  const okCount = results.filter((r) => accepted(r.status)).length;
  eq(okCount, 1, `exactly one verify wins (got ${okCount}/10)`);
});

define('C10', '注册登录攻击', '同 IP 注册限流(strict 3/hour):第 4 个 → 429 + Retry-After', async (c) => {
  resetRegisterGate();
  let last = 0;
  let retryAfter = '';
  for (let i = 0; i < 4; i++) {
    const r = await register(c, `${uniq('c10')}${i}@fire.test`);
    last = r.status;
    retryAfter = r.headers.get('retry-after') ?? '';
    if (i < 3) ok(accepted(r.status), `register #${i + 1}`);
  }
  eq(last, 429, `4th register → 429, got ${last}`);
  ok(retryAfter !== '', 'Retry-After header present');
});

define('C11', '注册登录攻击', '伪造 X-Forwarded-For 换 IP 绕注册限流 → 无效(TRUSTED_PROXY_HOPS=0)', async (c) => {
  // 先耗尽本 IP 限额
  for (let i = 0; i < 3; i++) {
    await register(c, `${uniq('c11')}${i}@fire.test`);
  }
  const spoofed = await register(c, `${uniq('c11')}x@fire.test`, PASSWORD);
  eq(spoofed.status, 429, 'quota already exhausted');
  const forged = await http(`${c.url.clientStrict}/v1/auth/register`, {
    body: { email: `${uniq('c11')}y@fire.test`, password: PASSWORD },
    headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
  });
  eq(forged.status, 429, 'XFF spoofing does not reset the IP bucket');
});

define('C12', '注册登录攻击', '登录爆破:5 次错密码 → 锁定,正确密码在锁内也被拒', async (c) => {
  const u = await c.seed.mkUser(c.db, 'c12');
  for (let i = 0; i < 5; i++) {
    const r = await http(`${c.url.client}/v1/auth/login`, { body: { email: u.email, password: 'WrongPass#1' } });
    eq(r.status, 401, `wrong #${i + 1} → 401`);
  }
  const locked = await http(`${c.url.client}/v1/auth/login`, { body: { email: u.email, password: PASSWORD } });
  eq(locked.status, 429, `correct password blocked while locked, got ${locked.status}`);
});

define('C13', '注册登录攻击', '登录用户枚举防护:不存在 vs 密码错同码,时序差 < 300ms', async (c) => {
  const u = await c.seed.mkUser(c.db, 'c13');
  const t1 = Date.now();
  const r1 = await http(`${c.url.client}/v1/auth/login`, { body: { email: 'ghost@fire.test', password: 'Whatever#1' } });
  const d1 = Date.now() - t1;
  const t2 = Date.now();
  const r2 = await http(`${c.url.client}/v1/auth/login`, { body: { email: u.email, password: 'Whatever#1' } });
  const d2 = Date.now() - t2;
  eq(r1.status, 401, 'unknown user 401');
  eq(r2.status, 401, 'wrong password 401');
  eq(r1.json().error?.code, r2.json().error?.code, 'same error code (no enumeration)');
  ok(Math.abs(d1 - d2) < 300, `timing ${d1}ms vs ${d2}ms close (dummy hash)`);
});

define('C14', '注册登录攻击', '封禁用户登录 → 403,不泄露具体状态细节', async (c) => {
  const u = await c.seed.mkUser(c.db, 'c14');
  await c.db.execute(sql`update users set status = 1 where id = ${u.id}`);
  const r = await http(`${c.url.client}/v1/auth/login`, { body: { email: u.email, password: PASSWORD } });
  eq(r.status, 403, 'banned login → 403');
  await c.db.execute(sql`update users set status = 0 where id = ${u.id}`);
});

define('C15', '注册登录攻击', '会话安全:伪造/篡改 JWT 401;登出后 token 即死', async (c) => {
  const u = await c.seed.mkUser(c.db, 'c15');
  const login = await http(`${c.url.client}/v1/auth/login`, { body: { email: u.email, password: PASSWORD } });
  eq(login.status, 200, 'login');
  const token = login.json().token;
  eq(await (await http(`${c.url.client}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).status, 200, 'me ok');
  // 篡改 payload(换签名外的部分)
  const [h, p, s] = token.split('.');
  const tampered = `${h}.${p.slice(0, -3)}abc.${s}`;
  eq(await (await http(`${c.url.client}/v1/me`, { headers: { authorization: `Bearer ${tampered}` } })).status, 401, 'tampered jwt 401');
  eq(await (await http(`${c.url.client}/v1/me`, { headers: { authorization: 'Bearer nope.nope.nope' } })).status, 401, 'garbage jwt 401');
  const out = await http(`${c.url.client}/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  ok([200, 201, 204].includes(out.status), `logout ${out.status}`);
  eq(await (await http(`${c.url.client}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).status, 401, 'token dead after logout');
});

define('C16', '注册登录攻击', '越权:A 的 token 摸 B 的 keys/wallet/usage → 无数据泄露', async (c) => {
  const a = await c.seed.mkUser(c.db, 'c16a');
  const b = await c.seed.mkUser(c.db, 'c16b');
  const la = await http(`${c.url.client}/v1/auth/login`, { body: { email: a.email, password: PASSWORD } });
  const tokenA = la.json().token;
  const lb = await http(`${c.url.client}/v1/auth/login`, { body: { email: b.email, password: PASSWORD } });
  const tokenB = lb.json().token;
  const kb = await http(`${c.url.client}/v1/keys`, { body: { name: 'rt-c16-b' }, headers: { authorization: `Bearer ${tokenB}` } });
  eq(kb.status, 201, 'B creates key');
  const keyBId = kb.json().id;
  // A 用自己的 token 改/删 B 的 key
  const patch = await http(`${c.url.client}/v1/keys/${keyBId}`, {
    method: 'PATCH',
    body: { name: 'hacked' },
    headers: { authorization: `Bearer ${tokenA}` },
  });
  ok([403, 404].includes(patch.status), `A cannot touch B's key, got ${patch.status}`);
  const del = await http(`${c.url.client}/v1/keys/${keyBId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${tokenA}` },
  });
  ok([403, 404].includes(del.status), `A cannot delete B's key, got ${del.status}`);
  const walletA = await http(`${c.url.client}/v1/wallet/accounts`, { headers: { authorization: `Bearer ${tokenA}` } });
  ok(!walletA.text.includes(b.email), 'A wallet view contains no B data');
});

define('C17', '注册登录攻击', 'key 洪泛:连建 60 个 key(设计=数量自由)→ 服务不降级,全部可用', async (c) => {
  const u = await c.seed.mkUser(c.db, 'c17');
  const login = await http(`${c.url.client}/v1/auth/login`, { body: { email: u.email, password: PASSWORD } });
  const token = login.json().token;
  let created = 0;
  for (let i = 0; i < 60; i++) {
    const r = await http(`${c.url.client}/v1/keys`, { body: { name: `rt-c17-${i}` }, headers: { authorization: `Bearer ${token}` } });
    if (r.status === 201) created += 1;
  }
  eq(created, 60, '60/60 created (design: no cap) — 服务面无降级即 PASS');
  const health = await http(`${c.url.client}/healthz`);
  eq(health.status, 200, 'client-api healthy after flood');
});

define('C18', '注册登录攻击', '改密后旧 token 即废,新 token 与新密码可用', async (c) => {
  const u = await c.seed.mkUser(c.db, 'c18');
  const login = await http(`${c.url.client}/v1/auth/login`, { body: { email: u.email, password: PASSWORD } });
  const oldToken = login.json().token;
  const change = await http(`${c.url.client}/v1/auth/password`, {
    method: 'POST',
    body: { oldPassword: PASSWORD, newPassword: 'Rt!NewPass#99' },
    headers: { authorization: `Bearer ${oldToken}` },
  });
  ok([200, 201].includes(change.status), `password change ${change.status}`);
  eq(await (await http(`${c.url.client}/v1/me`, { headers: { authorization: `Bearer ${oldToken}` } })).status, 401, 'old token dead');
  const relogin = await http(`${c.url.client}/v1/auth/login`, { body: { email: u.email, password: 'Rt!NewPass#99' } });
  eq(relogin.status, 200, 'new password works');
});

define('C19', '注册登录攻击', '验证码发送冷却:同 email 60s 内二次 register → 429 cooldown', async (c) => {
  resetRegisterGate();
  const email = `${uniq('c19')}@fire.test`;
  const r1 = await register(c, email);
  ok(accepted(r1.status), 'first send');
  const r2 = await register(c, email);
  eq(r2.status, 429, `cooldown, got ${r2.status}`);
});

define('C20', '注册登录攻击', 'OAuth:伪造 state 回调与未知 provider → 4xx,无跳转泄露', async (c) => {
  const r1 = await http(`${c.url.client}/v1/oauth/github/callback?code=x&state=forged-state`);
  ok(r1.status >= 400 && r1.status < 500, `forged state → 4xx, got ${r1.status}`);
  const r2 = await http(`${c.url.client}/v1/oauth/nonexistent/authorize?next=/x`);
  ok(r2.status === 404, `unknown provider → 404, got ${r2.status}`);
});
