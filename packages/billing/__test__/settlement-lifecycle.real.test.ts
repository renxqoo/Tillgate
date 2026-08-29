/**
 * 计费全链真实 PostgreSQL 生命周期（授权 → 渠道认领 → 信号 → 结算 → 恢复）：
 * scratch schema 应用完整迁移链 0000→0075（顺带验证空库升级路径），种子最小 users 行。
 * 验证真实语义：SKIP LOCKED 认领、五元组 CAS、租约、守卫原子 UPDATE、触发器不变量、
 * 并发认领恰好一方结算。默认门禁排除，经 test:real 运行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { closeDb, createDb, type Db } from '@tillgate/db';
import { Decimal } from '../src/domain/money.js';
import { createPostgresWalletStore } from '../src/adapters/postgres/wallet-store.js';
import { createPostgresBillingStore } from '../src/adapters/postgres/billing-store.js';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import {
  createBillingApi,
  createDefaultFundingRegistry,
} from '../src/application/billing/billing.js';
import { createSettlementApi } from '../src/application/settlement/settlement.js';
import { causeChainHasCode, V1_RETRY } from './real-pg.js';
import { defined } from './defined.js';

const url = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

let reqSeq = 0;
const nextRequestId = () => {
  const n = (reqSeq += 1);
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}${'0'.repeat(12 - hex.length)}`.slice(0, 36);
};

function quote(input: string, channelId: number | null = null, amount = '2') {
  return {
    maxOutputTokens: 0,
    candidates: [
      {
        mappingId: 1,
        externalModel: 'm',
        realModel: 'm',
        inputPrice: amount,
        outputPrice: '0',
        cacheInputPrice: '0',
        coefficient: '1',
        inputTokenUpperBound: 1_000_000,
        ...(channelId != null ? { channelId } : {}),
        billingPolicyFingerprint: null,
      },
    ],
  };
}

const SCHEMA_NAME = `tillgate_billing_life_${process.pid.toString(36)}`;

function lifeReceipt(requestId: string, uid: number, inputTokens = 1_000_000) {
  return {
    requestId,
    userId: uid,
    apiKeyId: null,
    appId: null,
    credentialType: 'key',
    externalModel: 'm',
    realModel: 'm',
    channelId: null,
    channelKey: 't',
    usage: { inputTokens, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    inputPrice: '2',
    outputPrice: '0',
    cacheInputPrice: '0',
    coefficient: '1',
    durationMs: 10,
    stream: false,
    streamAborted: false,
    mappingId: 1,
    billingPolicyFingerprint: null,
  };
}

(url ? describe : describe.skip)('计费全链真实 PG', () => {
  let db: Db;
  let wallet: ReturnType<typeof createWalletApi>;
  let billing: ReturnType<typeof createBillingApi>;
  let settlement: ReturnType<typeof createSettlementApi>;
  let channelId: number;
  let userSeq = 0;
  const seedUser = async (): Promise<number> => {
    userSeq += 1;
    const row = await db.execute<{ id: number }>(sql`
      insert into users (issuer, subject, identity_provider, email)
      values ('local', ${`life-${Date.now()}-${userSeq}@test`}, 'local', ${`life-${Date.now()}-${userSeq}@test`})
      returning id`);
    return Number(defined(row[0]).id);
  };

  beforeAll(async () => {
    const schema = SCHEMA_NAME;
    const [baseUrl] = defined(url).split('?');
    db = createDb({
      url: `${baseUrl}?options=-c%20search_path%3D${schema}`,
      poolMax: 5,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 3_000,
    });
    await db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
    await db.execute(sql.raw(`create schema ${schema}`));
    // 完整迁移链 + 容错应用：db 链存在跨链引用（identity-core provision 等建的表，
    // 如 identity_session_anchors）；
    // 本测试只容忍 42P01（缺外部链表），其余错误照常失败。
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .toSorted();
    const skipped: string[] = [];
    for (const file of files) {
      const text = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
      for (const statement of text.split('--> statement-breakpoint')) {
        // 个别迁移硬编码 public. 前缀——重写到隔离 schema（DDL 语句内无业务字符串）
        const trimmed = statement
          .trim()
          .replaceAll('public.', `${schema}.`)
          .replaceAll('"public"', `"${schema}"`);
        if (!trimmed) continue;
        try {
          await db.execute(sql.raw(trimmed));
        } catch (error) {
          // drizzle 包装 pg 错误——沿 cause 链探测 SQLSTATE
          if (causeChainHasCode(error, '42P01')) {
            skipped.push(trimmed.slice(0, 60));
            continue;
          }
          throw error;
        }
      }
    }
    void skipped;
    // 种子：users（billing_requests FK）+ channels（渠道敞口）
    const provider = await db.execute<{ id: number }>(sql`
      insert into providers (name, base_url) values ('life-provider', 'http://upstream') returning id`);
    const channel = await db.execute<{ id: number }>(sql`
      insert into channels (provider_id, name, api_key_enc, priority, weight, status, upstream_budget, upstream_threshold)
      values (${Number(defined(provider[0]).id)}, 'life', 'enc', 0, 1, 0, '10', '1')
      returning id`);
    channelId = Number(defined(channel[0]).id);

    const walletStore = createPostgresWalletStore(db, { retry: V1_RETRY });
    const billingStore = createPostgresBillingStore(db, { retry: V1_RETRY });
    wallet = createWalletApi({
      store: walletStore,
      guards: {
        refTypes: ['billing', 'topup', 'admin'],
        currencies: ['CNY'],
        internalAccounts: ['outside', 'platform_revenue'],
      },
      currency: 'CNY',
    });
    billing = createBillingApi({
      store: billingStore,
      resolver: {
        resolve: () =>
          Promise.resolve({
            subscriptionId: null,
            allowPaygFallback: true,
            userDailyLimit: null,
            keyDailyLimit: null,
          }),
      },
      quota: billingStore.quotaStore,
      channels: billingStore.channelStore,
      walletStore,
      wallet,
      currency: 'CNY',
      clock: () => new Date(),
    });
    settlement = createSettlementApi({
      store: billingStore,
      walletStore,
      fundingRegistry: createDefaultFundingRegistry({
        wallet,
        walletStore,
        store: billingStore,
        quota: billingStore.quotaStore,
      }),
      channels: billingStore.channelStore,
      usageDefectBreaker: 5,
      failurePolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
      clock: () => new Date(),
      onError: () => {},
    });
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql.raw(`drop schema if exists ${SCHEMA_NAME} cascade`));
      await closeDb(db);
    }
  });

  it('全链：充值 → 授权 → 渠道认领 → 成功信号 → 认领结算（钱包/账单/投影/渠道全落定）', async () => {
    const userId = await seedUser();
    await wallet.credit({ userId, amount: '10', refType: 'topup', refId: nextRequestId() });
    const requestId = nextRequestId();
    const authorization = await billing.authorize({
      requestId,
      userId,
      stream: false,
      quote: quote(requestId, channelId),
      reservationLimit: '10',
      authorizationTtlMs: 60_000,
    });
    expect(authorization).toMatchObject({ reservedAmount: '2', replayed: false });
    expect(defined((await wallet.accounts(userId))[0]).inFlight).toBe('2');

    // 渠道预留 ≥ 收据官方成本（B4 经济闭合：预留=物理最坏 Case；留 1.5 会被
    // 结算验收门判 upstreamCost 2 > reserved 死信——旧值违反不变量）
    const reserved = await billing.reserveChannel({ requestId, channelId, amount: '2' });
    expect(reserved).toMatchObject({ allowed: true });

    const signaled = await billing.signal({
      type: 'request.succeeded',
      requestId,
      receipt: lifeReceipt(requestId, userId),
    });
    expect(signaled).toMatchObject({ changed: true, status: 'settlement_pending' });

    const claims = await settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 10_000 });
    expect(claims.map((c) => c.requestId)).toContain(requestId);
    const claim = defined(claims.find((c) => c.requestId === requestId));
    const outcome = await settlement.processClaim(claim);
    expect(outcome).toBe('settled');

    const account = defined((await wallet.accounts(userId))[0]);
    expect(account.balance).toBe('8');
    expect(account.inFlight).toBe('0');
    const usage = await db.execute<{ calculated_amount: string; billed_by: string }>(sql`
      select calculated_amount, billed_by from usage_logs where request_id = ${requestId}::uuid`);
    // numeric(38,18) 返回带尾零的定标串——规范化后比较
    expect(defined(usage[0]).billed_by).toBe('payg');
    expect(String(defined(usage[0]).calculated_amount).replace(/\.?0+$/, '')).toBe('2');
    const status = await db.execute<{ status: string }>(sql`
      select status from billing_requests where request_id = ${requestId}::uuid`);
    expect(defined(status[0]).status).toBe('settled');
    // 渠道：敞口归还 + 预算按官方成本扣减
    const channel = await db.execute<{ upstream_reserved: string; upstream_budget: string }>(sql`
      select upstream_reserved, upstream_budget from channels where id = ${channelId}`);
    // Bun SQL 解析 numeric 零为裸 '0'(pg 为定标串)——Decimal 化双形态等价比较
    expect(new Decimal(String(defined(channel[0]).upstream_reserved)).toString()).toBe('0');
    expect(String(defined(channel[0]).upstream_budget).replace(/\.?0+$/, '')).toBe('8'); // 10 − 2
    // 对账哨兵：真实触发器下零漂移
    expect((await settlement.verifyInvariants()).ok).toBe(true);
  });

  it('并发认领恰好一方结算：双 worker 同批认领，输家 claim_lost / already_settled', async () => {
    const userId = await seedUser();
    await wallet.credit({ userId, amount: '10', refType: 'topup', refId: nextRequestId() });
    const requestId = nextRequestId();
    await billing.authorize({
      requestId,
      userId,
      stream: false,
      quote: quote(requestId),
      reservationLimit: '10',
      authorizationTtlMs: 60_000,
    });
    await billing.signal({
      type: 'request.succeeded',
      requestId,
      receipt: lifeReceipt(requestId, userId),
    });
    const both = await Promise.all([
      settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 10_000 }),
      settlement.claim({ ownerId: 'w2', batchSize: 10, claimLeaseMs: 10_000 }),
    ]);
    // SKIP LOCKED：同一请求只被一方认领
    const owners = both.flat().filter((c) => c.requestId === requestId);
    expect(owners.length).toBe(1);
    const [winnerOutcome, loserOutcome] = await Promise.all([
      settlement.processClaim(defined(owners[0])),
      settlement.processClaim({
        requestId,
        ownerId: defined(owners[0]).ownerId === 'w1' ? 'w2' : 'w1',
        claimToken: '00000000-0000-4000-8000-00000000dead',
        revision: 0,
        attempt: 1,
        // 输家带合法收据：解码通过 → 五元组失配 → claim_lost（毒收据会走 dead）
        receipt: lifeReceipt(requestId, userId) as unknown as Record<string, unknown>,
        traceParent: null,
      }),
    ]);
    expect(winnerOutcome).toBe('settled');
    expect(loserOutcome).toBe('claim_lost');
    expect(defined((await wallet.accounts(userId))[0]).balance).toBe('8'); // 本测试独立用户：10 − 2
  });

  it('毒收据死信（真实 CAS）：状态 dead + settlement_attempts 保留', async () => {
    const userId = await seedUser();
    await wallet.credit({ userId, amount: '10', refType: 'topup', refId: nextRequestId() });
    const requestId = nextRequestId();
    await billing.authorize({
      requestId,
      userId,
      stream: false,
      quote: quote(requestId),
      reservationLimit: '10',
      authorizationTtlMs: 60_000,
    });
    await billing.signal({
      type: 'request.succeeded',
      requestId,
      receipt: lifeReceipt(requestId, userId),
    });
    // 制毒：收据价格改垃圾串（decode 守卫 → 死信家族）
    await db.execute(sql`
      update billing_requests set receipt = jsonb_set(receipt, '{inputPrice}', '"garbage"')
      where request_id = ${requestId}::uuid`);
    const [claim] = await settlement.claim({ ownerId: 'w1', batchSize: 10, claimLeaseMs: 10_000 });
    const outcome = await settlement.processClaim(defined(claim));
    expect(outcome).toBe('dead');
    const row = await db.execute<{ status: string }>(sql`
      select status from billing_requests where request_id = ${requestId}::uuid`);
    expect(defined(row[0]).status).toBe('dead');
    // 预扣保留（死信人工复核出口——资金不丢）
    expect(defined((await wallet.accounts(userId))[0]).inFlight).toBe('2');
  });

  it('恢复：过期授权真实 CAS 归还（released + 钱包在途归零）', async () => {
    const userId = await seedUser();
    await wallet.credit({ userId, amount: '10', refType: 'topup', refId: nextRequestId() });
    const requestId = nextRequestId();
    await billing.authorize({
      requestId,
      userId,
      stream: false,
      quote: quote(requestId),
      reservationLimit: '10',
      authorizationTtlMs: -1, // 立即过期
    });
    const result = await settlement.recover({ batchSize: 10 });
    expect(result.released).toBeGreaterThanOrEqual(1);
    const row = await db.execute<{ status: string }>(sql`
      select status from billing_requests where request_id = ${requestId}::uuid`);
    expect(defined(row[0]).status).toBe('released');
    expect(defined((await wallet.accounts(userId))[0]).inFlight).toBe('0');
    expect((await settlement.verifyInvariants()).ok).toBe(true);
  });
});
