/**
 * 集成动态化 review 修复规格（B-1/B-2/B-3/B-4 的正式锁定）：
 * - captchaSiteKey 按 effective 下发（停用 = 注册闸门关闭，无防刷放行——DESIGN §4.2/D5）；
 * - 支付回调路由先 refresh 快照再验签（消除 latest 盲窗——DESIGN D9 修订）；
 * - mailerOverride 注入时 auto 口径与 main 基线一致（mailer != null——D8）；
 * - stripe 下单打到快照 apiBase（私有化网关语义——§3.2/§7.3）。
 */
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MiddlewareHandler } from 'hono';
import { epaySign } from '@tillgate/billing';
import type { Billing } from '@tillgate/billing';
import { createClientPayments } from '../src/adapters/payment-providers.js';
import { captchaSiteKeyOf, createDynamicCaptcha } from '../src/adapters/dynamic-captcha.js';
import { createIdentityStack } from '../src/adapters/identity-stack.js';
import { registerRoutes } from '../src/http/routes/auth-register.js';
import { paymentsRoutes } from '../src/http/routes/payments.js';
import type { AuthDeps } from '../src/http/routes/auth.js';
import { loadClientApiConfig } from '../src/config.js';
import type { Db, TxRetryPolicy } from '@tillgate/db';
import type {
  CaptchaConfig,
  IntegrationSnapshot,
  IntegrationSettingsReader,
  ResolvedIntegration,
} from '@tillgate/control-plane';
import type { Redis } from 'ioredis';
import type { Logger } from '@tillgate/runtime';

const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://u:p@localhost:5432/x',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: '0123456789abcdef0123456789abcdef',
  CLIENT_CODE_PEPPER: 'fedcba9876543210fedcba9876543210',
  ENCRYPTION_KEY: 'k1k2k3k4k5k6k7k8k9k0k1k2k3k4k5k6k7k8',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 快照构造助手：全部集关闭，指定面覆写 */
function snapshotOf(overrides: {
  captcha?: ResolvedIntegration<CaptchaConfig>;
  epay?: IntegrationSnapshot['payments']['epay'];
  stripe?: IntegrationSnapshot['payments']['stripe'];
}): IntegrationSnapshot {
  const off = { configured: false, enabled: false, effective: false, config: null } as const;
  return {
    oauth: { base: { ...off }, github: { ...off }, google: { ...off } },
    smtp: { ...off },
    captcha: overrides.captcha ?? { ...off },
    payments: {
      epay: overrides.epay ?? { ...off },
      stripe: overrides.stripe ?? { ...off },
    },
  };
}

/** 可切换 latest 的 reader 替身（refresh 后 latest 换新——模拟路由预刷） */
function swappableReader(initial: IntegrationSnapshot, fresh: IntegrationSnapshot) {
  const state = { latestValue: initial };
  const reader: IntegrationSettingsReader = {
    latest: () => state.latestValue,
    resolve: () => Promise.resolve(fresh),
    refresh: async () => {
      state.latestValue = fresh;
      return fresh;
    },
    invalidate: () => {},
  };
  return { reader, latestValue: () => state.latestValue };
}

// ── B-1：captcha 停用语义 ────────────────────────────────────────────────────

const CAPTCHA_ON: ResolvedIntegration<CaptchaConfig> = {
  configured: true,
  enabled: true,
  effective: true,
  config: { siteKey: 'site-key-x', secretKey: 'secret-key-x', verifyUrl: undefined },
};

function mountRegister(deps: AuthDeps) {
  const errors: Array<{ code: string }> = [];
  const app = new Hono();
  app.onError((err, c) => {
    const code = (err as { code?: string }).code ?? 'unknown';
    errors.push({ code });
    return c.json({ error: { code } }, 500);
  });
  app.route('/', registerRoutes(deps));
  return { app, errors };
}

function registerDepsOf(reader: IntegrationSettingsReader, captchaEnabled: boolean): AuthDeps {
  const captcha = createDynamicCaptcha({ reader });
  return {
    capabilities: () => ({
      registerEnabled: true,
      captchaSiteKey: captchaSiteKeyOf(
        captchaEnabled ? CAPTCHA_ON : { ...CAPTCHA_ON, enabled: false, effective: false },
      ),
      emailCodeRequired: false,
    }),
    smtpReady: () => false,
    passwordPolicy: { minLength: 10, maxLength: 128 },
    sealer: {
      seal: (plain: string) => `sealed:${plain}`,
      open: (sealed: string) => sealed.slice('sealed:'.length),
    },
    trustedProxyHops: 0,
    captcha,
    registerLimiter: { hit: () => Promise.resolve(1) },
    registerIpLimitPerHour: 5,
    registerWindowSeconds: 3_600,
    emailTaken: () => Promise.resolve(false),
    challenges: {
      begin: () =>
        Promise.resolve({
          challengeId: '11111111-1111-4111-8111-111111111111',
          code: '123456',
          expiresAt: new Date().toISOString(),
          channel: 'email' as const,
          to: 'new@x.com',
        }),
    },
    registerCredential: () => Promise.resolve({ userId: 7 }),
    provision: () => Promise.resolve({ userId: 7 }),
    onboarding: () => Promise.resolve({ ok: true }),
    authenticate: () => Promise.reject(new Error('unused')),
    changePassword: () => Promise.reject(new Error('unused')),
    resetPassword: () => Promise.reject(new Error('unused')),
    issueResetToken: () => Promise.reject(new Error('unused')),
    consumeResetToken: () => Promise.reject(new Error('unused')),
    sendResetLink: null,
    resetLinkBase: null,
    resetTokenTtlMinutes: 30,
    guards: { emailIp: { hit: () => Promise.resolve(1) }, ip: { hit: () => Promise.resolve(1) } },
    userStatus: () => Promise.resolve(0),
    userByEmail: () => Promise.resolve(null),
    touchLastLogin: () => Promise.resolve(),
    sign: () => Promise.resolve('signed:x'),
    logout: () => Promise.resolve(),
  } as unknown as AuthDeps;
}

describe('B-1 规格：captcha 停用（保留凭据）后注册无防刷放行', () => {
  const offSnapshot = snapshotOf({
    captcha: { ...CAPTCHA_ON, enabled: false, effective: false },
  });

  it('停用后不带 captchaToken 的注册放行（siteKey null → 闸门关闭）', async () => {
    const reader: IntegrationSettingsReader = {
      latest: () => offSnapshot,
      resolve: () => Promise.resolve(offSnapshot),
      refresh: () => Promise.resolve(offSnapshot),
      invalidate: () => {},
    };
    const { app, errors } = mountRegister(registerDepsOf(reader, false));
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@x.com', password: 'password123' }),
    });
    expect({ status: res.status, errors }).toEqual({ status: 200, errors: [] });
  });

  it('停用后带 captchaToken 也不被 captcha_unavailable 阻断；启用时同载荷通过（对照）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
    );
    const onSnapshot = snapshotOf({ captcha: CAPTCHA_ON });
    const onReader: IntegrationSettingsReader = {
      latest: () => onSnapshot,
      resolve: () => Promise.resolve(onSnapshot),
      refresh: () => Promise.resolve(onSnapshot),
      invalidate: () => {},
    };
    const onMount = mountRegister(registerDepsOf(onReader, true));
    const onRes = await onMount.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@x.com', password: 'password123', captchaToken: 'tok' }),
    });
    expect(onRes.status).toBe(200);
    expect(onMount.errors).toEqual([]);

    const offReader: IntegrationSettingsReader = {
      latest: () => offSnapshot,
      resolve: () => Promise.resolve(offSnapshot),
      refresh: () => Promise.resolve(offSnapshot),
      invalidate: () => {},
    };
    const offMount = mountRegister(registerDepsOf(offReader, false));
    const offRes = await offMount.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@x.com', password: 'password123', captchaToken: 'tok' }),
    });
    expect({ status: offRes.status, errors: offMount.errors }).toEqual({ status: 200, errors: [] });
  });
});

// ── B-2：支付回调预刷（盲窗消除）────────────────────────────────────────────

const OLD_KEY = 'epay-old-key';
const NEW_KEY = 'epay-new-key';

function epayNotifyOf(secret: string): Record<string, string> {
  const params: Record<string, string> = {
    pid: '1001',
    trade_no: 'epay-txn-1',
    out_trade_no: '019775ab-1000-7000-8000-000000000001',
    type: 'alipay',
    name: '余额充值',
    money: '10.00',
    trade_status: 'TRADE_SUCCESS',
    timestamp: '1770000000',
  };
  return { ...params, sign: epaySign(params, secret), sign_type: 'MD5' };
}

const SIGNAL = 'store.read reached (signature verified)';

describe('B-2 规格：回调路由先 refresh 再验签（轮换后新 key 零盲窗）', () => {
  const stale = snapshotOf({
    epay: {
      configured: true,
      enabled: true,
      effective: true,
      config: {
        pid: '1001',
        key: OLD_KEY,
        gatewayUrl: 'https://epay.example/submit.php',
        notifyUrl: 'https://api.example/v1/payments/epay/notify',
        returnUrl: 'https://app.example/topup/return',
        payType: 'alipay',
        verifyKeys: [OLD_KEY],
      },
    },
  });
  const fresh = snapshotOf({
    epay: {
      configured: true,
      enabled: true,
      effective: true,
      config: {
        pid: '1001',
        key: NEW_KEY,
        gatewayUrl: 'https://epay.example/submit.php',
        notifyUrl: 'https://api.example/v1/payments/epay/notify',
        returnUrl: 'https://app.example/topup/return',
        payType: 'alipay',
        verifyKeys: [NEW_KEY, OLD_KEY],
      },
    },
  });

  function mountNotify() {
    const { reader } = swappableReader(stale, fresh);
    let reads = 0;
    const store = {
      read: () => {
        reads += 1;
        throw new Error(SIGNAL);
      },
      transaction: () => {
        throw new Error(SIGNAL);
      },
    } as unknown as Parameters<typeof createClientPayments>[0]['store'];
    const api = createClientPayments({
      config: loadClientApiConfig(BASE_ENV),
      db: {} as Db,
      reader,
      store,
      wallet: {} as Billing['wallet'],
      orderLimiter: { hit: () => Promise.resolve(1) },
      logger: { error: () => {} } as unknown as Logger,
      clock: () => new Date('2026-08-25T00:00:00Z'),
    });
    const app = new Hono();
    app.route(
      '/',
      paymentsRoutes(
        {
          payments: api,
          refreshIntegrationSnapshot: async () => {
            await reader.refresh();
          },
        },
        sessionPassthrough,
      ),
    );
    const errors: Array<string> = [];
    app.onError((err, c) => {
      errors.push(err.message);
      return c.text('error', 500);
    });
    return {
      app,
      errors,
      readCalls: () => reads,
    };
  }

  it('轮换后新 key 签名回调：路由预刷后验签通过（触 store.read SIGNAL）', async () => {
    const { app, errors, readCalls } = mountNotify();
    const res = await app.request('/v1/payments/notify/epay', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(epayNotifyOf(NEW_KEY)).toString(),
    });
    void res;
    expect(errors).toEqual([SIGNAL]); // 验签通过、订单读取被探针截断
    expect(readCalls()).toBe(1);
  });

  it('旧 key 签名回调：预刷后仍在双读窗序列内验签通过', async () => {
    const { app, errors, readCalls } = mountNotify();
    await app.request('/v1/payments/notify/epay', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(epayNotifyOf(OLD_KEY)).toString(),
    });
    expect(errors).toEqual([SIGNAL]);
    expect(readCalls()).toBe(1);
  });
});

// ── B-3：mailerOverride 的 auto 口径 ────────────────────────────────────────

const STACK_ARGS = {
  config: loadClientApiConfig(BASE_ENV), // EMAIL_CODE_REQUIRED 缺省 'auto'
  db: {} as Db,
  redis: {} as Redis,
  txRetry: { maxAttempts: 2, baseDelayMs: 1, maxJitterMs: 1 } satisfies TxRetryPolicy,
  logger: { warn: () => {}, info: () => {}, error: () => {} } as unknown as Logger,
  clock: () => new Date('2026-08-25T00:00:00Z'),
  apiBase: 'http://localhost:8081',
  frontendUrl: 'http://localhost:3000',
};

const EMPTY_SNAPSHOT = snapshotOf({});
const emptyReader: IntegrationSettingsReader = {
  latest: () => EMPTY_SNAPSHOT,
  resolve: () => Promise.resolve(EMPTY_SNAPSHOT),
  refresh: () => Promise.resolve(EMPTY_SNAPSHOT),
  invalidate: () => {},
};

describe('B-3 规格：mailerOverride 注入时 auto 口径 = mailer 在场（main 基线）', () => {
  it('注入 fake mailer + 无 smtp 行 → emailCodeRequired() = true', () => {
    const stack = createIdentityStack({
      ...STACK_ARGS,
      reader: emptyReader,
      mailerOverride: {
        sendLoginCode: () => Promise.resolve(),
        sendPasswordResetLink: () => Promise.resolve(),
      },
    });
    expect(stack.mailer).not.toBeNull();
    expect(stack.emailCodeRequired()).toBe(true);
  });

  it('mailerOverride 显式 null + 无 smtp 行 → false（fail-closed 对照）', () => {
    const stack = createIdentityStack({
      ...STACK_ARGS,
      reader: emptyReader,
      mailerOverride: null,
    });
    expect(stack.mailer).toBeNull();
    expect(stack.emailCodeRequired()).toBe(false);
  });
});

// ── B-4：stripe apiBase 透传 ────────────────────────────────────────────────

const MOCK_API_BASE = 'https://stripe-mock.invalid';

describe('B-4 规格：stripe 下单打到快照 apiBase（私有化网关语义）', () => {
  it('createOrder 的 Checkout Session URL = 配置的 apiBase', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://pay.invalid/x' }), {
          status: 200,
        });
      }),
    );
    const stripeSnapshot = snapshotOf({
      stripe: {
        configured: true,
        enabled: true,
        effective: true,
        config: {
          secretKey: 'sk_test',
          webhookSecret: 'whsec_test',
          successUrl: 'https://app.example/ok',
          cancelUrl: 'https://app.example/no',
          apiBase: MOCK_API_BASE,
          webhookSecrets: ['whsec_test'],
        },
      },
    });
    const reader: IntegrationSettingsReader = {
      latest: () => stripeSnapshot,
      resolve: () => Promise.resolve(stripeSnapshot),
      refresh: () => Promise.resolve(stripeSnapshot),
      invalidate: () => {},
    };
    const store = {
      transaction: async (fn: (conn: unknown) => Promise<unknown>) => fn(fakeConn()),
      read: async () => {
        throw new Error('not reached');
      },
    };
    const api = createClientPayments({
      config: loadClientApiConfig(BASE_ENV),
      db: {} as Db,
      reader,
      store: store as never,
      wallet: {} as Billing['wallet'],
      orderLimiter: { hit: () => Promise.resolve(1) },
      logger: { error: () => {} } as unknown as Logger,
      clock: () => new Date('2026-08-25T00:00:00Z'),
    });
    const order = await api.createTopupOrder(42, { amount: '10', provider: 'stripe' });
    expect(order.payUrl).toBe('https://pay.invalid/x');
    expect(urls[0]).toBe(`${MOCK_API_BASE}/v1/checkout/sessions`);
  });
});

/** 会话中间件直通（notify 路由无会话消费） */
const sessionPassthrough: MiddlewareHandler = async (_c, next) => {
  await next();
};

/** drizzle 替身连接（insertOrder 经 values/where 链落地） */
const fakeConn = () => ({
  insert: () => ({ values: async () => {} }),
  update: () => ({ set: () => ({ where: async () => {} }) }),
});
