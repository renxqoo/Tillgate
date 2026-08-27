/**
 * worker 端到端真实 PG（默认门禁按文件名排除，test:real 显式运行）。
 * scratch schema 应用完整迁移链后走**生产拓扑**：gateway 侧（authorize/signal/
 * pg_notify 门铃）→ worker 侧（LISTEN 唤醒 → 认领结算；runners 直驱佣金/对账）。
 *
 *   ① 唤醒→结算闭环：signal succeeded + pg_notify('settle-wake') → worker LISTEN
 *      → 认领结算 → settled + 余额实扣 + usage_logs 投影 + balance_low 告警入箱
 *   ② 佣金日结闭环：被邀请人昨日已结算消费 × marketing_settings 费率 → 邀请人入账；
 *      重跑幂等（自然键重放不重复入账）
 *   ③ 对账闭环：人为破坏账户余额 → verifyInvariants 捕获 → reconcile_discrepancies
 *      落表 + reconcile_discrepancy 告警入箱
 * 环境：DB_TEST_URL / DATABASE_URL；不可达整组跳过。隔离 schema 自建自清。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, pgSqlState, type Db } from '@tillgate/db';
import { defined } from './defined.js';
import { createBillingApi, createDefaultFundingRegistry, createWalletApi } from '@tillgate/billing';
import {
  createPostgresBillingStore,
  createPostgresWalletStore,
} from '@tillgate/billing/composition';
import { assembleWorker } from '../src/assembly';
import type { WorkerAssembly } from '../src/assembly';
import { loadWorkerConfig } from '../src/config';

const url = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
const SCHEMA = `tillgate_worker_e2e_${process.pid.toString(36)}`;
const TX_RETRY = { maxAttempts: 5, baseDelayMs: 15, maxJitterMs: 20 } as const;

/** gateway 侧门铃（与 gateway adapters/settle-wake.ts 同语义：fire-and-forget pg_notify） */
async function settleWakeChime(db: Db, requestId: string): Promise<void> {
  await db.$client.unsafe('select pg_notify($1, $2)', ['settle-wake', requestId]);
}

async function pollUntil(predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return await predicate();
}

/** 池直发原生查询（unsafe 裸文本+参,不依赖 drizzle 面） */
async function query<T extends Record<string, unknown>>(db: Db, text: string, values?: unknown[]) {
  return (await db.$client.unsafe<T[]>(text, values)) as T[];
}

/** 42P01 = 跨链引用缺口（迁移链顺序问题——与 billing real 门一致的容错口径） */
function isMissingTableError(error: unknown): boolean {
  // pgSqlState 双字段探测(pg=code / Bun SQL=errno)——手写 .code 检查在 Bun SQL
  // 下恒 false,容错回放失效(首个跨链引用缺口即中止套件)
  return pgSqlState(error) === '42P01';
}

function receiptOf(requestId: string, userId: number) {
  return {
    requestId,
    userId,
    apiKeyId: null,
    appId: null,
    credentialType: 'key' as const,
    externalModel: 'm',
    realModel: 'm',
    channelId: null,
    channelKey: 'e2e',
    usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    inputPrice: '2',
    outputPrice: '0',
    cacheInputPrice: '0',
    cacheWritePrice: '0',
    unitPrice: '0',
    coefficient: '1',
    durationMs: 10,
    stream: false,
    streamAborted: false,
    mappingId: 1,
    billingPolicyFingerprint: null,
  };
}

interface E2E {
  gatewayDb: Db;
  worker: WorkerAssembly;
  seedUser: () => Promise<number>;
}

(url && process.env.REDIS_URL ? describe : describe.skip)(
  'worker 端到端（真实 PG，生产拓扑）',
  () => {
    let e2e: E2E | null = null;

    beforeAll(async () => {
      const [baseUrl] = defined(url, 'DB_TEST_URL').split('?');
      const scopedUrl = `${baseUrl}?options=-c%20search_path%3D${SCHEMA}`;
      const gatewayDb = createDb({
        url: scopedUrl,
        poolMax: 5,
        idleTimeoutMillis: 5_000,
        connectionTimeoutMillis: 3_000,
      });
      // scratch schema + 完整迁移链（容错 42P01：跨链引用缺口口径与 billing real 门一致）
      await query(gatewayDb, `drop schema if exists ${SCHEMA} cascade`);
      await query(gatewayDb, `create schema ${SCHEMA}`);
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => /^\d{4}_.*\.sql$/.test(f))
        .toSorted();
      for (const file of files) {
        const text = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf-8');
        for (const statement of text.split('--> statement-breakpoint')) {
          const trimmed = statement
            .trim()
            .replaceAll('public.', `${SCHEMA}.`)
            .replaceAll('"public"', `"${SCHEMA}"`);
          if (!trimmed) continue;
          try {
            await query(gatewayDb, trimmed);
          } catch (error) {
            if (!isMissingTableError(error)) throw error;
          }
        }
      }
      // worker 装配（唤醒开、投递循环静音、低余额阈值抬高以触发钩子断言）
      const config = loadWorkerConfig({
        NODE_ENV: 'test',
        DATABASE_URL: scopedUrl,
        CHANNEL_API_KEY_ENCRYPTION: `wk3y-zx9q-e2e-${'pad'.repeat(6)}`,
        OTEL_TRACES_MODE: 'off',
        WORKER_OWNER_ID: 'e2e-worker',
        WORKER_SETTLE_WAKE: 'true',
        WORKER_NOTIFY_ENABLED: 'false',
        WORKER_BALANCE_LOW_THRESHOLD: '100',
        // BullMQ 结算调度 fail-closed(真实通道口径:REDIS_URL 根 .env 必配)
        REDIS_URL: defined(process.env.REDIS_URL, 'REDIS_URL'),
      } as unknown as NodeJS.ProcessEnv);
      const worker = assembleWorker(config);
      await pollUntil(async () => {
        // 唤醒监听建立探测（空批无害）——直到 LISTEN 生效
        await settleWakeChime(gatewayDb, 'e2e-listen-probe');
        return false;
      }, 800).catch(() => {});
      let userSeq = 0;
      e2e = {
        gatewayDb,
        worker,
        seedUser: async () => {
          userSeq += 1;
          const email = `e2e-${Date.now()}-${userSeq}@test`;
          const rows = await query<{ id: string }>(
            gatewayDb,
            `insert into users (issuer, subject, identity_provider, email)
           values ('local', $1, 'local', $1) returning id`,
            [email],
          );
          return Number(defined(rows[0], 'rows[0]').id);
        },
      };
    }, 120_000);

    afterAll(async () => {
      if (!e2e) return;
      try {
        await e2e.worker.wakeup?.close();
        await e2e.worker.closeDb().catch(() => {});
        await query(e2e.gatewayDb, `drop schema if exists ${SCHEMA} cascade`);
      } finally {
        await closeDb(e2e.gatewayDb).catch(() => {});
      }
    });

    it('① 唤醒→结算闭环：signal+pg_notify → LISTEN → 认领结算（余额实扣/投影/低余额告警）', async () => {
      if (!e2e) return;
      const { gatewayDb, worker } = e2e;
      // gateway 侧装配（authorize/signal 面——与生产 gateway 同构）
      const walletStore = createPostgresWalletStore(gatewayDb, { retry: TX_RETRY });
      const billingStore = createPostgresBillingStore(gatewayDb, { retry: TX_RETRY });
      const gatewayWallet = createWalletApi({
        store: walletStore,
        guards: {
          refTypes: ['billing', 'topup', 'admin'],
          currencies: ['CNY'],
          internalAccounts: ['outside', 'platform_revenue'],
        },
        currency: 'CNY',
      });
      const gatewayBilling = createBillingApi({
        store: billingStore,
        resolver: {
          resolve: async () => ({
            subscriptionId: null,
            allowPaygFallback: true,
            userDailyLimit: null,
            keyDailyLimit: null,
          }),
        },
        quota: billingStore.quotaStore,
        channels: billingStore.channelStore,
        walletStore,
        wallet: gatewayWallet,
        currency: 'CNY',
        clock: () => new Date(),
      });
      void createDefaultFundingRegistry; // 资金瀑布在 authorize 内经 store 直查（payg 路径）

      const userId = await e2e.seedUser();
      await gatewayWallet.credit({
        userId,
        amount: '10',
        refType: 'topup',
        refId: `e2e-topup-${userId}`,
      });
      const requestId = '00000000-0000-4000-8000-00000000e2e1';
      await gatewayBilling.authorize({
        requestId,
        userId,
        stream: false,
        quote: {
          maxOutputTokens: 0,
          candidates: [
            {
              mappingId: 1,
              externalModel: 'm',
              realModel: 'm',
              inputPrice: '2',
              outputPrice: '0',
              cacheInputPrice: '0',
              coefficient: '1',
              inputTokenUpperBound: 1_000_000,
              billingPolicyFingerprint: null,
            },
          ],
        },
        reservationLimit: '10',
        authorizationTtlMs: 60_000,
      });
      await gatewayBilling.signal({
        type: 'request.succeeded',
        requestId,
        receipt: receiptOf(requestId, userId) as never,
      });
      // 生产门铃：signal 后 pg_notify（丢失由兜底扫描覆盖——此处直发主路径）
      await settleWakeChime(gatewayDb, requestId);

      const settled = await pollUntil(async () => {
        const rows = await query<{ status: string }>(
          gatewayDb,
          'select status from billing_requests where request_id = $1',
          [requestId],
        );
        return rows[0]?.status === 'settled';
      });
      expect(settled).toBe(true);

      // 余额实扣（10 − 2）
      const account = await query<{ balance: string; in_flight: string }>(
        gatewayDb,
        `select balance, in_flight from wallet_accounts where kind = 'user' and user_id = $1`,
        [userId],
      );
      const accountRow = defined(account[0], 'account[0]');
      expect(Number(accountRow.balance)).toBe(8);
      expect(Number(accountRow.in_flight)).toBe(0);
      // usage_logs 投影
      const usage = await query<{ n: string }>(
        gatewayDb,
        'select count(*)::text as n from usage_logs where request_id = $1',
        [requestId],
      );
      expect(defined(usage[0], 'usage[0]').n).toBe('1');
      // balance_low 钩子（阈值 100 > 余额 8）：按用户×日幂等入箱
      const alerts = await query<{ event: string }>(
        gatewayDb,
        `select event from notify_outbox where event = 'balance_low' and dedupe_key = $1`,
        [`balance-low:${userId}:${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`],
      );
      expect(alerts).toHaveLength(1);
      void worker;
    }, 30_000);

    it('② 佣金日结闭环：昨日已结算消费 × 费率入账；重跑幂等', async () => {
      if (!e2e) return;
      const { gatewayDb, worker } = e2e;
      await query(
        gatewayDb,
        `insert into marketing_settings (id, referral_commission_rate)
      values (1, '0.1') on conflict (id) do update set referral_commission_rate = '0.1'`,
      );
      const inviterId = await e2e.seedUser();
      const inviteeId = await e2e.seedUser();
      await query(
        gatewayDb,
        `insert into referrals (inviter_user_id, invitee_user_id)
      values ($1, $2)`,
        [inviterId, inviteeId],
      );
      const dayKey = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
      await query(
        gatewayDb,
        `insert into usage_logs (request_id, user_id, credential_type, external_model, real_model,
         coefficient, billed_by, amount, plan_amount, payg_amount, calculated_amount, status, created_at)
       values ($1, $2, 'key', 'm', 'm', '1', 'payg', '10', '0', '10', '10', 0, now() - interval '1 day')`,
        [`00000000-0000-4000-8000-0000000${dayKey}`.slice(0, 36), inviteeId],
      );

      const referralRunner = defined(worker.runners.referral, 'runners.referral');
      const first = (await referralRunner()) as { credited: number };
      expect(first.credited).toBe(1);
      const afterFirst = await query<{ balance: string }>(
        gatewayDb,
        `select balance from wallet_accounts where kind = 'user' and user_id = $1`,
        [inviterId],
      );
      expect(Number(defined(afterFirst[0], 'afterFirst[0]').balance)).toBe(1);
      // 幂等：同日重跑零新入账、余额不翻倍
      const second = (await referralRunner()) as { credited: number };
      expect(second.credited).toBe(0);
      const afterSecond = await query<{ balance: string }>(
        gatewayDb,
        `select balance from wallet_accounts where kind = 'user' and user_id = $1`,
        [inviterId],
      );
      expect(Number(defined(afterSecond[0], 'afterSecond[0]').balance)).toBe(1);
    }, 30_000);

    it('③ 对账闭环：人为破坏余额 → verifyInvariants 捕获 → 差异落表 + 告警入箱', async () => {
      if (!e2e) return;
      const { gatewayDb, worker } = e2e;
      const before = await query<{ n: string }>(
        gatewayDb,
        'select count(*)::text as n from reconcile_discrepancies',
      );
      expect(defined(before[0], 'before[0]').n).toBe('0');
      // 破坏：账户余额 ≠ 末腿 balance_after。直改被一致性触发器拦截（账本自卫）——
      // 禁用该触发器模拟「事后漂移」（对账哨兵的存在理由：捕获绕过写路径的腐化）
      await query(
        gatewayDb,
        'alter table wallet_accounts disable trigger wallet_accounts_coherence_ck',
      );
      await query(
        gatewayDb,
        `update wallet_accounts set balance = balance + 1 where kind = 'user'`,
      );
      const result = (await defined(worker.runners.reconcile, 'runners.reconcile')()) as {
        ran: boolean | null;
        violations: number;
        inserted: number;
        alerted: boolean;
      };
      expect(result.ran).toBe(true);
      expect(result.violations).toBeGreaterThanOrEqual(1);
      expect(result.inserted).toBe(result.violations);
      expect(result.alerted).toBe(true);
      const rows = await query<{ n: string; scope: string }>(
        gatewayDb,
        'select count(*)::text as n, min(scope) as scope from reconcile_discrepancies',
      );
      expect(Number(defined(rows[0], 'rows[0]').n)).toBe(result.violations);
      const alert = await query<{ event: string }>(
        gatewayDb,
        `select event from notify_outbox where event = 'reconcile_discrepancy'`,
      );
      expect(alert.length).toBeGreaterThanOrEqual(1);
    }, 30_000);
  },
);
