/**
 * E2E 装置（老仓 e2e-kit 迁移形态）：环境构造（epay 渠道 + mock GitHub 上游 +
 * capture mailer 覆盖缝）、固定端口真实 HTTP 服务、DB 播种与 FK 逆序清理、
 * 签名支付回调伪造。infra 不可达时整套 skip（fail-safe，不误报）。
 */
import { createServer, type Server } from 'node:http';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
// e2e 非 workspace 成员——包名导入不可解析，统一相对源码导入
//（app/packages 自身的 @tillgate/* 导入按其文件位置解析，不受影响）
import { sql } from 'drizzle-orm';
import { epaySign, sha256Hex } from '../../packages/billing/src/index.js';
import type { Mailer } from '../../packages/identity/src/index.js';
import type { ClientApiAssembly } from '../../apps/client-api/src/assembly.js';
import { assembleClientApi } from '../../apps/client-api/src/assembly.js';
import { loadClientApiConfig } from '../../apps/client-api/src/config.js';
import { createClientApiApp } from '../../apps/client-api/src/app.js';
import { closeDb, createDb } from '../../packages/db/src/index.js';
import { createCipher } from '../../packages/runtime/src/index.js';
import { postgresIntegrationSettingsStore } from '../../packages/control-plane/src/adapters/postgres/integration-settings-store.js';

// 测试内替代非空断言的统一收窄手段：值缺失时抛出带定位信息的错误而非静默断言
export function defined<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

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
    // github 身份 id 随机化：find-or-create 按 (provider, id) 匹配——恒 0 会
    // 命中共享开发库里历史运行的同身份用户（旧邮箱/旧属主串扰断言）。
    profile: {
      id: Number(`${Date.now()}`.slice(-9)),
      login: 'e2e-user',
      name: 'E2E User',
      email: '',
    },
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
  await new Promise<void>((resolve) => {
    state.server.listen(0, '127.0.0.1', resolve);
  });
  state.baseUrl = `http://127.0.0.1:${(state.server.address() as AddressInfo).port}`;
  return state;
}

/** 抢一个空闲端口（identity 回调白名单要求装配前已知 apiBase——固定端口） */
export async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    probe.close(() => resolve());
  });
  return port;
}

export function createCaptureMailer(): Mailer & { lastCodeOf(email: string): string | null } {
  const codes = new Map<string, string>();
  // 修复 HEAD 存量潜伏 bug：sent 未声明——sendPasswordResetLink 一被调用即
  // ReferenceError（此前 e2e 无该路径调用方而未暴露；声明后照原意记录投递）
  const sent: Array<{ to: string; code: string }> = [];
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

/** GitHub OAuth 端点覆盖组（OAUTH_GITHUB_ENDPOINTS_JSON 的结构形状） */
interface GithubEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  profileUrl: string;
  emailsUrl: string;
}

/** harness 专用 env（装置口径全量平铺——线性装配数据，从 bootHarness 拆出控函数行数） */
function buildHarnessEnv(appUrl: string, githubEndpoints?: GithubEndpoints): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    DATABASE_URL:
      process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/tillgate',
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
    // OAuth 基地址（env 域，0088 起）：回调白名单/authorize 重定向按 harness 实例地址
    OAUTH_API_BASE: appUrl,
    OAUTH_FRONTEND_URL: appUrl,
    // GitHub 社交登录：凭据/基地址经 DB 种子（seedIntegrationSettings——动态配置真路径）；
    // mock 上游端点覆盖保持 env（ENDPOINTS_JSON 是 env 专属逃生门）
    ...(githubEndpoints != null
      ? { OAUTH_GITHUB_ENDPOINTS_JSON: JSON.stringify(githubEndpoints) }
      : {}),
  };
}

/** 易支付旅程凭据（下单纯本地计算；回调由装置伪造签名——seed 进集成设置） */
const EPAY = {
  pid: 'e2e-pid',
  key: 'e2e-key',
  gatewayUrl: 'https://epay-mock.invalid/submit.php',
  payType: 'alipay',
} as const;

/**
 * 集成种子（动态配置真路径——测试侧的导入脚本口径）：upsert 覆盖旧行
 * （端口随机，每次旅程重写回调基地址）；secret 以 enc:v1 密文落库（与生产存储同形）。
 * OAuth 两行仅 GitHub 旅程种入；易支付行恒种（充值旅程回调按其伪造签名）。
 * 共库纪律：种前快照旧行，返回还原函数——旅程结束原样写回（无行删行），
 * 开发库的导入值不被随机端口污染。
 */
async function seedIntegrationSettings(
  env: NodeJS.ProcessEnv,
  appUrl: string,
  withGithub: boolean,
  epayRotation?: { previousKey: string; rotatedAgoMs: number },
): Promise<() => Promise<void>> {
  const db = createDb({
    url: env.DATABASE_URL as string,
    poolMax: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    maxUses: 5_000,
  });
  // 全量快照 + 未种子键清空：旅程期间集成状态完全受控（共享开发库的其他行不泄入断言）
  const allKeys = [
    'oauth.github',
    'oauth.google',
    'smtp',
    'captcha.turnstile',
    'payment.epay',
    'payment.stripe',
  ];
  const seededKeys = withGithub
    ? new Set(['oauth.github', 'payment.epay', 'smtp'])
    : new Set(['payment.epay', 'smtp']);
  const previous = await snapshotRows(db, allKeys);
  try {
    const cipher = createCipher(env.ENCRYPTION_KEY as string);
    if (withGithub) {
      await postgresIntegrationSettingsStore.upsert(db, {
        key: 'oauth.github',
        enabled: true,
        config: {
          clientId: 'e2e-client-id',
          clientSecret: cipher.encrypt('e2e-client-secret'),
        },
        previousSecrets: null,
        rotatedAt: null,
        adminId: null,
      });
    }
    await postgresIntegrationSettingsStore.upsert(db, {
      key: 'payment.epay',
      enabled: true,
      config: {
        pid: EPAY.pid,
        key: cipher.encrypt(EPAY.key),
        gatewayUrl: EPAY.gatewayUrl,
        notifyUrl: `${appUrl}/v1/payments/notify/epay`,
        returnUrl: `${appUrl}/v1/payments/return`,
        payType: EPAY.payType,
      },
      // 轮换双读窗装置：旧密钥入 previous_secrets，rotatedAt 按注入偏移
      previousSecrets:
        epayRotation != null ? { key: cipher.encrypt(epayRotation.previousKey) } : null,
      rotatedAt: epayRotation != null ? new Date(Date.now() - epayRotation.rotatedAgoMs) : null,
      adminId: null,
    });
    // SMTP 集成行（假凭据）：动态化后两级登录可用性 = smtp.effective；
    // 实际投递被 bootHarness 的 captureMailer 覆盖缝截获，不触网
    await postgresIntegrationSettingsStore.upsert(db, {
      key: 'smtp',
      enabled: true,
      config: {
        host: 'smtp.e2e.invalid',
        port: '465',
        user: 'e2e@tillgate.invalid',
        pass: cipher.encrypt('e2e-smtp-pass'),
      },
      previousSecrets: null,
      rotatedAt: null,
      adminId: null,
    });
    for (const key of allKeys) {
      if (!seededKeys.has(key)) {
        await db.execute(sql`delete from integration_settings where key = ${key}`);
      }
    }
  } finally {
    await closeDb(db).catch(() => {});
  }
  return async () => {
    await restoreRows(env, previous);
  };
}

/** 种前快照（行原样或无行哨兵 null） */
async function snapshotRows(
  db: ReturnType<typeof createDb>,
  keys: readonly string[],
): Promise<
  Array<{
    key: string;
    row: Awaited<ReturnType<typeof postgresIntegrationSettingsStore.readAll>>[number] | null;
  }>
> {
  const rows = await postgresIntegrationSettingsStore.readAll(db);
  return keys.map((key) => ({ key, row: rows.find((r) => r.key === key) ?? null }));
}

/** 拆时还原（原样写回；原无行删行） */
async function restoreRows(
  env: NodeJS.ProcessEnv,
  previous: Array<{
    key: string;
    row: Awaited<ReturnType<typeof postgresIntegrationSettingsStore.readAll>>[number] | null;
  }>,
): Promise<void> {
  const db = createDb({
    url: env.DATABASE_URL as string,
    poolMax: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    maxUses: 5_000,
  });
  try {
    for (const entry of previous) {
      if (entry.row != null) {
        await postgresIntegrationSettingsStore.upsert(db, {
          key: entry.row.key,
          enabled: entry.row.enabled,
          config: entry.row.config as Record<string, unknown>,
          previousSecrets: entry.row.previousSecrets as Record<string, string> | null,
          rotatedAt: entry.row.rotatedAt,
          adminId: entry.row.updatedByAdminId,
        });
      } else {
        await db.execute(sql`delete from integration_settings where key = ${entry.key}`);
      }
    }
  } finally {
    await closeDb(db).catch(() => {});
  }
}

export async function bootHarness(options: {
  appPort: number;
  github?: MockGithub;
  /** epay 验签密钥轮换装置（双读窗 e2e 用；缺省无轮换） */
  epayRotation?: { previousKey: string; rotatedAgoMs: number };
}): Promise<E2eHarness> {
  const appUrl = `http://127.0.0.1:${options.appPort}`;
  const githubEndpoints: GithubEndpoints | undefined = options.github
    ? {
        authorizeUrl: `${options.github.baseUrl}/authorize`,
        tokenUrl: `${options.github.baseUrl}/token`,
        profileUrl: `${options.github.baseUrl}/user`,
        emailsUrl: `${options.github.baseUrl}/user/emails`,
      }
    : undefined;
  const env = buildHarnessEnv(appUrl, githubEndpoints);
  const restoreIntegrations = await seedIntegrationSettings(
    env,
    appUrl,
    githubEndpoints != null,
    options.epayRotation,
  );
  const config = loadClientApiConfig(env);
  const mailer = createCaptureMailer();
  const assembly = await assembleClientApi(config, { mailer });
  // reader 预热：latest() 首调返回全关快照（后台异步刷新）——boot 后立即
  // 查询 providers 会拿到 []。旅程断言在种子后即时生效，先同步 resolve() 一次。
  await assembly.integrationReader.resolve().catch(() => {});
  const app = createClientApiApp(assembly.deps);
  await new Promise<void>((resolve) => {
    serve({ fetch: app.fetch, port: options.appPort, hostname: '127.0.0.1' }, () => resolve());
  });
  return {
    app,
    assembly,
    baseUrl: appUrl,
    mailer,
    epay: { pid: EPAY.pid, key: EPAY.key },
    github: options.github ?? null,
    teardown: async () => {
      await assembly.redis.quit().catch(() => {});
      await assembly.otel.shutdown().catch(() => {});
      const { closeDb } = await import('@tillgate/db');
      // 装置缺陷修复（review E）：closeDb 失败不跳过集成行还原
      await closeDb(assembly.db).catch(() => {});
      // 共库纪律：还原种前快照（开发库导入值不被随机端口污染）
      await restoreIntegrations();
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

/** 注册两步制走完 → 返回 {token, userId}（capture mailer 收码；api 客户端由 harness 派生——无状态 fetch 封装） */
export async function registerUser(
  h: E2eHarness,
  email: string,
  password: string,
): Promise<{ token: string; userId: number }> {
  const api = apiClient(h.baseUrl);
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
  // admins.role_id NOT NULL（迁移 0082 起）——播种行挂 super_admin（缺 role_id 触发 23502）；
  // 凭据列已随 0089 退役（单一真相在 identity 七表）——占位行仅需 email/status/role_id
  await db.execute(
    sql`insert into admins (email, status, role_id)
        values ('e2e-admin@tillgate.invalid', 0,
          (select id from roles where code = 'super_admin' limit 1))
        on conflict (email) do nothing`,
  );
  // 播种专用行（cleanupSeeds 按 email 回收）
  await db.execute(
    sql`insert into redeem_batches (name, amount, total, used_count, created_by)
        values ('e2e-batch', ${amount}, 1, 0, (
          select id from admins where email = 'e2e-admin@tillgate.invalid'
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
  const rows = result as Array<{ id: number | string }>;
  const id = Number(rows[0]?.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('plan seed failed');
  return id;
}

/** 不跟随重定向的 GET（fetch redirect:'manual' 是 opaqueredirect 拿不到 Location） */
export function rawGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
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

/** epay 回防伪签上下文（渠道凭据 + 订单定位与金额——聚合以控制参数个数） */
interface EpayNotifyInput {
  epay: { pid: string; key: string };
  orderId: string;
  money: string;
}

/** 伪造已签名的 epay 成功回调表单（金额篡改即验签失败） */
export async function sendEpayNotify(
  api: ReturnType<typeof apiClient>,
  input: EpayNotifyInput,
): Promise<{ status: number; text: string }> {
  const { epay, orderId, money } = input;
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
      .catch(() => {});
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
      await db.execute(statement).catch(() => {});
    }
  }
}

/** 套件级播种物清理 */
export async function cleanupSeeds(db: ClientApiAssembly['db']): Promise<void> {
  const statements = [
    sql`delete from redeem_codes where batch_id in (select id from redeem_batches where name = 'e2e-batch')`,
    sql`delete from redeem_batches where name = 'e2e-batch'`,
    sql`delete from admins where email = 'e2e-admin@tillgate.invalid'`,
    sql`delete from plans where name in ('e2e-personal', 'e2e-team')`,
  ];
  for (const statement of statements) {
    await db.execute(statement).catch(() => {});
  }
}

/** 基础设施探测（PG + Redis 双可达才跑） */
export async function infraReady(): Promise<boolean> {
  try {
    const { createDb, ping, closeDb } = await import('../../packages/db/src/index.js');
    const db = createDb({
      url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/tillgate',
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
    await redis.quit().catch(() => {});
    return true;
  } catch {
    return false;
  }
}
