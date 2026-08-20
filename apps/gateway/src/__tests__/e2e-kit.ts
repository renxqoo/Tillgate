/**
 * E2E 共享基建：真网关进程（全真装配）+ 平台 key 发放 + 资金对账工具。
 * 供 e2e-*.test.ts 套件复用（含真上游 MiniMax RX-M3 的场景注入小请求控成本）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { createDb } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { Decimal } from '@ai-gateway/domain';
import { createSettlementDomain, createWallet, systemContext, type RunContext } from '@ai-gateway/service';
import { assembleGateway } from '../assembly.js';
import { createApp } from '../app.js';

export const E2E_MODEL = 'RX-M3';

export function e2eDb(): Db {
  return createDb(
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
    { poolMax: 16 },
  );
}

/** 根 .env 的 ENCRYPTION_KEY（渠道密钥解密口径与生产装配一致；逐级向上定位） */
export function encryptionKeyOf(): string {
  const candidates = [
    new URL('../../../../.env', import.meta.url),
    new URL('../../../../../.env', import.meta.url),
  ].map((u) => u.pathname);
  const path = candidates.find((c) => existsSync(c));
  if (!path) throw new Error(`.env 未找到（尝试过 ${candidates.join('、')}）`);
  const line = readFileSync(path, 'utf8').split('\n').find((l) => l.startsWith('ENCRYPTION_KEY='));
  if (!line) throw new Error('.env 缺 ENCRYPTION_KEY');
  return line.slice(line.indexOf('=') + 1).trim();
}

export interface E2EGateway {
  baseUrl: string;
  assembly: ReturnType<typeof assembleGateway>;
  server: ServerType;
  stop(): Promise<void>;
}

/** 起真网关（全真装配：真 ai 适配器/真计费/真路由；无 Redis=单副本形态） */
export async function startE2EGateway(db: Db, extra: Record<string, unknown> = {}): Promise<E2EGateway> {
  const assembly = assembleGateway({
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://:root123@localhost:6379',
    PORT: 0,
    DB_POOL_MAX: 40,
    GATEWAY_CURRENCY: 'CNY',
    ADMISSION_MAX_PENDING: 10_000,
    ADMISSION_MAX_OLDEST_MS: 300_000,
    BILLING_RESERVATION_MAX: '1000',
    BILLING_RESERVATION_MODE: 'full' as const,
    BILLING_FIXED_RESERVATION_AMOUNT: undefined,
    BILLING_AUTHORIZATION_TTL_MS: 300_000,
    GENERATION_TASK_TTL_MS: 3_600_000,
    GENERATION_LEASE_GRACE_MS: 30_000,
    DEFAULT_MAX_OUTPUT_TOKENS: 4_096,
    GATEWAY_OUTPUT_EXPOSURE_CAP: 32_768,
    CHANNEL_API_KEY_ENCRYPTION: encryptionKeyOf(),
    JWT_SECRET: 'v2e2e-jwt-secret-0123456789abcdef',
    JWT_TOKEN_TTL_SECONDS: 3_600,
    GATEWAY_UPSTREAM_DEADLINE_MS: 120_000,
    GATEWAY_SHUTDOWN_GRACE_MS: 15_000,
    OTEL_TRACES_MODE: 'off' as const,
    ...extra,
  } as never);
  const app = createApp({
    db: assembly.db,
    runChat: assembly.runChat,
    submitGeneration: assembly.submitGeneration,
    oauth: assembly.oauth,
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return {
    baseUrl,
    assembly,
    server,
    async stop() {
      ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await assembly.db.$client.end().catch(() => {});
    },
  };
}

/** 平台 key 台账（发 key / 充值 / 对账 / 清理） */
export class E2EKeys {
  readonly users: number[] = [];
  readonly keys: number[] = [];
  private readonly wallet: ReturnType<typeof createWallet>;
  private readonly settlement: ReturnType<typeof createSettlementDomain>;

  constructor(private readonly db: Db) {
    this.wallet = createWallet({
      db, currency: 'CNY',
      guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
    });
    this.settlement = createSettlementDomain({
      db, currency: 'CNY', policy: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
    });
  }

  /** 建用户 + 充值 + 发 ag_ key（真实网关用它鉴权计费） */
  async issue(amount: string): Promise<{ raw: string; userId: number }> {
    const ctx: RunContext = systemContext(randomUUID());
    const { users: usersTable, apiKeys: apiKeysTable } = await import('@ai-gateway/db');
    const [user] = await this.db
      .insert(usersTable)
      .values({ issuer: 'v2e2e', subject: `v2e2e-${randomUUID().slice(0, 8)}`, identityProvider: 'local' })
      .returning({ id: usersTable.id });
    this.users.push(user!.id);
    await this.wallet.credit(ctx, { userId: user!.id, amount, refType: 'topup', refId: `v2e2e-${randomUUID().slice(0, 10)}` });
    const raw = `ag_${randomUUID().replace(/-/g, '')}`;
    const [key] = await this.db
      .insert(apiKeysTable)
      .values({ keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: 'ag_****', userId: user!.id, name: 'v2e2e' })
      .returning({ id: apiKeysTable.id });
    this.keys.push(key!.id);
    return { raw, userId: user!.id };
  }

  async walletOf(userId: number): Promise<{ balance: string; inFlight: string }> {
    const rows = await this.wallet.accounts(systemContext(randomUUID()), userId);
    return { balance: rows[0]!.balance, inFlight: rows[0]!.inFlight };
  }

  async billsOf(userId: number): Promise<Array<{ request_id: string; status: string; reserved_amount: string; receipt: Record<string, unknown> | null }>> {
    const rows = await this.db.$client.query(
      'select request_id, status, reserved_amount, receipt from billing_requests where user_id = $1', [userId],
    );
    return rows.rows;
  }

  /**
   * 驱动结算（定向认领）直到该用户无 settlement_pending。
   * 共享 dev 库竞态（AGENT.md §5.7）：外部活 worker 可能先 SKIP LOCKED 抢领——
   * 此时行进入 processing（租约内），本方法的 pending 查询为空但尚未 settled。
   * 容忍策略：pending 空后再等 processing 清零（外部 worker 在租约内会完成；
   * 上限 30s 防崩驻 worker 卡死测试）。
   */
  async settleAll(userId: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const pending = await this.db.$client.query<{ request_id: string }>(
        "select request_id from billing_requests where user_id = $1 and status = 'settlement_pending' limit 50", [userId],
      );
      if (pending.rows.length === 0) {
        const busy = await this.db.$client.query<{ n: number }>(
          "select count(*)::int as n from billing_requests where user_id = $1 and status = 'processing'", [userId],
        );
        if (busy.rows[0]!.n === 0 || Date.now() > deadline) return;
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if (Date.now() > deadline) return;
      const claims = await this.settlement.claim(systemContext(randomUUID()), {
        ownerId: `v2e2e-${randomUUID().slice(0, 8)}`, batchSize: 50, claimLeaseMs: 60_000,
        requestIds: pending.rows.map((r) => r.request_id),
      });
      for (const claim of claims) await this.settlement.processClaim(systemContext(randomUUID()), claim);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** 强对账：余额 == 充值合计 − Σ实扣（usage_logs），在途 == 0 */
  async assertReconciled(userId: number, funded: string): Promise<{ balance: string; charged: string }> {
    const usage = await this.db.$client.query<{ sum: string | null }>(
      'select sum(amount)::text as sum from usage_logs where user_id = $1', [userId],
    );
    const walletState = await this.walletOf(userId);
    const charged = usage.rows[0]!.sum ?? '0';
    expectDecimalEq(walletState.balance, new Decimal(funded).minus(charged).toString());
    expectDecimalEq(walletState.inFlight, '0');
    return { balance: walletState.balance, charged };
  }

  /** 快照并还原共享渠道预算（不打扰 dev 环境共享渠道） */
  async snapshotChannelBudget(channelId: number): Promise<() => Promise<void>> {
    const snap = await this.db.$client.query<{ budget: string }>(
      'select upstream_budget::text as budget from channels where id = $1', [channelId],
    );
    const original = snap.rows[0]!.budget;
    return async () => {
      await this.db.$client
        .query('update channels set upstream_budget = $1, upstream_reserved = 0 where id = $2', [original, channelId])
        .catch(() => {});
    };
  }

  async cleanup(): Promise<void> {
    if (this.users.length) {
      const billRows = await this.db.$client.query<{ request_id: string }>(
        'select request_id from billing_requests where user_id = any($1)', [this.users],
      );
      const billIds = billRows.rows.map((r) => r.request_id);
      if (billIds.length) {
        await this.db.$client.query('delete from billing_reservations where billing_request_id = any($1::uuid[])', [billIds]);
        await this.db.$client.query('delete from usage_logs where request_id = any($1::uuid[])', [billIds]);
        await this.db.$client.query('delete from billing_requests where request_id = any($1::uuid[])', [billIds]);
      }
      await this.db.$client.query('delete from generation_tasks where user_id = any($1)', [this.users]);
    }
    if (this.keys.length) await this.db.$client.query('delete from api_keys where id = any($1)', [this.keys]);
    if (this.users.length) await this.db.$client.query('delete from users where id = any($1)', [this.users]);
  }
}

function expectDecimalEq(actual: string, expected: string): void {
  if (!new Decimal(actual).eq(expected)) {
    throw new Error(`对账失败：实际 ${actual} ≠ 期望 ${expected}`);
  }
}

export const e2ePost = (baseUrl: string, raw: string, body: Record<string, unknown>, signal?: AbortSignal) =>
  fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
