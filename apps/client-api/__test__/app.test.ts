/**
 * HTTP 契约测试（内存替身驱动 app.request）：MIGRATION §6 行为对照清单的 app 层断言。
 * 能力语义（事务/并发/资金不变量）归各能力包契约测试；此处锁 wire——状态码、
 * 信封、错误码映射（FaceOverride 表）、分页与凭证一次性下发语义。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { defined } from './defined.js';
import { identityErrors } from '@tillgate/identity';
import { AccountsErrors } from '@tillgate/accounts';
import { BillingErrors } from '@tillgate/billing';
import { createClientApiApp, type ClientApiDeps } from '../src/app.js';

/** 可变测试状态（替身内存） */
interface TestState {
  registerHits: number;
  locked: { emailIp: boolean; ip: boolean };
  usersByEmail: Map<string, { id: number; status: number }>;
  issuedTokens: Map<string, number>;
  resetCalls: Array<{ userId: number; realm: string; newPassword: string }>;
  sentLinks: Array<{ to: string; url: string; ip: string }>;
  limiterHits: Map<string, number>;
  forceRegisterLimit: boolean;
  takenEmails: Set<string>;
  challenges: Map<string, Record<string, unknown>>;
  provisioned: Array<{ id: number; email: string | null }>;
  keys: Array<{ id: number; name: string; keyPreview: string }>;
  redeems: { failWith?: unknown };
  oauthCallbackState: string | null;
  oauthFindUserAs: number | null;
  oauthUserStatus: number;
  /** 用例旋钮：能力开关 / 登录结果覆写 / keys 失败注入 */
  capabilities: {
    registerEnabled: boolean;
    captchaSiteKey: string | null;
    emailCodeRequired: boolean;
  };
  authenticateAs: number | null;
  keysPatchFails: boolean;
  keysRevokeFails: boolean;
  emptyOrgSubs: boolean;
  pricingNoSnapshot: boolean;
  stripeNotifyOk: boolean;
}

function createDeps(): { deps: ClientApiDeps; state: TestState } {
  const state: TestState = {
    registerHits: 0,
    limiterHits: new Map<string, number>(),
    forceRegisterLimit: false,
    locked: { emailIp: false, ip: false },
    takenEmails: new Set(['taken@x.com']),
    usersByEmail: new Map<string, { id: number; status: number }>([
      ['u@x.com', { id: 42, status: 0 }],
    ]),
    issuedTokens: new Map<string, number>(),
    resetCalls: [],
    sentLinks: [],
    challenges: new Map(),
    provisioned: [],
    keys: [{ id: 1, name: 'k1', keyPreview: 'sk_***' }],
    redeems: {},
    oauthCallbackState: 'good-state',
    oauthFindUserAs: null,
    oauthUserStatus: 0,
    capabilities: { registerEnabled: true, captchaSiteKey: null, emailCodeRequired: false },
    authenticateAs: null,
    keysPatchFails: false,
    keysRevokeFails: false,
    emptyOrgSubs: false,
    pricingNoSnapshot: false,
    stripeNotifyOk: false,
  };
  let nextUserId = 100;

  const notLocked = { locked: false, retryAfterSec: 0 };
  const deps: ClientApiDeps = {
    protocol: {
      trustedProxyHops: 0,
      corsOrigins: ['https://console.example'],
      corsMaxAgeSeconds: 600,
      bodyLimitBytes: 8 * 1024 * 1024,
    },
    logger: { error: () => {} },
    health: {
      pingDb: () => Promise.resolve(),
      pingRedis: () => Promise.resolve(),
    },
    validateSession: (token) =>
      Promise.resolve(token === 'tok-good' ? { userId: 42, jti: 'j1', exp: 9_999_999 } : null),
    auth: {
      // 函数求值代理到可变状态——用例旋钮无需突变 readonly deps（capabilities 每请求求值）
      capabilities: () => state.capabilities,
      smtpReady: () => true,
      passwordPolicy: { minLength: 10, maxLength: 128 },
      sealer: {
        seal: (p) => `sealed:${p}`,
        open: (s) => s.slice('sealed:'.length),
      },
      trustedProxyHops: 0,
      captcha: null,
      registerLimiter: {
        // 按键计数(真实 Redis 计数器语义;v1 桩为全局单计数,找回密码多键并发后失真);
        // forceRegisterLimit 旋钮模拟注册 IP 键已超限(测试不依赖键格式实现细节)
        hit: (key: string) => {
          if (state.forceRegisterLimit && key.startsWith('register:')) {
            return Promise.resolve(999);
          }
          const next = (state.limiterHits.get(key) ?? 0) + 1;
          state.limiterHits.set(key, next);
          if (key.startsWith('register:')) state.registerHits = next;
          return Promise.resolve(next);
        },
      },
      registerIpLimitPerHour: 5,
      registerWindowSeconds: 3_600,
      emailTaken: (email) => Promise.resolve(state.takenEmails.has(email)),
      challenges: {
        begin: (_input) => {
          const challengeId = randomUUID();
          state.challenges.set(
            challengeId,
            (_input as { payload?: Record<string, unknown> }).payload ?? {},
          );
          return Promise.resolve({
            challengeId,
            code: '123456',
            expiresAt: new Date().toISOString(),
            channel: 'email' as const,
            to: 'u@x.com',
          });
        },
        verify: (input) => {
          const payload = state.challenges.get(input.challengeId);
          if (payload == null) throw identityErrors.business('challenge_invalid', {});
          if (input.code !== '123456') throw identityErrors.business('code_invalid', {});
          return Promise.resolve({
            target: {
              identifier: { kind: 'email', value: 'u@x.com', normalized: true },
              userId: null,
            },
            payload,
          });
        },
      },
      registerCredential: () => Promise.resolve({ credentialId: 1, replayed: false }),
      provision: (input) => {
        const user = { id: ++nextUserId, email: input.email };
        state.provisioned.push(user);
        return Promise.resolve(user);
      },
      onboarding: () => Promise.resolve({ gift: { status: 'credited' } }),
      resetPassword: async (input: { userId: number; realm: string; newPassword: string }) => {
        state.resetCalls.push(input);
        return { invalidBefore: '2026-01-01T00:00:00Z' };
      },
      userByEmail: async (email: string) => state.usersByEmail.get(email) ?? null,
      issueResetToken: async (userId: number) => {
        const token = `reset-token-${userId}-${state.issuedTokens.size + 1}-xxxxxxxxxxxx`;
        state.issuedTokens.set(token, userId);
        return token;
      },
      consumeResetToken: async (token: string) => {
        const userId = state.issuedTokens.get(token) ?? null;
        if (userId != null) state.issuedTokens.delete(token); // 单次消费
        return userId;
      },
      sendResetLink: async (to: string, url: string, ctx: { ip: string }) => {
        state.sentLinks.push({ to, url, ip: ctx.ip });
      },
      resetLinkBase: 'https://console.example',
      resetTokenTtlMinutes: 30,
      authenticate: (input) => {
        if (state.authenticateAs != null) return Promise.resolve({ userId: state.authenticateAs });
        if (
          (input.identifier as { value: string }).value === 'u@x.com' &&
          input.password === 'password123'
        ) {
          return Promise.resolve({ userId: 42 });
        }
        throw identityErrors.business('invalid_credentials', { realm: 'user' });
      },
      changePassword: () => Promise.resolve({ invalidBefore: new Date().toISOString() }),
      guards: {
        emailIp: {
          isLocked: () =>
            Promise.resolve(
              state.locked.emailIp ? { locked: true, retryAfterSec: 120 } : notLocked,
            ),
          recordFailure: () => Promise.resolve({ locked: false, retryAfterSec: 0 }),
          recordSuccess: () => Promise.resolve(),
        },
        ip: {
          isLocked: () =>
            Promise.resolve(state.locked.ip ? { locked: true, retryAfterSec: 60 } : notLocked),
          recordFailure: () => Promise.resolve({ locked: false, retryAfterSec: 0 }),
        },
      },
      userStatus: (userId) => {
        if (userId === 42) return Promise.resolve(0);
        if (userId === 43) return Promise.resolve(1);
        return Promise.resolve(null);
      },
      touchLastLogin: () => Promise.resolve(),
      sign: (userId) => Promise.resolve(`signed:${userId}`),
      logout: () => Promise.resolve(),
    },
    oauth: {
      providers: () => ['github'] as const,
      authorize: () =>
        Promise.resolve({
          url: 'https://github.com/login/oauth/authorize?x=1',
          state: 'good-state',
        }),
      callback: (input) => {
        if (input.state !== state.oauthCallbackState) {
          throw identityErrors.business('oauth_state_invalid', { provider: input.provider });
        }
        return Promise.resolve({
          provider: 'github',
          subject: 'gh-sub-1',
          email: 'gh@x.com',
          displayName: 'GH User',
          next: '/dashboard',
        });
      },
      findUser: () => Promise.resolve(state.oauthFindUserAs),
      provision: (input) =>
        Promise.resolve({
          user: {
            id: ++nextUserId,
            issuer: 'github',
            subject: 'gh-sub',
            identityProvider: 'oauth',
            email: input.email ?? null,
            displayName: null,
            rateCardId: null,
            dailySpendLimit: null,
            status: 0,
            sessionInvalidBefore: null,
            isEnterprise: false,
            freezeReason: null,
            rpmLimit: null,
            tpmLimit: null,
            lastLoginAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          created: true,
        }),
      onboarding: () => Promise.resolve({ gift: { status: 'credited' } }),
      userStatus: () => Promise.resolve(state.oauthUserStatus),
      sign: (userId) => Promise.resolve(`signed:${userId}`),
      frontendUrl: 'https://app.example',
      apiBase: 'https://api.example',
      secureCookie: false,
      stateTtlSeconds: 600,
    },
    me: {
      profile: () =>
        Promise.resolve({
          id: 42,
          issuer: 'local',
          subject: 'u@x.com',
          identityProvider: 'local',
          email: 'u@x.com',
          displayName: 'U',
          rateCardId: null,
          rateCardName: null,
          dailySpendLimit: null,
          status: 0,
          sessionInvalidBefore: null,
          isEnterprise: false,
          freezeReason: null,
          rpmLimit: null,
          tpmLimit: null,
          lastLoginAt: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        }),
      updateDisplayName: (input) =>
        Promise.resolve({
          id: 42,
          issuer: 'local',
          subject: 'u@x.com',
          identityProvider: 'local',
          email: 'u@x.com',
          displayName: input.displayName,
          rateCardId: null,
          dailySpendLimit: null,
          status: 0,
          sessionInvalidBefore: null,
          isEnterprise: false,
          freezeReason: null,
          rpmLimit: null,
          tpmLimit: null,
          lastLoginAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      walletAccounts: () =>
        Promise.resolve([
          {
            id: 'a1',
            kind: 'user',
            code: null,
            currency: 'CNY',
            balance: '10',
            inFlight: '0',
            creditLimit: '0',
            status: 'active',
          },
        ]),
    },
    keys: {
      create: (input) =>
        Promise.resolve({
          key: {
            id: 7,
            keyPreview: 'sk_***',
            userId: input.userId,
            appId: null,
            subscriptionId: null,
            name: input.name,
            remark: null,
            expiresAt: null,
            rpmLimit: null,
            tpmLimit: null,
            dailySpendLimit: null,
            allowPaygFallback: true,
            status: 0,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: new Date(),
          },
          plaintext: 'sk_plain_secret',
        }),
      list: () =>
        Promise.resolve({
          rows: [
            {
              id: 1,
              keyPreview: 'sk_***',
              userId: 42,
              appId: null,
              subscriptionId: null,
              name: 'k1',
              remark: null,
              expiresAt: null,
              rpmLimit: null,
              tpmLimit: null,
              dailySpendLimit: null,
              allowPaygFallback: false,
              status: 0,
              lastUsedAt: null,
              revokedAt: null,
              createdAt: new Date(),
            },
          ],
          total: 1,
        }),
      patch: () => {
        if (state.keysPatchFails) throw AccountsErrors.business('key_not_found', {});
        return Promise.resolve({
          id: 1,
          keyPreview: 'sk_***',
          userId: 42,
          appId: null,
          subscriptionId: null,
          name: 'k1',
          remark: 'r',
          expiresAt: new Date(),
          rpmLimit: 10,
          tpmLimit: 100,
          dailySpendLimit: '5',
          allowPaygFallback: false,
          status: 0,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
        });
      },
      rotate: () =>
        Promise.resolve({
          key: {
            id: 2,
            keyPreview: 'sk_***',
            userId: 42,
            appId: null,
            subscriptionId: null,
            name: 'k1',
            remark: null,
            expiresAt: null,
            rpmLimit: null,
            tpmLimit: null,
            dailySpendLimit: null,
            allowPaygFallback: false,
            status: 0,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: new Date(),
          },
          plaintext: 'sk_rotated',
        }),
      revoke: () => {
        if (state.keysRevokeFails) throw AccountsErrors.business('key_already_revoked', {});
        return Promise.resolve({
          id: 1,
          keyPreview: 'sk_***',
          userId: 42,
          appId: null,
          subscriptionId: null,
          name: 'k1',
          remark: null,
          expiresAt: null,
          rpmLimit: null,
          tpmLimit: null,
          dailySpendLimit: null,
          allowPaygFallback: false,
          status: 1,
          lastUsedAt: null,
          revokedAt: new Date(),
          createdAt: new Date(),
        });
      },
    },
    apps: {
      create: (input) =>
        Promise.resolve({
          app: {
            id: 3,
            appId: 'apphex',
            userId: input.userId,
            clientId: 'cid',
            name: input.name,
            description: null,
            subscriptionId: null,
            scope: null,
            status: 0,
            createdAt: new Date(),
            rotatedAt: null,
          },
          clientSecret: 'sec_once',
        }),
      list: () => Promise.resolve({ rows: [], total: 0 }),
      disable: () => {
        throw AccountsErrors.business('app_not_found', {});
      },
      rotateSecret: () =>
        Promise.resolve({
          app: {
            id: 3,
            appId: 'apphex',
            userId: 42,
            clientId: 'cid',
            name: 'a',
            description: null,
            subscriptionId: null,
            scope: null,
            status: 0,
            createdAt: new Date(),
            rotatedAt: new Date(),
          },
          clientSecret: 'sec_new',
        }),
    },
    orgs: {
      listMyOrgs: () =>
        Promise.resolve([
          {
            id: 9,
            orgId: 9,
            userId: 42,
            role: 'owner',
            status: 0,
            dailySpendLimit: null,
            monthlyQuota: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            orgName: 'Org',
          },
        ]),
      orgDetail: () =>
        Promise.resolve({
          org: {
            id: 9,
            name: 'Org',
            ownerUserId: 42,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          members: [
            {
              userId: 42,
              displayName: 'U',
              email: 'u@x.com',
              subject: 'u@x.com',
              role: 'owner',
              status: 0,
              dailySpendLimit: null,
              monthlyQuota: null,
              joinedAt: new Date(),
            },
          ],
          invitations: [],
        }),
      invite: () =>
        Promise.resolve({ invitationId: 11, token: 'invite-token-once', expiresAt: new Date() }),
      revokeInvitation: () => Promise.resolve(),
      acceptInvitation: () => Promise.resolve({ orgId: 9 }),
      patchMember: () =>
        Promise.resolve({
          id: 1,
          orgId: 9,
          userId: 42,
          role: 'owner',
          status: 0,
          dailySpendLimit: '5',
          monthlyQuota: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      removeMember: () => Promise.resolve(),
      orgSubscriptions: () =>
        Promise.resolve(
          state.emptyOrgSubs
            ? new Map()
            : new Map([
                [
                  9,
                  {
                    subscriptionId: 5,
                    planName: 'Team',
                    quantity: 3,
                    quotaAmount: '100',
                    usedAmount: '20',
                    reservedAmount: '5',
                  },
                ],
              ]),
        ),
    },
    wallet: {
      accounts: () => Promise.resolve([]),
      statement: (input) => {
        const count = input.limit ?? 20;
        const rows = Array.from({ length: Math.min(count, 3) }, (_, i) => ({
          legId: 100 - i,
          transactionKind: 'credit',
          refType: 'gift',
          refId: `signup:${42}`,
          amount: '1',
          balanceAfter: '10',
          memo: null,
          createdAt: new Date(),
        }));
        return Promise.resolve(rows);
      },
    },
    redeem: {
      redeem: (_userId, _input) => {
        if (state.redeems.failWith) throw state.redeems.failWith;
        return Promise.resolve({ amount: '5', balanceAfter: '15', transactionId: 3 });
      },
      history: () =>
        Promise.resolve([{ codeId: 1, batchName: 'b', amount: '5', usedAt: new Date() }]),
    },
    payments: {
      refreshIntegrationSnapshot: async () => {},
      payments: {
        createTopupOrder: () =>
          Promise.resolve({
            orderId: '0f0e0d0c-0000-4000-8000-000000000000',
            payUrl: 'https://pay',
            creditAmount: '10',
          }),
        handleNotify: (provider) =>
          Promise.resolve(
            provider === 'epay' || state.stripeNotifyOk ? ('success' as const) : ('fail' as const),
          ),
        orderDetail: () => {
          throw BillingErrors.business('order_not_found', {});
        },
        listOrders: () => Promise.resolve([]),
        channels: () => [{ id: 'epay', label: '支付宝/微信（易支付）' }],
      },
    },
    subscriptions: {
      api: {
        purchase: () =>
          Promise.resolve({
            userId: 42,
            subscriptionId: 5,
            orgId: null,
            planId: 1,
            planName: 'Lite',
            quantity: 1,
            startAt: '2026-01-01T00:00:00.000Z',
            endAt: '2026-01-31T00:00:00.000Z',
            quotaAmount: '100',
            price: '10',
            balanceBefore: '20',
            balanceAfter: '10',
            replayed: false,
          }),
        change: () =>
          Promise.resolve({
            userId: 42,
            subscriptionId: 5,
            orgId: null,
            planId: 2,
            planName: 'Pro',
            quantity: 1,
            startAt: '2026-01-01T00:00:00.000Z',
            endAt: '2026-01-31T00:00:00.000Z',
            quotaAmount: '200',
            price: '20',
            balanceBefore: null,
            balanceAfter: null,
            replayed: false,
          }),
        renew: () =>
          Promise.resolve({
            userId: 42,
            subscriptionId: 5,
            orgId: null,
            planId: 1,
            planName: 'Lite',
            quantity: 1,
            startAt: '2026-02-01T00:00:00.000Z',
            endAt: '2026-03-03T00:00:00.000Z',
            quotaAmount: '100',
            price: '10',
            balanceBefore: '10',
            balanceAfter: '0',
            replayed: false,
          }),
      },
      reads: {
        listPlans: () =>
          Promise.resolve([
            {
              id: 1,
              name: 'Lite',
              kind: 'subscription',
              sortOrder: 1,
              price: '10',
              periodDays: 30,
              quotaAmount: '100',
              allowSeats: false,
              status: 0,
            },
          ]),
        mySubscriptions: () =>
          Promise.resolve([
            {
              id: 5,
              planId: 1,
              planName: 'Lite',
              planSortOrder: 1,
              allowSeats: false,
              periodDays: 30,
              status: 0,
              orgId: null,
              quantity: 2,
              quotaAmount: '100',
              usedAmount: '20',
              reservedAmount: '5',
              price: '20',
              planPrice: '10',
              startAt: new Date('2026-01-01T00:00:00Z'),
              endAt: new Date('2030-01-01T00:00:00Z'),
            },
          ]),
      },
    },
    usage: {
      list: () =>
        Promise.resolve({
          rows: [
            {
              id: 1,
              requestId: 'r1',
              userId: 42,
              appId: null,
              apiKeyId: 2,
              externalModel: 'gpt-x',
              realModel: 'up-1',
              channelId: 1,
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              units: 0,
              unitPrice: null,
              pricingUnit: '1k_tokens',
              amount: '0.001',
              billedBy: 'payg',
              planAmount: '0',
              paygAmount: '0.001',
              upstreamCost: '0.0005',
              durationMs: 100,
              clientTtftMs: null,
              createdAt: new Date(),
              credentialType: 'key',
              keyName: 'k1',
              appName: null,
            },
          ],
          total: 1,
        }),
      byModel: () =>
        Promise.resolve([
          {
            model: 'gpt-x',
            requests: 1,
            inputTokens: 10,
            outputTokens: 5,
            cachedInputTokens: 0,
            cost: '0.001',
          },
        ]),
      summary: () =>
        Promise.resolve({
          list: [
            {
              date: '2026-08-01',
              requests: 1,
              inputTokens: 10,
              outputTokens: 5,
              cachedInputTokens: 0,
              cost: '0.001',
            },
          ],
        }),
      rate: () => Promise.resolve({ rpm: 3, tpm: 120 }),
    },
    pricing: {
      baseCatalog: () =>
        Promise.resolve({
          models: [
            { externalName: 'gpt-x', realModel: 'up-1', pricingUnit: '1k_tokens' },
            { externalName: 'claude-y', realModel: 'up-2', pricingUnit: '1k_tokens' },
            { externalName: 'ds-night', realModel: 'up-3', pricingUnit: 'token' },
          ],
          enriched: new Map([
            [
              'ds-night',
              {
                id: 3,
                contextLength: null,
                inputPrice: '2',
                outputPrice: '8',
                cacheInputPrice: '2',
                unitPrice: '0',
                isFree: false,
                pricingGroup: null,
                schedule: [
                  {
                    label: '谷时段',
                    start: '18:00',
                    end: '07:00',
                    inputPrice: '0.5',
                    outputPrice: '2',
                  },
                ],
              },
            ],
            [
              'gpt-x',
              {
                id: 1,
                contextLength: 128000,
                inputPrice: '1',
                outputPrice: '2',
                cacheInputPrice: '0.5',
                unitPrice: '0',
                isFree: false,
                pricingGroup: null,
              },
            ],
            [
              'claude-y',
              {
                id: 2,
                contextLength: null,
                inputPrice: '0',
                outputPrice: '0',
                cacheInputPrice: '0',
                unitPrice: '1',
                isFree: true,
                pricingGroup: 'g1',
              },
            ],
          ]),
        }),
      rateCardSnapshot: () =>
        Promise.resolve(
          state.pricingNoSnapshot
            ? null
            : { rateCardId: 9, status: 0, global: null, model: { 1: '0.5' }, group: { g1: '0.8' } },
        ),
      billingTimezone: () => Promise.resolve('Asia/Shanghai'),
    },
    referrals: {
      marketingSettings: () =>
        Promise.resolve({
          signupGiftAmount: '1',
          referralSignupBonus: '2',
          referralCommissionRate: '0.1',
          updatedBy: null,
          updatedAt: new Date(),
        }),
      overview: () =>
        Promise.resolve({
          enabled: true,
          affCode: 'u1a',
          inviteUrl: 'https://app.example/register?aff=u1a',
          signupBonus: '2',
          commissionRate: '0.1',
          invitees: [
            {
              inviteeUserId: 7,
              inviteeEmail: 'i@x.com',
              inviteeDisplayName: 'I',
              status: 1,
              createdAt: new Date(),
            },
          ],
        }),
      totalCommission: () => Promise.resolve('4.5'),
      frontendBaseUrl: 'https://app.example',
    },
  };

  return { deps, state };
}

function build(): {
  app: ReturnType<typeof createClientApiApp>;
  state: TestState;
  deps: ClientApiDeps;
} {
  const { deps, state } = createDeps();
  return { app: createClientApiApp(deps), state, deps };
}

const auth = { authorization: 'Bearer tok-good' };
const jsonAuth = { ...auth, 'content-type': 'application/json' };

describe('协议链与安全件', () => {
  it('未携带令牌统一 401（不区分原因）', async () => {
    const { app } = build();
    const res = await app.request('/v1/me');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('http.unauthorized');
  });

  it('伪造令牌 401', async () => {
    const { app } = build();
    const res = await app.request('/v1/me', { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });

  it('requestId 服务端生成并回显', async () => {
    const { app } = build();
    const res = await app.request('/healthz', { headers: { 'x-request-id': 'client-controlled' } });
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id).not.toBe('client-controlled');
  });

  it('安全头四件套', async () => {
    const { app } = build();
    const res = await app.request('/healthz');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('CORS 白名单放行预检，未列 Origin 不放行', async () => {
    const { app } = build();
    const allowed = await app.request('/v1/pricing', {
      method: 'OPTIONS',
      headers: { origin: 'https://console.example' },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://console.example');
    const denied = await app.request('/v1/pricing', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('404 统一信封', async () => {
    const { app } = build();
    const res = await app.request('/v1/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('http.not_found');
  });

  it('healthz：DB 与 Redis 双检', async () => {
    const { app } = build();
    expect((await app.request('/healthz')).status).toBe(200);
  });
});

describe('auth 两步制', () => {
  it('DIAG register body echo', async () => {
    const { app } = build();
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@x.com', password: 'password123' }),
    });
    console.log('DIAG-NOCT STATUS:', res.status, 'BODY:', await res.text());
  });
  it('capabilities 形状', async () => {
    const { app } = build();
    const res = await app.request('/v1/auth/capabilities');
    expect(await res.json()).toEqual({
      registerEnabled: true,
      captchaSiteKey: null,
      emailCodeRequired: false,
    });
  });

  it('register → code_required（200），verify → 201 success 全形状', async () => {
    const { app, state } = build();
    const reg = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@x.com', password: 'password123' }),
    });
    expect(reg.status).toBe(200);
    const regBody = (await reg.json()) as { kind: string; challengeId: string };
    expect(regBody.kind).toBe('code_required');
    expect(state.challenges.get(regBody.challengeId)).toMatchObject({
      mail: 'new@x.com',
      pwd: 'sealed:password123',
    });

    const ver = await app.request('/v1/auth/register/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: regBody.challengeId, code: '123456' }),
    });
    expect(ver.status).toBe(201);
    const verBody = (await ver.json()) as {
      kind: string;
      token: string;
      userId: number;
      email: string;
      gifted: boolean;
    };
    expect(verBody.kind).toBe('success');
    expect(verBody.token).toBe(`signed:${verBody.userId}`);
    expect(verBody.email).toBe('new@x.com');
    expect(verBody.gifted).toBe(true);
  });

  it('注册关闭 403 register_disabled', async () => {
    const { app, state } = build();
    state.capabilities = { ...state.capabilities, registerEnabled: false };
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@x.com', password: 'password123' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'client.register_disabled',
    );
  });

  it('IP 限频超限 429 + Retry-After', async () => {
    const { app, state } = build();
    state.forceRegisterLimit = true;
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@x.com', password: 'password123' }),
    });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'client.register_rate_limited',
    );
    expect(res.headers.get('retry-after')).toBe('3600');
  });

  it('邮箱已占 409 accounts.email_taken', async () => {
    const { app } = build();
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'taken@x.com', password: 'password123' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'accounts.email_taken',
    );
  });

  it('弱密码 400 identity.weak_password（发码前拒绝）', async () => {
    const { app } = build();
    const res = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@x.com', password: 'short' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'identity.weak_password',
    );
  });

  it('验证码错误 400 identity.code_invalid', async () => {
    const { app } = build();
    const res = await app.request('/v1/auth/register/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: '00000000-0000-4000-8000-000000000000', code: '000000' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'identity.challenge_invalid',
    );
  });

  it('login 成功单密码分支', async () => {
    const { app } = build();
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'u@x.com', password: 'password123' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'success', token: 'signed:42', userId: 42 });
  });

  it('login 凭据错误 401 identity.invalid_credentials（override 401）', async () => {
    const { app } = build();
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'u@x.com', password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'identity.invalid_credentials',
    );
  });

  it('login 爆破锁 429 + Retry-After', async () => {
    const { app, state } = build();
    state.locked.emailIp = true;
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'u@x.com', password: 'password123' }),
    });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'client.login_locked',
    );
    expect(res.headers.get('retry-after')).toBe('120');
  });

  it('login 封禁账户 403 client.account_unavailable', async () => {
    const { app, state } = build();
    state.authenticateAs = 43;
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'u@x.com', password: 'password123' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'client.account_unavailable',
    );
  });

  it('两级登录：login → code_required；verify → token（uid 载荷）', async () => {
    const { app, state } = build();
    state.capabilities = { ...state.capabilities, emailCodeRequired: true };
    const login = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'u@x.com', password: 'password123' }),
    });
    const loginBody = (await login.json()) as { kind: string; challengeId: string };
    expect(loginBody.kind).toBe('code_required');
    // 登录挑战载荷带 uid（verify 半程免二次认证）
    expect(state.challenges.get(loginBody.challengeId)).toEqual({ uid: 42 });

    const ver = await app.request('/v1/auth/login/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: loginBody.challengeId, code: '123456' }),
    });
    expect(ver.status).toBe(200);
    expect(await ver.json()).toEqual({ token: 'signed:42', userId: 42 });
  });

  it('改密返回新 token', async () => {
    const { app } = build();
    const res = await app.request('/v1/auth/password', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ oldPassword: 'password123', newPassword: 'password456' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'signed:42' });
  });

  it('logout ok', async () => {
    const { app } = build();
    const res = await app.request('/v1/auth/logout', { method: 'POST', headers: auth });
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('me / keys / apps / orgs', () => {
  it('GET /v1/me 富化钱包账户', async () => {
    const { app } = build();
    const res = await app.request('/v1/me', { headers: auth });
    const body = (await res.json()) as { id: number; accounts: unknown[] };
    expect(body.id).toBe(42);
    expect(body.accounts).toHaveLength(1);
  });

  it('PATCH display-name', async () => {
    const { app } = build();
    const res = await app.request('/v1/me/display-name', {
      method: 'PATCH',
      headers: jsonAuth,
      body: JSON.stringify({ displayName: 'New Name' }),
    });
    expect(await res.json()).toEqual({ displayName: 'New Name' });
  });

  it('keys 列表信封 {rows,total,page,limit}', async () => {
    const { app } = build();
    const res = await app.request('/v1/keys?page=2&limit=50', { headers: auth });
    const body = (await res.json()) as {
      rows: unknown[];
      total: number;
      page: number;
      limit: number;
    };
    expect(body.page).toBe(2);
    expect(body.limit).toBe(50);
    expect(body.total).toBe(1);
  });

  it('keys 创建 201 {id,name,plaintext}（明文只回一次）', async () => {
    const { app } = build();
    const res = await app.request('/v1/keys', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ name: 'k' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; name: string; plaintext: string };
    expect(body.plaintext).toBe('sk_plain_secret');
    expect('keyHash' in body).toBe(false);
  });

  it('keys dailySpendLimit 传 JSON number → 400（结构性金额校验）', async () => {
    const { app } = build();
    const res = await app.request('/v1/keys', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ name: 'k', dailySpendLimit: 50 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'http.validation_failed',
    );
  });

  it('keys patch 404 → accounts.key_not_found', async () => {
    const { app, state } = build();
    state.keysPatchFails = true;
    const res = await app.request('/v1/keys/9', {
      method: 'PATCH',
      headers: jsonAuth,
      body: JSON.stringify({ name: 'n' }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'accounts.key_not_found',
    );
  });

  it('apps 创建 201 clientSecret；rotate 200 新 secret', async () => {
    const { app } = build();
    const created = await app.request('/v1/apps', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ name: 'a' }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { clientSecret: string }).clientSecret).toBe('sec_once');
    const rotated = await app.request('/v1/apps/3/rotate', { method: 'POST', headers: auth });
    expect(await rotated.json()).toEqual({ id: 3, clientSecret: 'sec_new' });
  });

  it('orgs 列表富化订阅并计算剩余额度', async () => {
    const { app } = build();
    const res = await app.request('/v1/orgs', { headers: auth });
    const body = (await res.json()) as {
      rows: Array<{ remainingAmount: string; planName: string | null }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.rows[0]?.planName).toBe('Team');
    expect(body.rows[0]?.remainingAmount).toBe('75');
  });

  it('orgs 邀请 token 只回一次（201）', async () => {
    const { app } = build();
    const res = await app.request('/v1/orgs/9/invitations', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ email: 'i@x.com' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ invitationId: 11, token: 'invite-token-once' });
  });

  it('orgs 接受邀请返回 orgId；成员限额修补 ok', async () => {
    const { app } = build();
    const accept = await app.request('/v1/orgs/invitations/accept', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ token: 't' }),
    });
    expect(await accept.json()).toEqual({ orgId: 9 });
    const patch = await app.request('/v1/orgs/9/members/42', {
      method: 'PATCH',
      headers: jsonAuth,
      body: JSON.stringify({ dailySpendLimit: '5' }),
    });
    expect(await patch.json()).toEqual({ ok: true });
  });
});

describe('wallet / redeem / payments', () => {
  it('statement 游标分页：满页带 nextCursor', async () => {
    const { app } = build();
    const res = await app.request('/v1/wallet/statement?limit=3', { headers: auth });
    const body = (await res.json()) as { rows: unknown[]; nextCursor?: string };
    expect(body.rows).toHaveLength(3);
    expect(body.nextCursor).toBe('98');
    const last = await app.request('/v1/wallet/statement?limit=20', { headers: auth });
    const lastBody = (await last.json()) as { rows: unknown[]; nextCursor?: string };
    expect(lastBody.nextCursor).toBeUndefined();
  });

  it('redeem 200 形状 + history 信封', async () => {
    const { app } = build();
    const res = await app.request('/v1/redeem', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ code: 'ABC' }),
    });
    expect(await res.json()).toEqual({ amount: '5', balanceAfter: '15', transactionId: 3 });
    const hist = await app.request('/v1/redeem/history', { headers: auth });
    expect(((await hist.json()) as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('FaceOverride：billing.code_expired → 410（v1 状态语义钉死）', async () => {
    const { app, state } = build();
    state.redeems.failWith = BillingErrors.business('code_expired', {});
    const res = await app.request('/v1/redeem', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ code: 'OLD' }),
    });
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'billing.code_expired',
    );
  });

  it('下单 201 形状；订单不存在 404；畸形 id 400', async () => {
    const { app } = build();
    const created = await app.request('/v1/payments/orders', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ amount: '10' }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      orderId: expect.any(String),
      payUrl: 'https://pay',
      creditAmount: '10',
    });

    const notFound = await app.request('/v1/payments/orders/0f0e0d0c-0000-4000-8000-000000000000', {
      headers: auth,
    });
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as { error: { code: string } }).error.code).toBe(
      'billing.order_not_found',
    );

    const malformed = await app.request('/v1/payments/orders/not-a-uuid', { headers: auth });
    expect(malformed.status).toBe(400);
  });

  it('支付回调协议：epay 裸文本 / stripe JSON received / 未知渠道 404', async () => {
    const { app } = build();
    const epay = await app.request('/v1/payments/notify/epay', {
      method: 'POST',
      body: 'out_trade_no=x&trade_status=TRADE_SUCCESS',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(await epay.text()).toBe('success');

    const stripe = await app.request('/v1/payments/notify/stripe', {
      method: 'POST',
      body: '{"type":"checkout.session.completed"}',
    });
    expect(stripe.status).toBe(400);
    expect(await stripe.json()).toEqual({ received: false });

    const unknown = await app.request('/v1/payments/notify/other', { method: 'POST' });
    expect(unknown.status).toBe(404);
  });

  it('channels 目录', async () => {
    const { app } = build();
    const res = await app.request('/v1/payments/channels', { headers: auth });
    expect(((await res.json()) as { channels: Array<{ id: string }> }).channels[0]?.id).toBe(
      'epay',
    );
  });
});

describe('subscriptions / usage / pricing / referrals', () => {
  it('plans 公开目录；我的订阅派生字段（remaining/renewPrice/remainingValue）', async () => {
    const { app } = build();
    const plans = await app.request('/v1/plans');
    expect(((await plans.json()) as { rows: Array<{ name: string }> }).rows[0]?.name).toBe('Lite');

    const mine = await app.request('/v1/subscriptions', { headers: auth });
    const row = defined(
      (
        (await mine.json()) as {
          rows: Array<{ remainingAmount: string; renewPrice: string; remainingValue: string }>;
        }
      ).rows[0],
      'subscriptions.rows[0]',
    );
    expect(row.remainingAmount).toBe('75');
    expect(row.renewPrice).toBe('20');
    expect(row.remainingValue).toBe('15');
  });

  it('购买 201（幂等键透传）；非法幂等键 400', async () => {
    const { app } = build();
    const ok = await app.request('/v1/subscriptions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'op-abc_123' },
      body: JSON.stringify({ planId: 1 }),
    });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { replayed: boolean }).replayed).toBe(false);

    const bad = await app.request('/v1/subscriptions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': '!bad key' },
      body: JSON.stringify({ planId: 1 }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      'http.invalid_idempotency_key',
    );
  });

  it('变更/续费 200', async () => {
    const { app } = build();
    const change = await app.request('/v1/subscriptions/5/change', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ targetPlanId: 2, quantity: 1 }),
    });
    expect(((await change.json()) as { planName: string }).planName).toBe('Pro');
    const renew = await app.request('/v1/subscriptions/5/renew', { method: 'POST', headers: auth });
    expect(((await renew.json()) as { quotaAmount: string }).quotaAmount).toBe('100');
  });

  it('usage 四端信封', async () => {
    const { app } = build();
    const list = (await (await app.request('/v1/usage', { headers: auth })).json()) as {
      rows: unknown[];
      total: number;
    };
    expect(list.total).toBe(1);
    const byModel = (await (await app.request('/v1/usage/by-model', { headers: auth })).json()) as {
      rows: unknown[];
    };
    expect(byModel.rows).toHaveLength(1);
    const summary = (await (await app.request('/v1/usage/summary', { headers: auth })).json()) as {
      list: unknown[];
    };
    expect(summary.list).toHaveLength(1);
    const rate = (await (await app.request('/v1/usage/rate', { headers: auth })).json()) as {
      rpm: number;
    };
    expect(rate.rpm).toBe(3);
  });

  it('pricing 公开目录过滤/分页；personal 含 coefficient 与到手价', async () => {
    const { app } = build();
    const pub = (await (await app.request('/v1/pricing?free=true&page=1&pageSize=10')).json()) as {
      models: Array<{ externalName: string }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(pub.total).toBe(1);
    expect(pub.models[0]?.externalName).toBe('claude-y');
    expect(pub.pageSize).toBe(10);

    const personal = (await (
      await app.request('/v1/pricing/personal', { headers: auth })
    ).json()) as {
      models: Array<{
        externalName: string;
        coefficient?: string;
        effective?: { inputPrice: string };
        personalized?: boolean;
      }>;
    };
    const gpt = personal.models.find((m) => m.externalName === 'gpt-x');
    expect(gpt?.coefficient).toBe('0.5');
    expect(gpt?.effective?.inputPrice).toBe('0.5');
    expect(gpt?.personalized).toBe(true);
  });

  it('pricing schedule 窗口透出：公开面带窗口与计费时区；personal 带窗口到手价', async () => {
    const { app } = build();
    const pub = (await (await app.request('/v1/pricing?page=1&pageSize=10')).json()) as {
      billingTimezone: string;
      models: Array<{
        externalName: string;
        schedule?: Array<{ label?: string; start: string; end: string; inputPrice?: string }>;
        effectiveSchedule?: unknown;
      }>;
    };
    expect(pub.billingTimezone).toBe('Asia/Shanghai');
    const ds = pub.models.find((m) => m.externalName === 'ds-night');
    expect(ds?.schedule).toEqual([
      { label: '谷时段', start: '18:00', end: '07:00', inputPrice: '0.5', outputPrice: '2' },
    ]);
    expect(ds?.effectiveSchedule).toBeUndefined(); // 公开面不带到手价

    const personal = (await (
      await app.request('/v1/pricing/personal', { headers: auth })
    ).json()) as {
      models: Array<{
        externalName: string;
        effectiveSchedule?: Array<{ inputPrice?: string; outputPrice?: string }>;
      }>;
    };
    // 系数表 model: {1:'0.5'}；ds-night id=3 无 model 行 → group g1 miss → global null → 1
    const dsPersonal = personal.models.find((m) => m.externalName === 'ds-night');
    expect(dsPersonal?.effectiveSchedule).toEqual([
      { label: '谷时段', start: '18:00', end: '07:00', inputPrice: '0.5', outputPrice: '2' },
    ]);
    // 无 schedule 的模型不携带窗口字段
    expect(
      (personal.models.find((m) => m.externalName === 'gpt-x') as { schedule?: unknown }).schedule,
    ).toBeUndefined();
  });

  it('referrals config 开关计算 + overview 合并佣金', async () => {
    const { app } = build();
    const config = (await (
      await app.request('/v1/referrals/config', { headers: auth })
    ).json()) as { enabled: boolean; signupBonus: string };
    expect(config.enabled).toBe(true);
    expect(config.signupBonus).toBe('2');
    const overview = (await (await app.request('/v1/referrals', { headers: auth })).json()) as {
      affCode: string;
      totalCommission: string;
      invited: Array<{ inviteeId: number; inviteeName: string | null }>;
    };
    expect(overview.affCode).toBe('u1a');
    expect(overview.totalCommission).toBe('4.5');
    expect(overview.invited[0]?.inviteeId).toBe(7);
  });
});

describe('覆盖补充：成功路径与分支变体', () => {
  it('keys patch/rotate/delete 成功路径与全量可选字段', async () => {
    const { app, state } = build();
    expect(state.keysPatchFails).toBe(false);
    const patched = await app.request('/v1/keys/1', {
      method: 'PATCH',
      headers: jsonAuth,
      body: JSON.stringify({
        name: 'n',
        remark: 'r',
        rpmLimit: 10,
        tpmLimit: 100,
        dailySpendLimit: '5',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { rpmLimit: number | null };
    expect(body.rpmLimit).toBe(10);

    const rotated = await app.request('/v1/keys/1/rotate', { method: 'POST', headers: auth });
    expect(rotated.status).toBe(201);
    const deleted = await app.request('/v1/keys/1', { method: 'DELETE', headers: auth });
    expect(await deleted.json()).toEqual({ id: 1 });
  });

  it('keys 创建带未来过期时间与订阅绑定字段', async () => {
    const { app } = build();
    const res = await app.request('/v1/keys', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({
        name: 'full',
        remark: null,
        rpmLimit: 5,
        tpmLimit: 50,
        dailySpendLimit: '1',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        subscriptionId: 5,
      }),
    });
    expect(res.status).toBe(201);
  });

  it('路径参数非法 400 http.invalid_path_param', async () => {
    const { app } = build();
    const res = await app.request('/v1/keys/abc', {
      method: 'PATCH',
      headers: jsonAuth,
      body: JSON.stringify({ name: 'n' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'http.invalid_path_param',
    );
  });

  it('apps 列表与禁用路径', async () => {
    const { app } = build();
    const list = await app.request('/v1/apps?page=1&limit=10', { headers: auth });
    expect(((await list.json()) as { total: number }).total).toBe(0);
    const disable = await app.request('/v1/apps/3/disable', { method: 'POST', headers: auth });
    expect(disable.status).toBe(404);
  });

  it('orgs 详情 / 撤销邀请 / 移除成员；无订阅组织剩余额度为 0', async () => {
    const { app, state } = build();
    const detail = await app.request('/v1/orgs/9', { headers: auth });
    const detailBody = (await detail.json()) as {
      org: { id: number };
      members: unknown[];
      invitations: unknown[];
    };
    expect(detailBody.org.id).toBe(9);
    expect(detailBody.members).toHaveLength(1);

    const revoke = await app.request('/v1/orgs/9/invitations/11/revoke', {
      method: 'POST',
      headers: auth,
    });
    expect(await revoke.json()).toEqual({ ok: true });
    const remove = await app.request('/v1/orgs/9/members/42', { method: 'DELETE', headers: auth });
    expect(await remove.json()).toEqual({ ok: true });

    state.emptyOrgSubs = true;
    const listed = await app.request('/v1/orgs', { headers: auth });
    const { rows } = (await listed.json()) as {
      rows: Array<{ remainingAmount: string; planName: string | null }>;
    };
    expect(rows[0]?.remainingAmount).toBe('0');
    expect(rows[0]?.planName).toBeNull();
  });

  it('钱包账户端点与流水游标参数', async () => {
    const { app } = build();
    const accounts = await app.request('/v1/wallet/accounts', { headers: auth });
    expect(accounts.status).toBe(200);
    const statement = await app.request('/v1/wallet/statement?limit=2&beforeLegId=99', {
      headers: auth,
    });
    expect(statement.status).toBe(200);
  });

  it('订单列表端点', async () => {
    const { app } = build();
    const res = await app.request('/v1/payments/orders?page=1&limit=10', { headers: auth });
    expect(((await res.json()) as { rows: unknown[] }).rows).toHaveLength(0);
  });

  it('usage 过滤参数（from/to/model）与非法分页 400', async () => {
    const { app } = build();
    const ok = await app.request(
      '/v1/usage?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z&model=gpt-x&page=1&limit=10',
      { headers: auth },
    );
    expect(ok.status).toBe(200);
    const byModel = await app.request(
      '/v1/usage/by-model?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z',
      { headers: auth },
    );
    expect(byModel.status).toBe(200);
    const bad = await app.request('/v1/usage?limit=999', { headers: auth });
    expect(bad.status).toBe(400);
  });

  it('订阅变更带幂等键；续费缺省键（服务端生成）', async () => {
    const { app } = build();
    const change = await app.request('/v1/subscriptions/5/change', {
      method: 'POST',
      headers: { ...jsonAuth, 'idempotency-key': 'chg-1' },
      body: JSON.stringify({ targetPlanId: 2, quantity: 1 }),
    });
    expect(change.status).toBe(200);
    const renew = await app.request('/v1/subscriptions/5/renew', { method: 'POST', headers: auth });
    expect(renew.status).toBe(200);
  });

  it('pricing q 过滤与 personal 的 group 系数分支', async () => {
    const { app } = build();
    const q = (await (await app.request('/v1/pricing?q=GPT')).json()) as { total: number };
    expect(q.total).toBe(1);
    const personal = (await (
      await app.request('/v1/pricing/personal?free=true', { headers: auth })
    ).json()) as { models: Array<{ externalName: string; coefficient?: string }> };
    const claude = personal.models.find((m) => m.externalName === 'claude-y');
    expect(claude?.coefficient).toBe('0.8');
  });

  it('oauth authorize next 归一（// 拒绝回落 /dashboard）与未知 provider 回调 404', async () => {
    const { app } = build();
    const bad = await app.request('/v1/oauth/github/authorize?next=//evil.example');
    expect(bad.status).toBe(302);
    const cb = await app.request('/v1/oauth/gitlab/callback?code=c&state=x');
    expect(cb.status).toBe(404);
  });

  it('login verify 载荷缺 uid → 统一 401', async () => {
    const { app, state } = build();
    const challengeId = randomUUID();
    state.challenges.set(challengeId, {});
    const res = await app.request('/v1/auth/login/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId, code: '123456' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('presenters 与纯函数分支', () => {
  it('subscriptions 派生：零额度订阅的 renewPrice/remainingValue', async () => {
    const { toMySubscriptionRow } = await import('../src/http/presenters/subscriptions.js');
    const row = toMySubscriptionRow({
      id: 1,
      planId: 1,
      planName: 'Z',
      planSortOrder: null,
      allowSeats: false,
      periodDays: 30,
      status: 0,
      orgId: null,
      quantity: 1,
      quotaAmount: '0',
      usedAmount: '0',
      reservedAmount: '0',
      price: '10',
      planPrice: '10',
      startAt: new Date(),
      endAt: new Date(),
    });
    expect(row.remainingValue).toBe('0');
    expect(row.renewPrice).toBe('10');
  });

  it('referrals 邀请名回落 email；null 都无则为 null', async () => {
    const { referralOverviewRow } = await import('../src/http/presenters/referrals.js');
    const row = referralOverviewRow(
      {
        affCode: 'u1',
        inviteUrl: 'https://x/i',
        signupBonus: '1',
        commissionRate: '0.1',
        invitees: [
          {
            inviteeUserId: 1,
            inviteeEmail: 'e@x.com',
            inviteeDisplayName: null,
            status: 1,
            createdAt: new Date(),
          },
          {
            inviteeUserId: 2,
            inviteeEmail: null,
            inviteeDisplayName: null,
            status: 1,
            createdAt: new Date(),
          },
        ],
      },
      '0',
    );
    expect(row.invited[0]?.inviteeName).toBe('e@x.com');
    expect(row.invited[1]?.inviteeName).toBeNull();
  });

  it('pricing personal 无快照：coefficient=1、personalized=false', async () => {
    const { app, state } = build();
    state.pricingNoSnapshot = true;
    const personal = (await (
      await app.request('/v1/pricing/personal', { headers: auth })
    ).json()) as { models: Array<{ coefficient?: string; personalized?: boolean }> };
    expect(personal.models[0]?.coefficient).toBe('1');
    expect(personal.models[0]?.personalized).toBe(false);
  });

  it('isValidSpendLimitInput：零/负/科学计数法/垃圾形态 false', async () => {
    const { isValidSpendLimitInput } = await import('../src/http/contracts/shared.js');
    for (const bad of ['0', '-1', '1e3', 'abc', '']) {
      expect(isValidSpendLimitInput(bad), bad).toBe(false);
    }
    expect(isValidSpendLimitInput('12.5')).toBe(true);
  });

  it('orgs 成员限额 month quota 单独修补', async () => {
    const { app } = build();
    const res = await app.request('/v1/orgs/9/members/42', {
      method: 'PATCH',
      headers: jsonAuth,
      body: JSON.stringify({ monthlyQuota: '100' }),
    });
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('分支补充（presenter 单元与缺失变体）', () => {
  it('pricing presenter：缺富化行的默认值与过滤组合', async () => {
    const { toPublicPricingRows, toPersonalPricingRows, slicePricingCatalog } =
      await import('../src/http/presenters/pricing.js');
    const catalog = {
      models: [{ externalName: 'ghost', realModel: 'x', pricingUnit: 'u' }],
      enriched: new Map(),
    };
    const pub = toPublicPricingRows(catalog);
    expect(pub[0]).toMatchObject({ id: 0, inputPrice: '0', isFree: false, contextLength: null });
    const personal = toPersonalPricingRows(catalog, {
      rateCardId: 1,
      status: 0,
      global: '2',
      model: {},
      group: {},
    });
    expect(personal[0]?.coefficient).toBe('2');
    expect(personal[0]?.effective?.inputPrice).toBe('0');
    const sliced = slicePricingCatalog(pub, { q: 'no-match', free: false, page: 1, pageSize: 10 });
    expect(sliced.total).toBe(0);
  });

  it('referrals config 全零 → enabled=false', async () => {
    const { referralConfigView } = await import('../src/http/presenters/referrals.js');
    expect(
      referralConfigView({ referralSignupBonus: '0', referralCommissionRate: '0' }).enabled,
    ).toBe(false);
  });

  it('safeNext 归一分支（undefined/空/协议相对）', async () => {
    const { safeNext } = await import('../src/http/contracts/oauth.js');
    expect(safeNext()).toBe('/dashboard');
    expect(safeNext('')).toBe('/dashboard');
    expect(safeNext('https://evil.example')).toBe('/dashboard');
    expect(safeNext('/ok/path')).toBe('/ok/path');
  });

  it('register/verify 载荷损坏（无 mail/pwd）→ 503 two_factor_unavailable', async () => {
    const { app, state } = build();
    const challengeId = randomUUID();
    state.challenges.set(challengeId, { mail: 'x@y.com' });
    const res = await app.request('/v1/auth/register/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId, code: '123456' }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'client.two_factor_unavailable',
    );
  });

  it('login/verify 未知 uid → 401；封禁 uid → 403', async () => {
    const { app, state } = build();
    const ghost = randomUUID();
    state.challenges.set(ghost, { uid: 999 });
    const res1 = await app.request('/v1/auth/login/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: ghost, code: '123456' }),
    });
    expect(res1.status).toBe(401);

    const banned = randomUUID();
    state.challenges.set(banned, { uid: 43 });
    const res2 = await app.request('/v1/auth/login/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: banned, code: '123456' }),
    });
    expect(res2.status).toBe(403);
  });

  it('stripe 回调带签名头且成功 → received:true', async () => {
    const { app, state } = build();
    state.stripeNotifyOk = true;
    const res = await app.request('/v1/payments/notify/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=abc' },
      body: '{"type":"checkout.session.completed"}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it('usage by-model 不带时间窗（默认 30 天）', async () => {
    const { app } = build();
    const res = await app.request('/v1/usage/by-model', { headers: auth });
    expect(res.status).toBe(200);
  });

  it('shutdown 无 logger 装配分支', async () => {
    const { createClientShutdown } = await import('../src/shutdown.js');
    const calls: string[] = [];
    const exit = ((code: number) => {
      void code;
    }) as unknown as (code: number) => never;
    const shutdown = createClientShutdown({
      serviceName: 't',
      server: {
        close: (cb) => {
          calls.push('server');
          cb();
        },
      },
      otel: { shutdown: () => Promise.resolve() },
      redis: { quit: () => Promise.resolve() },
      db: { end: () => Promise.resolve() },
      graceMs: 5_000,
      exit,
    });
    shutdown('SIGTERM');
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    expect(calls).toEqual(['server']);
  });
});

describe('oauth 社交登录', () => {
  it('providers 目录', async () => {
    const { app } = build();
    const res = await app.request('/v1/oauth/providers');
    expect(await res.json()).toEqual({ providers: ['github'] });
  });

  it('authorize 302 + state cookie 双提交', async () => {
    const { app } = build();
    const res = await app.request('/v1/oauth/github/authorize?next=/billing');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://github.com/login/oauth/authorize?x=1');
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toContain('tl_oauth_state=good-state');
    expect(cookie).toContain('HttpOnly');
  });

  it('未知 provider 404 oauth_unknown', async () => {
    const { app } = build();
    const res = await app.request('/v1/oauth/gitlab/authorize');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'client.oauth_unknown',
    );
  });

  it('callback 双提交不匹配 403；单次消费失败 410；成功 302 fragment 回传', async () => {
    const { app } = build();
    const mismatch = await app.request('/v1/oauth/github/callback?code=c&state=evil');
    expect(mismatch.status).toBe(403);
    expect(((await mismatch.json()) as { error: { code: string } }).error.code).toBe(
      'client.oauth_state_mismatch',
    );

    const { app: app2, state: s2 } = build();
    s2.oauthCallbackState = 'consumed-already';
    const expired = await app2.request('/v1/oauth/github/callback?code=c&state=good-state', {
      headers: { cookie: 'tl_oauth_state=good-state' },
    });
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as { error: { code: string } }).error.code).toBe(
      'identity.oauth_state_invalid',
    );

    const { app: app3 } = build();
    const ok = await app3.request('/v1/oauth/github/callback?code=c&state=good-state', {
      headers: { cookie: 'tl_oauth_state=good-state' },
    });
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toMatch(/#token=signed%3A\d+/);
    expect(ok.headers.get('location')).toContain('https://app.example/dashboard');
  });
});

describe('找回密码(链接制,防枚举)', () => {
  it('存在账号:{ok:true} + 签发令牌 + 投递链接(基地址拼接 /reset-password)', async () => {
    const { app, state } = build();
    const res = await app.request('/v1/auth/forgot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'u@x.com' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(state.sentLinks).toHaveLength(1);
    expect(defined(state.sentLinks[0], 'sentLinks[0]').to).toBe('u@x.com');
    expect(defined(state.sentLinks[0], 'sentLinks[0]').url).toMatch(
      /^https:\/\/console\.example\/reset-password\?token=reset-token-42-1-xxxxxxxxxxxx$/,
    );
  });

  it('不存在账号:同款 {ok:true}(不签发不投递)——枚举不可区分', async () => {
    const { app, state } = build();
    state.usersByEmail.clear();
    const res = await app.request('/v1/auth/forgot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@x.com' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(state.sentLinks).toHaveLength(0);
    expect(state.issuedTokens.size).toBe(0);
  });

  it('封禁账号同走哑成功;同邮箱 60s 第二次 429(哑/真实同键)', async () => {
    const { app, state } = build();
    state.usersByEmail.set('u@x.com', { id: 42, status: 1 });
    const banned = await app.request('/v1/auth/forgot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'u@x.com' }),
    });
    expect(banned.status).toBe(200);
    expect(state.sentLinks).toHaveLength(0);

    state.usersByEmail.set('u@x.com', { id: 42, status: 0 });
    const second = await app.request('/v1/auth/forgot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'u@x.com' }),
    });
    expect(second.status).toBe(429);
  });

  it('reset:有效令牌 → resetPassword(user realm);令牌单次(重放 400)', async () => {
    const { app, state } = build();
    await app.request('/v1/auth/forgot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'u@x.com' }),
    });
    const token = defined([...state.issuedTokens.keys()][0], 'issuedTokens[0]');
    const res = await app.request('/v1/auth/forgot/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password: 'new-password-1' }),
    });
    expect(res.status).toBe(200);
    expect(state.resetCalls).toEqual([
      { userId: 42, realm: 'user', newPassword: 'new-password-1' },
    ]);
    // 单次消费:同令牌重放 → 无效
    const replay = await app.request('/v1/auth/forgot/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password: 'new-password-2x' }),
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: { code: 'client.reset_token_invalid' } });
  });

  it('reset:坏令牌/弱口令 400', async () => {
    const { app } = build();
    const badToken = await app.request('/v1/auth/forgot/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'tok-not-issued-at-all-1234', password: 'new-password-1' }),
    });
    expect(badToken.status).toBe(400);
    const weak = await app.request('/v1/auth/forgot/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'tok-not-issued-at-all-1234', password: 'short' }),
    });
    expect(weak.status).toBe(400);
  });
});

describe('覆盖收尾：纯函数与路由分支变体', () => {
  it('bearerToken:合法/缺头/非 Bearer;guardKeyOf 确定;localeOf 双语', async () => {
    const { bearerToken, localeOf, guardKeyOf } = await import('../src/http/routes/auth.js');
    expect(bearerToken('Bearer  abc ')).toBe('abc');
    expect(bearerToken()).toBe('');
    expect(bearerToken('Basic zzz')).toBe('');
    expect(guardKeyOf('a@b.c', '1.2.3.4')).toBe(guardKeyOf('a@b.c', '1.2.3.4'));
    expect(guardKeyOf('a@b.c', '1.2.3.4')).not.toBe(guardKeyOf('a@b.c', '4.3.2.1'));
    const ctx = (lang: string) =>
      ({ req: { header: () => lang } }) as unknown as Parameters<typeof localeOf>[0];
    expect(localeOf(ctx('zh'))).toBe('zh');
    expect(localeOf(ctx('en-US,en;q=0.9'))).toBe('en');
  });

  it('scheduleWindowsOf:非 schedule/空表/无 label/带 label 四态', async () => {
    const { scheduleWindowsOf } = await import('../src/http/presenters/pricing.js');
    expect(scheduleWindowsOf()).toBeUndefined();
    expect(scheduleWindowsOf({ strategy: 'flat', params: {} })).toBeUndefined();
    expect(scheduleWindowsOf({ strategy: 'schedule', params: { windows: [] } })).toBeUndefined();
    expect(
      scheduleWindowsOf({
        strategy: 'schedule',
        params: { windows: [{ start: 1, end: 2, label: '' }] },
      }),
    ).toEqual([{ start: '1', end: '2' }]);
    expect(
      scheduleWindowsOf({
        strategy: 'schedule',
        params: { windows: [{ start: 1, end: 2, label: '峰' }] },
      }),
    ).toEqual([{ start: '1', end: '2', label: '峰' }]);
  });

  it('parsePricingQuery:free 三态/pageSize 缺省与钳制', async () => {
    const { parsePricingQuery } = await import('../src/http/contracts/pricing.js');
    const base = new URL('https://x/v1/pricing');
    expect(parsePricingQuery(base)).toMatchObject({ free: null, q: '' });
    expect(parsePricingQuery(new URL('https://x/v1/pricing?free=true'))).toMatchObject({
      free: true,
    });
    expect(parsePricingQuery(new URL('https://x/v1/pricing?free=1'))).toMatchObject({ free: true });
    expect(parsePricingQuery(new URL('https://x/v1/pricing?free=other'))).toMatchObject({
      free: false,
    });
    const clamped = parsePricingQuery(new URL('https://x/v1/pricing?pageSize=99999&page=0'));
    expect(clamped.pageSize).toBeLessThanOrEqual(500);
    expect(clamped.page).toBe(1);
    expect(
      parsePricingQuery(new URL('https://x/v1/pricing?pageSize=abc')).pageSize,
    ).toBeGreaterThan(0);
  });

  it('注册:IP 限流 429 + 验证码缺 token 400', async () => {
    const limited = build();
    limited.state.forceRegisterLimit = true;
    const res = await limited.app.request('/v1/auth/register', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ email: 'rl@x.dev', password: 'password123' }),
    });
    expect(res.status).toBe(429);

    // captcha 是装配期展开的依赖——须在 createClientApiApp 前注入(deps 级)
    const captchaParts = createDeps();
    captchaParts.state.capabilities.captchaSiteKey = 'site-key';
    (captchaParts.deps.auth as { captcha: unknown }).captcha = { verify: async () => {} };
    const captchaApp = createClientApiApp(captchaParts.deps);
    const noToken = await captchaApp.request('/v1/auth/register', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ email: 'cap@x.dev', password: 'password123' }),
    });
    expect(noToken.status).toBe(400);
    expect(await noToken.json()).toMatchObject({ error: { code: 'client.captcha_required' } });
  });

  it('注册:功能关闭 403 register_disabled', async () => {
    const closed = build();
    closed.state.capabilities.registerEnabled = false;
    const res = await closed.app.request('/v1/auth/register', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ email: 'off@x.dev', password: 'password123' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'client.register_disabled' } });
  });

  it('oauth 回调:存量用户不可用 403 account_unavailable', async () => {
    const parts = createDeps();
    parts.state.oauthFindUserAs = 43;
    parts.state.oauthUserStatus = 1;
    const app = createClientApiApp(parts.deps);
    const res = await app.request('/v1/oauth/github/callback?code=good&state=good-state', {
      headers: { cookie: 'tl_oauth_state=good-state' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'client.account_unavailable' } });
  });
});
