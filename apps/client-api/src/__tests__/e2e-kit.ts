/**
 * client-api E2E 共享基建：真服务进程（全真装配：真 DB/真计费/真 epay 签名）+
 * 造数/清理台账 + HTTP 助手。与 gateway 的 e2e-kit 同哲学：
 * 不 mock 业务，只注入测试凭证（epay 商户密钥 / OAuth mock 端点）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { inArray } from 'drizzle-orm';
import {
  admins,
  apiKeys,
  apps,
  orgInvitations,
  orgMembers,
  organizations,
  paymentOrders,
  plans,
  redeemBatches,
  redeemCodes,
  usageLogs,
  userSubscriptions,
  users,
} from '@ai-gateway/db';
import { createDb } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { Decimal } from '@ai-gateway/domain';
import { assembleClientApi } from '../assembly.js';
import { createApp } from '../app.js';
import type { ClientApiConfig } from '../config.js';
import { epaySign } from '../domain/epay.js';

export const E2E_JWT = 'cav2-e2e-jwt-secret-0123456789abcdef';
export const EPAY_TEST = {
  pid: '9001',
  key: 'e2e-epay-merchant-key',
  gatewayUrl: 'https://pay.e2e.test/submit.php',
  notifyUrl: 'http://127.0.0.1:1/v1/payments/notify/epay',
  returnUrl: 'https://console.e2e.test/wallet',
};

export function e2eDb(): Db {
  return createDb(
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
    { poolMax: 12 },
  );
}

/** E2E 基础配置（单步注册/密码登录；epay 渠道启用；真 Redis——防护/限流与生产同形态） */
export function e2eBaseConfig(): ClientApiConfig {
  return {
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    PORT: 0,
    DB_POOL_MAX: 12,
    CLIENT_CURRENCY: 'CNY',
    JWT_SECRET: E2E_JWT,
    SESSION_TTL_SECONDS: 3_600,
    REGISTER_ENABLED: true,
    GIFT_AMOUNT: '0',
    MAX_KEYS_PER_USER: 20,
    REGISTER_IP_LIMIT_PER_HOUR: 5,
    REDEEM_PER_MINUTE_LIMIT: 10,
    LOGIN_FAILURE_THRESHOLD: 5,
    LOGIN_FAILURE_WINDOW_S: 600,
    LOGIN_LOCK_S: 600,
    LOGIN_IP_FAILURE_LIMIT: 50,
    LOGIN_IP_FAILURE_WINDOW_S: 300,
    TRUSTED_PROXY_HOPS: 0,
    CORS_ORIGINS: '',
    BODY_LIMIT_BYTES: 65_536,
    TOPUP_MIN: '1',
    TOPUP_MAX: '10000',
    TOPUP_EXCHANGE_RATE: '1',
    PAYMENT_ORDER_TTL_MS: 1_800_000,
    REFERRAL_SIGNUP_BONUS: '0',
    REFERRAL_COMMISSION_RATE: '0',
    SMTP_PORT: 465,
    SECURE_COOKIE: false,
    EPAY_PID: EPAY_TEST.pid,
    EPAY_KEY: EPAY_TEST.key,
    EPAY_GATEWAY_URL: EPAY_TEST.gatewayUrl,
    EPAY_NOTIFY_URL: EPAY_TEST.notifyUrl,
    EPAY_RETURN_URL: EPAY_TEST.returnUrl,
    EMAIL_CODE_REQUIRED: 'off',
    CLIENT_SHUTDOWN_GRACE_MS: 1_000,
    OTEL_TRACES_MODE: 'off',
  } as ClientApiConfig;
}

export interface E2EClientApi {
  baseUrl: string;
  db: Db;
  stop(): Promise<void>;
}

/** 起真 client-api（全真装配；extra 覆盖配置——OAuth mock 场景用） */
export async function startClientApi(
  db: Db,
  extra: Partial<ClientApiConfig> = {},
): Promise<E2EClientApi> {
  const config = { ...e2eBaseConfig(), ...extra } as ClientApiConfig;
  const assembly = assembleClientApi(config, db);
  const app = createApp({
    db,
    assembly,
    jwtSecret: config.JWT_SECRET,
    trustedProxyHops: config.TRUSTED_PROXY_HOPS,
    corsOrigins: [],
    bodyLimitBytes: config.BODY_LIMIT_BYTES,
    secureCookie: false,
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return {
    baseUrl,
    db,
    async stop() {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ────────────────────────── HTTP 助手 ──────────────────────────

export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
  text: string;
}

export async function http(
  baseUrl: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; cookie?: string; contentType?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.cookie) headers.cookie = options.cookie;
  Object.assign(headers, options.headers ?? {});
  if (options.body !== undefined) headers['content-type'] = options.contentType ?? 'application/json';
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : (
      options.contentType === 'application/x-www-form-urlencoded' && typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body)
    ),
    redirect: 'manual',
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* 非 JSON（如 epay 应答文本） */
  }
  return { status: res.status, body, headers: res.headers, text };
}

export const errCode = (r: HttpResult): string =>
  (r.body.error as { code?: string } | undefined)?.code ?? 'NO_ERROR_CODE';

/** 构造一份渠道会发的合法 epay 回调表单 */
export function signedEpayNotify(orderId: string, money: string, overrides: Record<string, string> = {}): string {
  const params: Record<string, string> = {
    pid: EPAY_TEST.pid,
    out_trade_no: orderId,
    trade_no: `e2e-${orderId.slice(0, 8)}`,
    trade_status: 'TRADE_SUCCESS',
    money,
    ...overrides,
  };
  params.sign = epaySign(params, EPAY_TEST.key);
  params.sign_type = 'MD5';
  return new URLSearchParams(params).toString();
}

// ────────────────────────── 造数与清理台账 ──────────────────────────

export class E2EFixtures {
  readonly userIds: number[] = [];
  readonly adminIds: number[] = [];
  readonly planIds: number[] = [];
  readonly batchIds: number[] = [];
  readonly orgIds: number[] = [];

  constructor(readonly db: Db) {}

  uid(tag: string): string {
    return `e2e-${tag}-${randomUUID().slice(0, 8)}`;
  }

  email(): string {
    return `${this.uid('u')}@example.com`;
  }

  async seedPlan(input: {
    price: string;
    quotaAmount: string;
    sortOrder?: number;
    allowSeats?: boolean;
    kind?: 'subscription' | 'pack';
    periodDays?: number;
  }): Promise<number> {
    const [row] = await this.db
      .insert(plans)
      .values({
        name: this.uid('plan'),
        kind: input.kind ?? 'subscription',
        sortOrder: input.sortOrder ?? null,
        price: input.price,
        periodDays: input.periodDays ?? 30,
        quotaAmount: input.quotaAmount,
        allowSeats: input.allowSeats ?? false,
      })
      .returning({ id: plans.id });
    this.planIds.push(row!.id);
    return row!.id;
  }

  async seedRedeemCode(amount: string): Promise<string> {
    const [admin] = await this.db
      .insert(admins)
      .values({ email: this.email(), passwordHash: 'scrypt:32768:8:1:00:00', displayName: 'e2e' })
      .returning({ id: admins.id });
    this.adminIds.push(admin!.id);
    const [batch] = await this.db
      .insert(redeemBatches)
      .values({ name: this.uid('batch'), amount, total: 1, createdBy: admin!.id })
      .returning({ id: redeemBatches.id });
    this.batchIds.push(batch!.id);
    const plaintext = randomUUID().replace(/-/g, '');
    await this.db.insert(redeemCodes).values({
      batchId: batch!.id,
      codeHash: createHash('sha256').update(plaintext).digest('hex'),
    });
    return plaintext;
  }

  /** HTTP 注册并跟踪（E2E 主路径全走真注册端点） */
  async registerViaHttp(baseUrl: string): Promise<{ userId: number; token: string; email: string; password: string }> {
    const mail = this.email();
    const password = 'e2e-correct-horse-battery';
    const res = await http(baseUrl, 'POST', '/v1/auth/register', {
      body: { email: mail, password },
    });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${res.text}`);
    const body = res.body as { token: string; userId: number };
    this.userIds.push(body.userId);
    return { userId: body.userId, token: body.token, email: mail, password };
  }

  /** 余额（CNY 已结算口径） */
  async balanceOf(userId: number): Promise<string> {
    const wallet = (await import('@ai-gateway/service')).createWallet({
      db: this.db,
      currency: 'CNY',
      guards: {
        refTypes: ['gift', 'redeem', 'topup', 'subscription'],
        currencies: ['CNY'],
        internalAccounts: ['outside', 'platform_revenue'],
      },
    });
    const accounts = await wallet.accounts(
      { requestId: `e2e-${randomUUID()}`, actor: { kind: 'system' }, traceParent: null },
      userId,
    );
    return accounts.find((a) => a.currency === 'CNY')?.balance ?? '0';
  }

  async cleanup(): Promise<void> {
    const ids = this.userIds;
    // 网关计费数据（跨 app 场景：billing_requests 引用 api_keys/users）
    if (ids.length) {
      const bills = await this.db.$client.query<{ request_id: string }>(
        'select request_id from billing_requests where user_id = any($1)',
        [ids],
      );
      const billIds = bills.rows.map((r) => r.request_id);
      if (billIds.length) {
        await this.db.$client.query('delete from billing_reservations where billing_request_id = any($1::uuid[])', [billIds]);
        await this.db.$client.query('delete from usage_logs where request_id = any($1::uuid[])', [billIds]);
        await this.db.$client.query('delete from billing_requests where request_id = any($1::uuid[])', [billIds]);
      }
      await this.db.$client.query('delete from generation_tasks where user_id = any($1)', [ids]);
      await this.db.delete(usageLogs).where(inArray(usageLogs.userId, ids));
      await this.db.delete(apiKeys).where(inArray(apiKeys.userId, ids));
      await this.db.update(apps).set({ subscriptionId: null }).where(inArray(apps.userId, ids));
      await this.db.delete(apps).where(inArray(apps.userId, ids));
      await this.db.delete(paymentOrders).where(inArray(paymentOrders.userId, ids));
      await this.db.delete(userSubscriptions).where(inArray(userSubscriptions.userId, ids));
      await this.db.update(redeemCodes).set({ usedBy: null }).where(inArray(redeemCodes.usedBy, ids));
    }
    // 域内建的组织按 owner 收编
    const owned = ids.length
      ? await this.db.select({ id: organizations.id }).from(organizations).where(inArray(organizations.ownerUserId, ids))
      : [];
    const orgIds = [...new Set([...this.orgIds, ...owned.map((r) => r.id)])];
    if (orgIds.length) {
      await this.db.delete(orgInvitations).where(inArray(orgInvitations.orgId, orgIds));
      await this.db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await this.db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    if (ids.length) {
      await this.db.delete(orgMembers).where(inArray(orgMembers.userId, ids));
      await this.db.delete(users).where(inArray(users.id, ids));
    }
    if (this.batchIds.length) {
      await this.db.delete(redeemCodes).where(inArray(redeemCodes.batchId, this.batchIds));
      await this.db.delete(redeemBatches).where(inArray(redeemBatches.id, this.batchIds));
    }
    if (this.adminIds.length) await this.db.delete(admins).where(inArray(admins.id, this.adminIds));
    if (this.planIds.length) await this.db.delete(plans).where(inArray(plans.id, this.planIds));
  }
}

export function expectAmountEq(actual: string, expected: string): void {
  if (!new Decimal(actual).eq(new Decimal(expected))) {
    throw new Error(`对账失败：实际 ${actual} ≠ 期望 ${expected}`);
  }
}
