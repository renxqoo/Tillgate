/**
 * E2E 共享装置（v1 e2e-kit 迁移；重构方案 §933：搬文件与启动装置、断言语义不变）。
 *
 * 与 v1 kit 的形态差异（MIGRATION §8 在案）：
 * - 库：共享 dev 库 → 隔离 schema（全迁移链回放 + 42P01 容错——同 settlement-lifecycle
 *   real 范式）；结束 drop cascade，无需 v1 的逐表手工清理与渠道预算快照还原。
 * - 上游：真 MiniMax → 本地脚本化 mock 上游（openai-compatible 协议族）。真上游契约
 *   单列 rxm3 *.real（MIGRATION §5 裁决：凭证隔离、不进默认门禁）。种子事实沿用
 *   v1 dev 库口径（RX-M3 → MiniMax-M3、2.1/8.4/0.42）——断言值零漂移。
 * - 装配：v1 assembleGateway(平铺 env) → v2 loadGatewayConfig + assembleGateway
 *   （facade 形态）+ createGatewayApp；资金动词走 billing facade（wallet.credit /
 *   settlement.claim），systemContext 语境消亡（facade 无 ctx 参数）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import { closeDb, createDb, type Db } from '@tillgate/db';
import { createCipher } from '@tillgate/runtime';
import { Decimal } from '@tillgate/billing';
import { loadGatewayConfig } from '../../apps/gateway/src/config';
import { assembleGateway, type GatewayAssembly } from '../../apps/gateway/src/assembly';
import { createGatewayApp } from '../../apps/gateway/src/app';
export { startMockUpstream, E2E_UPSTREAM_KEY } from './upstream';
export type { MockUpstream, RecordedRequest, UpstreamScript } from './upstream';
import { E2E_UPSTREAM_KEY, startMockUpstream, type MockUpstream } from './upstream';

/** 种子事实（v1 dev 库 RX-M3 渠道口径——断言值与 v1 e2e 逐条等价） */
export const E2E_MODEL = 'RX-M3';
export const E2E_REAL_MODEL = 'MiniMax-M3';
export const E2E_INPUT_PRICE = '2.1';
export const E2E_OUTPUT_PRICE = '8.4';
export const E2E_CACHE_INPUT_PRICE = '0.42';

/** 世界渠道密钥加密钥（gateway/worker 装配共钥——worker 侧结算需解密同一批渠道行） */
export const E2E_CHANNEL_ENCRYPTION_KEY = 'e2e-channel-key-0123456789abcdef'; // ≥32 字符（secretSchema 口径）
const ENCRYPTION_KEY = E2E_CHANNEL_ENCRYPTION_KEY;
const JWT_SECRET = 'e2e-jwt-secret-0123456789abcdef012345';

export const E2E_URL = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;
export const E2E_REDIS_URL = process.env.REDIS_URL;

// ---------------------------------------------------------------------------
// 隔离 schema 世界：全迁移链回放 + 种子目录（provider/channel/mapping v1 事实值）
// ---------------------------------------------------------------------------

export interface E2ESeed {
  mappingId: number;
  channelId: number;
  providerId: number;
}

export interface E2EWorld {
  db: Db;
  schema: string;
  scopedUrl: string;
  seed: E2ESeed;
  upstream: MockUpstream;
  teardown(): Promise<void>;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../packages/db/migrations', import.meta.url));

/**
 * 全迁移链回放（同 settlement-lifecycle real：42P01 容错——db 链存在跨链引用
 * provision 缺口的已知问题，其余 SQLSTATE 照常失败），public. 前缀重写到隔离 schema。
 */
async function replayMigrations(db: Db, schema: string): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .toSorted();
  for (const file of files) {
    const text = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) {
      const trimmed = statement
        .trim()
        .replaceAll('public.', `${schema}.`)
        .replaceAll('"public"', `"${schema}"`);
      if (!trimmed) continue;
      try {
        await db.execute(sql.raw(trimmed));
      } catch (error) {
        const code = pgErrorCode(error);
        // 42P01 = 跨链引用的祖先表不在本回放集（identity provision 族）——容忍
        if (code !== '42P01') throw error;
      }
    }
  }
}

function pgErrorCode(error: unknown): string | undefined {
  let cur: unknown = error;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export async function setupE2EWorld(): Promise<E2EWorld> {
  if (E2E_URL == null) throw new Error('DB_TEST_URL / DATABASE_URL is required for e2e');
  const upstream = startMockUpstream();
  await (upstream as unknown as { ready: Promise<void> }).ready;

  const schema = `tillgate_e2e_${process.pid.toString(36)}_${Date.now().toString(36)}`;
  const [baseUrl] = E2E_URL.split('?');
  const scopedUrl = `${baseUrl}?options=-c%20search_path%3D${schema}`;
  const db = createDb({
    url: scopedUrl,
    poolMax: 8,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 3_000,
    maxUses: 2_000,
  });
  await db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
  await db.execute(sql.raw(`create schema ${schema}`));
  await replayMigrations(db, schema);

  const cipher = createCipher(ENCRYPTION_KEY);
  const one = async (statement: ReturnType<typeof sql>) => {
    const r = await db.execute(statement);
    return r.rows[0] as Record<string, unknown>;
  };
  const provider = await one(sql`
    insert into providers (name, base_url, protocol, vendor)
    values ('e2e-minimax', ${upstream.url}, 'openai-compatible', 'openai') returning id`);
  const channel = await one(sql`
    insert into channels (provider_id, name, api_key_enc, rpm_limit, upstream_budget)
    values (${provider.id}, 'e2e-ch', ${cipher.encrypt(E2E_UPSTREAM_KEY)}, 10000, '1000') returning id`);
  const mapping = await one(sql`
    insert into model_mappings (external_name, real_model, input_price, output_price, cache_input_price)
    values (${E2E_MODEL}, ${E2E_REAL_MODEL}, ${E2E_INPUT_PRICE}, ${E2E_OUTPUT_PRICE}, ${E2E_CACHE_INPUT_PRICE}) returning id`);
  await db.execute(
    sql`insert into model_channels (mapping_id, channel_id, weight, priority) values (${mapping.id}, ${channel.id}, 3, 2)`,
  );

  return {
    db,
    schema,
    scopedUrl,
    seed: {
      mappingId: Number(mapping.id),
      channelId: Number(channel.id),
      providerId: Number(provider.id),
    },
    upstream,
    async teardown() {
      await upstream.close();
      await db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
      await closeDb(db);
    },
  };
}

// ---------------------------------------------------------------------------
// 网关进程：全真装配（真 PG/Redis/billing/inference）+ 真 HTTP 端口
// ---------------------------------------------------------------------------

/**
 * 外接真上游（rxm3 real 专用）：把世界的 provider/channel 重指向真实上游
 * （dev 库渠道解密出的明文 key 以本世界测试密钥重加密落库——不复制共享库行，
 * 预算/熔断状态与 dev 环境隔离）。
 */
export async function retargetUpstream(
  world: E2EWorld,
  upstream: { baseUrl: string; apiKeyPlain: string; protocol: string; vendor?: string },
): Promise<void> {
  const cipher = createCipher(ENCRYPTION_KEY);
  await world.db.execute(sql`
    update providers set base_url = ${upstream.baseUrl},
      protocol = ${upstream.protocol}, vendor = ${upstream.vendor ?? null}
    where id = ${world.seed.providerId}`);
  await world.db.execute(sql`
    update channels set api_key_enc = ${cipher.encrypt(upstream.apiKeyPlain)}
    where id = ${world.seed.channelId}`);
}

export interface E2EGateway {
  baseUrl: string;
  assembly: GatewayAssembly;
  server: ServerType;
  stop(): Promise<void>;
}

/** 在世界上再挂一个网关实例（同一 schema 可挂多份——cost-drain 双预扣策略形态） */
export async function startE2EGateway(
  world: E2EWorld,
  env: Record<string, string> = {},
): Promise<E2EGateway> {
  const redisUrl = E2E_REDIS_URL ?? 'redis://:root123@127.0.0.1:6379';
  const config = loadGatewayConfig({
    DATABASE_URL: world.scopedUrl,
    REDIS_URL: redisUrl,
    CHANNEL_API_KEY_ENCRYPTION: ENCRYPTION_KEY,
    JWT_SECRET,
    NODE_ENV: 'test',
    OTEL_TRACES_MODE: 'off',
    // 并发负载（④ 20 路）连接池对齐 v1 kit 口径——缺省 10 会连接超时 500
    DB_POOL_MAX: '40',
    // mock 上游在 127.0.0.1——SSRF 逃生门仅非生产可用（与生产装配同口径）
    GATEWAY_AI_ALLOW_LOCAL_URL: 'true',
    ...env,
  });
  const assembly = assembleGateway(config);
  const app = createGatewayApp({
    inference: assembly.inference,
    reader: {
      resolveKeyByHash: (keyHash) => assembly.accounts.resolveKeyByHash(keyHash),
      resolveApp: (appId) => assembly.accounts.resolveApp(appId),
    },
    verifyAppClient: (input) => assembly.accounts.verifyAppClient(input),
    models: assembly.modelsReader,
    requestLogs: assembly.requestLogs,
    pingDb: assembly.pingDb,
    redisProbe: assembly.redis,
    authGuards: assembly.authGuards,
    oauth: {
      jwtSecret: config.oauth.jwtSecret,
      issuer: config.oauth.issuer,
      audience: config.oauth.audience,
      keyPrefix: config.keyPrefix,
      tokenTtlSeconds: config.oauth.tokenTtlSeconds,
    },
    rateLimit: assembly.rateLimit,
    oauthIpGuard: assembly.authGuards.ipGuard,
    trustedProxyHops: 0,
    logger: assembly.logger,
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
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assembly.inference.close();
      await assembly.redis.quit();
      await assembly.closeDb();
    },
  };
}

// ---------------------------------------------------------------------------
// 平台 key 台账（v1 E2EKeys 迁移：发 key / 充值 / 对账 / 结算驱动）
// ---------------------------------------------------------------------------

export class E2EKeys {
  readonly users: number[] = [];

  constructor(
    private readonly world: E2EWorld,
    private readonly billing: GatewayAssembly['billingFacade'],
  ) {}

  /** 建用户 + 充值 + 发 sk_ key（真实网关用它鉴权计费；amount '0' 跳过充值） */
  async issue(amount: string): Promise<{ raw: string; userId: number }> {
    const { db } = this.world;
    const subject = `e2e-${randomUUID().slice(0, 8)}`;
    const r = await db.execute(sql`
      insert into users (issuer, subject, identity_provider) values ('e2e', ${subject}, 'local') returning id`);
    const userId = Number((r.rows[0] as { id: string | number }).id);
    this.users.push(userId);
    if (new Decimal(amount).gt(0)) {
      await this.billing.wallet.credit({
        userId,
        amount,
        refType: 'topup',
        refId: `e2e-${randomUUID().slice(0, 10)}`,
      });
    }
    const raw = `sk_${randomUUID().replace(/-/g, '')}`;
    await db.execute(sql`
      insert into api_keys (key_hash, key_preview, user_id, name)
      values (${createHash('sha256').update(raw).digest('hex')}, 'sk_…', ${userId}, 'e2e')`);
    return { raw, userId };
  }

  async walletOf(userId: number): Promise<{ balance: string; inFlight: string }> {
    const rows = await this.billing.wallet.accounts(userId);
    const row = rows.find((a) => a.kind === 'user') ?? rows[0]!;
    return { balance: row.balance, inFlight: row.inFlight };
  }

  async billsOf(userId: number): Promise<
    Array<{
      request_id: string;
      status: string;
      reserved_amount: string;
      receipt: Record<string, unknown> | null;
    }>
  > {
    const rows = await this.world.db.execute(
      sql`select request_id, status, reserved_amount::text, receipt from billing_requests where user_id = ${userId}`,
    );
    return rows.rows as Array<{
      request_id: string;
      status: string;
      reserved_amount: string;
      receipt: Record<string, unknown> | null;
    }>;
  }

  /**
   * 驱动结算（定向认领）直到该用户无 settlement_pending（v1 同语义；世界独占 schema
   * 无外部 worker 竞态，保留 processing 收敛等待作防御）。
   */
  async settleAll(userId: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const pending = await this.world.db.execute<{ request_id: string }>(sql`
        select request_id from billing_requests
        where user_id = ${userId} and status = 'settlement_pending' limit 50`);
      if (pending.rows.length === 0) {
        const busy = await this.world.db.execute<{ n: number }>(sql`
          select count(*)::int as n from billing_requests
          where user_id = ${userId} and status = 'processing'`);
        if (busy.rows[0]!.n === 0 || Date.now() > deadline) return;
        await sleep(200);
        continue;
      }
      if (Date.now() > deadline) return;
      const claims = await this.billing.settlement.claim({
        ownerId: `e2e-${randomUUID().slice(0, 8)}`,
        batchSize: 50,
        claimLeaseMs: 60_000,
        requestIds: pending.rows.map((r) => r.request_id),
      });
      for (const claim of claims) await this.billing.settlement.processClaim(claim);
      await sleep(100);
    }
  }

  /** 强对账：余额 == 充值合计 − Σ实扣（usage_logs），在途 == 0（v1 同口径） */
  async assertReconciled(
    userId: number,
    funded: string,
  ): Promise<{ balance: string; charged: string }> {
    const usage = await this.world.db.execute<{ sum: string | null }>(sql`
      select sum(amount)::text as sum from usage_logs where user_id = ${userId}`);
    const walletState = await this.walletOf(userId);
    const charged = usage.rows[0]!.sum ?? '0';
    expectDecimalEq(walletState.balance, new Decimal(funded).minus(charged).toString());
    expectDecimalEq(walletState.inFlight, '0');
    return { balance: walletState.balance, charged };
  }
}

function expectDecimalEq(actual: string, expected: string): void {
  if (!new Decimal(actual).eq(expected)) {
    throw new Error(`reconciliation failed: actual ${actual} != expected ${expected}`);
  }
}

/**
 * 清渠道熔断/死凭据状态（v1 resetChannelBreakers 同语义）：畸形大请求打真上游
 * 触发连续失败后熔断 open 会连坐后续用例。健康键在共享 Redis（inference:health:
 * 前缀），隔离 schema 的渠道 id 每世界从 1 起——文件串行 + 显式复位双保险。
 */
export async function resetChannelHealth(gateway: E2EGateway): Promise<void> {
  const { redis } = gateway.assembly;
  const keys: string[] = [];
  const stream = redis.scanStream({ match: 'inference:health:*', count: 100 });
  for await (const batch of stream) keys.push(...(batch as string[]));
  if (keys.length > 0) await redis.del(...keys);
}

export const e2ePost = (
  baseUrl: string,
  raw: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) =>
  fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 根 .env 的 ENCRYPTION_KEY（rxm3 real 件：dev 库渠道密钥解密口径与生产装配一致） */
export function devEncryptionKey(): string {
  const candidates = [
    new URL('../../.env', import.meta.url),
    new URL('../../../.env', import.meta.url),
  ].map((u) => u.pathname);
  const path = candidates.find((c) => existsSync(c));
  if (!path) throw new Error(`.env not found (tried ${candidates.join(', ')})`);
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('ENCRYPTION_KEY='));
  if (!line) throw new Error('.env missing ENCRYPTION_KEY');
  return line.slice(line.indexOf('=') + 1).trim();
}
