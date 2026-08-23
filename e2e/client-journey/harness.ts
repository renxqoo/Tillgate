/**
 * E2E 装置（老仓 e2e-kit 迁移形态）：环境构造（epay 渠道 + mock GitHub 上游 +
 * capture mailer 覆盖缝）、固定端口真实 HTTP 服务、DB 播种与 FK 逆序清理、
 * 签名支付回调伪造。infra 不可达时整套 skip（fail-safe，不误报）。
 */
import { createServer, type Server } from 'node:http';
import { get } from 'node:http';
import { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
// e2e 非 workspace 成员——包名导入不可解析，统一相对源码导入
//（app/packages 自身的 @tokenlens/* 导入按其文件位置解析，不受影响）
import { sql } from 'drizzle-orm';
import { epaySign, sha256Hex } from '../../packages/billing/src/index.js';
import type { Mailer } from '../../packages/identity/src/index.js';
import type { ClientApiAssembly } from '../../apps/client-api/src/assembly.js';
import { assembleClientApi } from '../../apps/client-api/src/assembly.js';
import { loadClientApiConfig } from '../../apps/client-api/src/config.js';
import { createClientApiApp } from '../../apps/client-api/src/app.js';

/** mock GitHub OAuth 上游（Authorization Code 流的最小实现） */
export interface MockGithub {
  server: Server;
  baseUrl: string;
  /** /user 与 /user/emails 返回的身份（可变——用例内改写） */
  profile: { id: number; login: string; name: string | null; email: string };
  requests: Array<{ path: string; authorization?: string }>;
}

export async function startMockGithub(): Promise<MockGithub> {
  const state: MockGithub = {
    server: null as unknown as Server,
    baseUrl: '',
    profile: { id: 0, login: 'e2e-user', name: 'E2E User', email: '' },
    requests: [],
  };
  state.server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    state.requests.push({ path: url.pathname, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/token' && req.method === 'POST') {
      // fail-code：模拟上游换码故障（E2E 断言 502 路径）
      let body = '';
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        if (body.includes('code=fail-code')) {
          res.statusCode = 500;
          res.end('{}');
          return;
        }
        res.end(JSON.stringify({ access_token: 'mock-access-token', token_type: 'bearer' }));
      });
      return;
    }
    if (url.pathname === '/user') {
      const { email, ...rest } = state.profile;
      void email;
      res.end(JSON.stringify(rest));
      return;
    }
    if (url.pathname === '/user/emails') {
      res.end(JSON.stringify([{ email: state.profile.email, primary: true, verified: true }]));
      return;
    }
    // /authorize：真实浏览器才会访问——E2E 只断言 302 Location 指向这里
    res.statusCode = 200;
    res.end('{}');
  });
  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  state.baseUrl = `http://127.0.0.1:${(state.server.address() as AddressInfo).port}`;
  return state;
}

/** 抢一个空闲端口（identity 回调白名单要求装配前已知 apiBase——固定端口） */
export async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

export function createCaptureMailer(): Mailer & { lastCodeOf(email: string): string | null } {
  const codes = new Map<string, string>();
  return {
    async sendPasswordResetLink(to: string, url: string) {
      sent.push({ to, code: url });
    },
    async sendLoginCode(to, code) {
      codes.set(to, code);
    },
    lastCodeOf(email) {
      return codes.get(email) ?? null;
    },
  };
}

export interface E2eHarness {
  app: ReturnType<typeof createClientApiApp>;
  assembly: ClientApiAssembly;
  baseUrl: string;
  mailer: ReturnType<typeof createCaptureMailer>;
  epay: { pid: string; key: string };
  github: MockGithub | null;
  teardown(): Promise<void>;
}

export async function bootHarness(options: {
  appPort: number;
  github?: MockGithub;
}): Promise<E2eHarness> {
  const appUrl = `http://127.0.0.1:${options.appPort}`;
  const githubEndpoints = options.github
    ? {
        authorizeUrl: `${options.github.baseUrl}/authorize`,
        tokenUrl: `${options.github.baseUrl}/token`,
        profileUrl: `${options.github.baseUrl}/user`,
        emailsUrl: `${options.github.baseUrl}/user/emails`,
      }
    : undefined;
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'development',
    DATABASE_URL:
      process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    JWT_SECRET: process.env.JWT_SECRET ?? 'e2e-jwt-secret-0123456789ab',
    CLIENT_CODE_PEPPER: process.env.CLIENT_CODE_PEPPER ?? 'e2e-pepper-0123456789ab',
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? 'e2e-enc-key-0123456789ab',
    // 旅程内同邮箱多次发码——冷却与注册限频放宽为测试口径（不改产品默认）
    CLIENT_CHALLENGE_COOLDOWN_MS: '1',
    REGISTER_IP_LIMIT_PER_HOUR: '1000',
    CLIENT_CURRENCY: 'CNY',
    TOPUP_MIN: '1',
    TOPUP_MAX: '100000',
    TOPUP_EXCHANGE_RATE: '1',
    // 易支付渠道（下单纯本地计算；回调由装置伪造签名）
    EPAY_PID: 'e2e-pid',
    EPAY_KEY: 'e2e-key',
    EPAY_GATEWAY_URL: 'https://epay-mock.invalid/submit.php',
    EPAY_NOTIFY_URL: `${appUrl}/v1/payments/notify/epay`,
    EPAY_RETURN_URL: `${appUrl}/v1/payments/return`,
    EPAY_PAY_TYPE: 'alipay',
    // GitHub 社交登录（mock 上游端点覆盖）
    ...(githubEndpoints != null
      ? {
          OAUTH_FRONTEND_URL: `${appUrl}/app`,
          OAUTH_API_BASE: appUrl,
          OAUTH_GITHUB_CLIENT_ID: 'e2e-client-id',
          OAUTH_GITHUB_CLIENT_SECRET: 'e2e-client-secret',
          OAUTH_GITHUB_ENDPOINTS_JSON: JSON.stringify(githubEndpoints),
        }
      : {}),
  };
  const config = loadClientApiConfig(env);
  const mailer = createCaptureMailer();
  const assembly = await assembleClientApi(config, { mailer });
  const app = createClientApiApp(assembly.deps);
  await new Promise<void>((resolve) => {
    serve({ fetch: app.fetch, port: options.appPort, hostname: '127.0.0.1' }, () => resolve());
  });
  return {
    app,
    assembly,
    baseUrl: appUrl,
    mailer,
    epay: { pid: env.EPAY_PID as string, key: env.EPAY_KEY as string },
    github: options.github ?? null,
    teardown: async () => {
      await assembly.redis.quit().catch(() => undefined);
      await assembly.otel.shutdown().catch(() => undefined);
      const { closeDb } = await import('@tokenlens/db');
      await closeDb(assembly.db);
    },
  };
}

export function apiClient(baseUrl: string) {
  return (path: string, init: RequestInit & { token?: string } = {}): Promise<Response> => {
    const { token, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (token != null) headers.set('authorization', `Bearer ${token}`);
    if (rest.body != null && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return fetch(`${baseUrl}${path}`, { ...rest, headers });
  };
}

/** 注册两步制走完 → 返回 {token, userId}（capture mailer 收码） */
export async function registerUser(
  h: E2eHarness,
  api: ReturnType<typeof apiClient>,
  email: string,
  password: string,
): Promise<{ token: string; userId: number }> {
  const reg = (await (
    await api('/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
  ).json()) as { challengeId: string };
  const ver = await api('/v1/auth/register/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: reg.challengeId, code: h.mailer.lastCodeOf(email) }),
  });
  if (ver.status !== 201) throw new Error(`register failed: ${await ver.text()}`);
  const body = (await ver.json()) as { token: string; userId: number };
  return { token: body.token, userId: body.userId };
}

/** 播种：管理员兜底行 + 兑换码批次（返回码哈希入表） */
export async function seedRedeemCode(
  db: ClientApiAssembly['db'],
  code: string,
  amount: string,
): Promise<void> {
  await db.execute(
    sql`insert into admins (email, password_hash, status)
        values ('e2e-admin@tokenlens.invalid', 'e2e:unused:1:1:1', 0)
        on conflict (email) do nothing`,
  );
  // admins 必填 email/password_hash——播种专用行（cleanupSeeds 按 email 回收）
  await db.execute(
    sql`insert into redeem_batches (name, amount, total, used_count, created_by)
        values ('e2e-batch', ${amount}, 1, 0, (
          select id from admins where email = 'e2e-admin@tokenlens.invalid'
        ))`,
  );
  await db.execute(
    sql`insert into redeem_codes (batch_id, code_hash, status)
        select id, ${sha256Hex(code)}, 0 from redeem_batches where name = 'e2e-batch'
          and not exists (select 1 from redeem_codes where code_hash = ${sha256Hex(code)})`,
  );
}

/** 播种套餐（kind='subscription'；allowSeats 团队档） → 返回 id */
export async function seedPlan(
  db: ClientApiAssembly['db'],
  name: string,
  allowSeats: boolean,
): Promise<number> {
  const result = await db.execute(
    sql`insert into plans (name, kind, sort_order, price, period_days, quota_amount, allow_seats, status)
        values (${name}, 'subscription', 9, '1', 30, '10', ${allowSeats}, 0)
        returning id`,
  );
  const rows = result.rows as Array<{ id: number | string }>;
  const id = Number(rows[0]?.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('plan seed failed');
  return id;
}

/** 不跟随重定向的 GET（fetch redirect:'manual' 是 opaqueredirect 拿不到 Location） */
export function rawGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** 伪造已签名的 epay 成功回调表单（金额篡改即验签失败） */
export async function sendEpayNotify(
  api: ReturnType<typeof apiClient>,
  baseUrl: string,
  epay: { pid: string; key: string },
  orderId: string,
  money: string,
): Promise<{ status: number; text: string }> {
  const params: Record<string, string> = {
    pid: epay.pid,
    type: 'alipay',
    out_trade_no: orderId,
    trade_no: `mock-trade-${orderId.slice(0, 8)}`,
    trade_status: 'TRADE_SUCCESS',
    money,
  };
  params.sign = epaySign(params, epay.key);
  params.sign_type = 'MD5';
  const res = await api('/v1/payments/notify/epay', {
    method: 'POST',
    body: new URLSearchParams(params).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  void baseUrl;
  return { status: res.status, text: await res.text() };
}

/** 用户级钱包余额（CNY 账户；无账户 = '0'） */
export async function walletBalance(
  api: ReturnType<typeof apiClient>,
  token: string,
): Promise<string> {
  const res = await api('/v1/wallet/accounts', { token });
  const body = (await res.json()) as {
    accounts: Array<{ currency: string; balance: string }>;
  };
  return body.accounts.find((a) => a.currency === 'CNY')?.balance ?? '0';
}

/** FK 逆序 best-effort 清理（无级联删除；失败仅忽略） */
export async function cleanupUsers(
  db: ClientApiAssembly['db'],
  users: Array<{ id: number; email: string }>,
): Promise<void> {
  for (const { id: uid, email: mail } of users) {
    // 钱包：DO 块内先收集用户账户关联交易集合，再删腿→删交易→删账户
    // （uid 是本装置创建的自增 id，Number 校验后内联；镜像内部腿一并清理）
    const safeUid = Number(uid);
    await db
      .execute(
        sql.raw(`do $$ declare uid bigint := ${safeUid}; begin
          create temp table if not exists e2e_tx on commit drop as
            select distinct transaction_id as id from wallet_legs
            where account_id in (select id from wallet_accounts where user_id = uid);
          delete from wallet_legs where transaction_id in (select id from e2e_tx);
          delete from wallet_transactions where id in (select id from e2e_tx);
          drop table e2e_tx;
          delete from wallet_accounts where user_id = uid;
        end $$;`),
      )
      .catch(() => undefined);
    const statements = [
      sql`delete from payment_orders where user_id = ${uid}`,
      sql`delete from user_subscriptions where user_id = ${uid} or org_id in (
            select id from organizations where owner_user_id = ${uid})`,
      sql`delete from api_keys where user_id = ${uid}`,
      sql`delete from org_members where user_id = ${uid} or org_id in (
            select id from organizations where owner_user_id = ${uid})`,
      sql`delete from org_invitations where org_id in (
            select id from organizations where owner_user_id = ${uid}) or email = ${mail}`,
      sql`delete from organizations where owner_user_id = ${uid}`,
      sql`delete from identity_passwords where user_id = ${uid}`,
      sql`delete from identity_oauth_links where user_id = ${uid}`,
      sql`delete from identity_credentials where user_id = ${uid}
          or (identifier_kind = 'email' and identifier_value = ${mail})`,
      sql`delete from identity_session_anchors where user_id = ${uid}`,
      sql`delete from identity_challenges where identifier_value = ${mail}`,
      sql`delete from users where id = ${uid}`,
    ];
    for (const statement of statements) {
      await db.execute(statement).catch(() => undefined);
    }
  }
}

/** 套件级播种物清理 */
export async function cleanupSeeds(db: ClientApiAssembly['db']): Promise<void> {
  const statements = [
    sql`delete from redeem_codes where batch_id in (select id from redeem_batches where name = 'e2e-batch')`,
    sql`delete from redeem_batches where name = 'e2e-batch'`,
    sql`delete from admins where email = 'e2e-admin@tokenlens.invalid'`,
    sql`delete from plans where name in ('e2e-personal', 'e2e-team')`,
  ];
  for (const statement of statements) {
    await db.execute(statement).catch(() => undefined);
  }
}

/** 基础设施探测（PG + Redis 双可达才跑） */
export async function infraReady(): Promise<boolean> {
  try {
    const { createDb, ping, closeDb } = await import('../../packages/db/src/index.js');
    const db = createDb({
      url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
      poolMax: 1,
      idleTimeoutMillis: 1_000,
      connectionTimeoutMillis: 3_000,
      maxUses: 10,
    });
    await ping(db);
    await closeDb(db);
    const { createRedisClient, assertRedisReachable } =
      await import('../../packages/runtime/src/index.js');
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const redis = createRedisClient(redisUrl, {
      serviceName: 'e2e-journey-probe',
      logThrottleMs: 1_000,
    });
    await assertRedisReachable(redis, 'e2e-journey-probe', redisUrl, 3_000);
    await redis.quit().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}
