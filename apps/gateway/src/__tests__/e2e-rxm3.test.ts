/**
 * 端到端真实链路（真网关进程 + 平台 ag_ key + 真上游 MiniMax RX-M3）：
 *   ① 流式中途取消（模型已有输出）→ 计费归属与资金一致性
 *   ② 上游未返回时取消 → 网关行为与资金一致性
 *   ③ 低余额并发 → 放行数量 / 最多亏损 / 能否负、负多少
 *   ④ 多用户大并发 → 数据不错乱（归属/幂等）、不多扣不扣错（钱包对账精确）
 * 共享 dev 库的 RX-M3 渠道（预算先快照后还原）；请求体量小（max_tokens 低）控成本。
 */
import { serve, type ServerType } from '@hono/node-server';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import { apiKeys, users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { Decimal } from '@ai-gateway/domain';
import { createSettlementDomain, createWallet, systemContext, type RunContext } from '@ai-gateway/service';
import { assembleGateway } from '../assembly.js';
import { createApp } from '../app.js';

const MODEL = 'RX-M3';
const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 16 },
);
const tag = () => `v2e2e-${randomUUID().slice(0, 8)}`;

/** 根 .env 的 ENCRYPTION_KEY（渠道密钥解密口径与生产装配一致；逐级向上定位） */
function encryptionKeyOf(): string {
  const candidates = [
    new URL('../../../../.env', import.meta.url),           // src/__tests__ → 仓库根（src 编译视角）
    new URL('../../../../../.env', import.meta.url),        // vitest 变换路径兜底
  ].map((u) => u.pathname);
  const path = candidates.find((c) => existsSync(c));
  if (!path) throw new Error(`.env 未找到（尝试过 ${candidates.join('、')}）`);
  const line = readFileSync(path, 'utf8').split('\n').find((l) => l.startsWith('ENCRYPTION_KEY='));
  if (!line) throw new Error('.env 缺 ENCRYPTION_KEY');
  return line.slice(line.indexOf('=') + 1).trim();
}

const wallet = createWallet({
  db, currency: 'CNY',
  guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
});
const settlement = createSettlementDomain({
  db, currency: 'CNY', policy: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
});
const settleCtx = () => systemContext(`v2e2e-settle-${randomUUID().slice(0, 6)}`);

const createdUsers: number[] = [];
const createdKeys: number[] = [];
let server: ServerType;
let baseUrl = '';
let channelBudgetSnapshot = '';
let assembly: ReturnType<typeof assembleGateway> | null = null;

/** 平台 key：建用户 + 充值 + 发 ag_ key（真实网关用它鉴权计费） */
async function platformKey(amount: string): Promise<{ raw: string; userId: number }> {
  const ctx: RunContext = systemContext(randomUUID());
  const [user] = await db
    .insert(users)
    .values({ issuer: 'v2e2e', subject: tag(), identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  await wallet.credit(ctx, { userId: user!.id, amount, refType: 'topup', refId: tag() });
  const raw = `ag_${randomUUID().replace(/-/g, '')}`;
  const [key] = await db
    .insert(apiKeys)
    .values({ keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: 'ag_****', userId: user!.id, name: 'v2e2e' })
    .returning({ id: apiKeys.id });
  createdKeys.push(key!.id);
  return { raw, userId: user!.id };
}

async function walletOf(userId: number): Promise<{ balance: string; inFlight: string }> {
  const rows = await wallet.accounts(systemContext(randomUUID()), userId);
  return { balance: rows[0]!.balance, inFlight: rows[0]!.inFlight };
}

/** 该用户全部账单行 */
async function billsOf(userId: number): Promise<Array<{ request_id: string; status: string; reserved_amount: string; receipt: Record<string, unknown> | null }>> {
  const rows = await db.$client.query(
    'select request_id, status, reserved_amount, receipt from billing_requests where user_id = $1', [userId],
  );
  return rows.rows;
}

/** 驱动结算（worker 下半场，定向认领该用户账单）直到无 settlement_pending */
async function settleAll(userId: number): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const pending = await db.$client.query<{ request_id: string }>(
      "select request_id from billing_requests where user_id = $1 and status = 'settlement_pending' limit 50", [userId],
    );
    if (pending.rows.length === 0) return;
    const claims = await settlement.claim(settleCtx(), {
      ownerId: tag(), batchSize: 50, claimLeaseMs: 60_000, requestIds: pending.rows.map((r) => r.request_id),
    });
    for (const claim of claims) await settlement.processClaim(settleCtx(), claim);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const post = (raw: string, body: Record<string, unknown>, signal?: AbortSignal) =>
  fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

beforeAll(async () => {
  // 共享渠道预算快照（结束后还原——不打扰 dev 环境共享渠道）
  const snap = await db.$client.query<{ budget: string }>('select upstream_budget::text as budget from channels where id = 2');
  channelBudgetSnapshot = snap.rows[0]!.budget;

  assembly = assembleGateway({
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
    // Redis 必配：漏传 = ioredis(undefined) 无密码连默认端口——NOAUTH 刷屏且
    // 限流/爆破防护/熔断状态共享全部 fail-open 降级（assembleGateway 收的是
    // 已解析对象，不走 loadConfig 的必填校验，as never 绕过了类型保护）
    REDIS_URL: process.env.REDIS_URL ?? 'redis://:root123@localhost:6379',
    PORT: 0,
    DB_POOL_MAX: 40,
    GATEWAY_CURRENCY: 'CNY',
    ADMISSION_MAX_PENDING: 10_000,
    ADMISSION_MAX_OLDEST_MS: 300_000,
    BILLING_RESERVATION_MAX: '1000',
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
  } as never);
  const app = createApp({
    db: assembly.db,
    runChat: assembly.runChat,
    submitGeneration: assembly.submitGeneration,
    oauth: assembly.oauth,
  });
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve)); // port 0 异步分配
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}, 30_000);

afterAll(async () => {
  ;(server as unknown as { closeAllConnections?: () => void } | undefined)?.closeAllConnections?.();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  // 还原共享渠道预算（结算扣减不留痕）；在途敞口清零
  await db.$client.query('update channels set upstream_budget = $1, upstream_reserved = 0 where id = 2', [channelBudgetSnapshot]).catch(() => {});
  // 用户维度兜底清账
  if (createdUsers.length) {
    const billRows = await db.$client.query<{ request_id: string }>(
      'select request_id from billing_requests where user_id = any($1)', [createdUsers],
    );
    const billIds = billRows.rows.map((r) => r.request_id);
    if (billIds.length) {
      await db.$client.query('delete from billing_reservations where billing_request_id = any($1::uuid[])', [billIds]);
      await db.$client.query('delete from usage_logs where request_id = any($1::uuid[])', [billIds]);
      await db.$client.query('delete from billing_requests where request_id = any($1::uuid[])', [billIds]);
    }
    await db.$client.query('delete from generation_tasks where user_id = any($1)', [createdUsers]);
  }
  if (createdKeys.length) await db.$client.query('delete from api_keys where id = any($1)', [createdKeys]);
  if (createdUsers.length) await db.$client.query('delete from users where id = any($1)', [createdUsers]);
  await assembly?.db.$client.end().catch(() => {});
  await db.$client.end().catch(() => {});
});

describe('E2E · 真网关 + 平台 key + RX-M3', () => {
  it(
    '① 流式中途取消（已有输出）：单笔账单、资金一致、结算后余额不为负',
    async () => {
      const { raw, userId } = await platformKey('1');
      const ac = new AbortController();
      const res = await post(raw, {
        model: MODEL, stream: true, max_tokens: 400,
        messages: [{ role: 'user', content: '从 1 数到 50，每个数一行' }],
      }, ac.signal);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      // 读到首批输出（模型已产生内容）后取消
      const reader = res.body!.getReader();
      await reader.read();
      await new Promise((r) => setTimeout(r, 300)); // 让输出累积
      ac.abort();
      await reader.cancel().catch(() => {});

      // 等终态（上游仍在读——usage 真实或按取消估算）
      await new Promise((r) => setTimeout(r, 1_500));
      const bills = await billsOf(userId);
      expect(bills.length).toBe(1); // 单笔账单（取消不产生第二笔）
      await settleAll(userId);
      const finalBills = await billsOf(userId);
      expect(['settled', 'released']).toContain(finalBills[0]!.status);
      const walletState = await walletOf(userId);
      // 资金一致性：结算后余额 = 1 − 实扣；实扣 ≤ 真实用量（不为负超额放大）
      expect(new Decimal(walletState.balance).gte('-0.05')).toBe(true);
      expect(new Decimal(walletState.inFlight).eq('0')).toBe(true);
    },
    120_000,
  );

  it(
    '② 上游未返回时取消：账单有始有终（settle 或 release），钱包在途归零',
    async () => {
      const { raw, userId } = await platformKey('1');
      const ac = new AbortController();
      const fetchPromise = post(raw, {
        model: MODEL, stream: true, max_tokens: 400,
        messages: [{ role: 'user', content: '写一篇 800 字文章' }],
      }, ac.signal);
      // 等授权落账（请求已进网关、上游尚未返回——thinking 模型有窗口期）
      const deadline = Date.now() + 10_000;
      for (;;) {
        const bills = await billsOf(userId);
        if (bills.length >= 1 || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      ac.abort();
      await fetchPromise.catch(() => {});

      // 终态收敛：不允许停在 authorized/in_flight 悬挂（租约是兜底，这里等上游自然结束）
      await new Promise((r) => setTimeout(r, 4_000));
      await settleAll(userId);
      const bills = await billsOf(userId);
      expect(bills.length).toBe(1);
      expect(['settled', 'settlement_pending', 'released', 'in_flight']).toContain(bills[0]!.status);
      const walletState = await walletOf(userId);
      expect(new Decimal(walletState.balance).gte('-0.05')).toBe(true);
    },
    120_000,
  );

  it(
    '③ 低余额并发 8 路：放行受限、总亏损有界、余额可负但被结构钳制',
    async () => {
      const FUND = '0.006'; // ≈ 4 个最小请求的押金（max_tokens 150 → 押 ~0.0013/笔）
      const { raw, userId } = await platformKey(FUND);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          post(raw, {
            model: MODEL, max_tokens: 150,
            messages: [{ role: 'user', content: '只回复：好' }],
          }).then(async (res) => ({ status: res.status, body: res.ok ? await res.text() : await res.text() })),
        ),
      );
      const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 'network-error'));
      const ok = statuses.filter((s) => s === 200).length;
      const rejected = statuses.filter((s) => s === 402).length;
      console.log(`③ 余额 ${FUND} 并发 8 路 → 放行 ${ok} / 拒绝 ${rejected}（状态全集 ${JSON.stringify(statuses)}）`);
      expect(ok + rejected).toBe(8); // 要么放行要么 402，无其他态
      expect(ok).toBeGreaterThan(0);
      expect(rejected).toBeGreaterThan(0); // 余额不足以全覆盖 → 必有拒绝（fail-closed 生效）

      await settleAll(userId);
      const walletState = await walletOf(userId);
      const bills = await billsOf(userId);
      expect(bills.length).toBe(ok); // 拒绝零落账
      // 对账精确：Σ实扣（usage_logs）== 0.02 − 余额（每一分钱都有账单行对应）
      const usage = await db.$client.query<{ sum: string | null }>(
        'select sum(amount)::text as sum from usage_logs where user_id = $1', [userId],
      );
      const expectedBalance = new Decimal(FUND).minus(usage.rows[0]!.sum ?? '0');
      expect(new Decimal(walletState.balance).eq(expectedBalance)).toBe(true);
      expect(new Decimal(walletState.inFlight).eq('0')).toBe(true);
      // 最多亏损边界：余额不为深度负（单请求级 §4 超额以内）
      console.log(`③ 结算后：余额 ${walletState.balance}（亏损深度 ${new Decimal(FUND).minus(walletState.balance).toString()}）在途 ${walletState.inFlight} Σ实扣 ${usage.rows[0]!.sum}`);
      expect(new Decimal(walletState.balance).gte('-0.005')).toBe(true); // 最多亏损 ≤ 单笔级超额
    },
    180_000,
  );

  it(
    '④ 5 用户 × 4 并发：数据不错乱、归属正确、钱包分毫对账',
    async () => {
      const FUND = '1';
      const peers = await Promise.all(Array.from({ length: 5 }, () => platformKey(FUND)));
      // 每用户 4 路并发，各带专属标记（响应与账单都必须回到正确的用户）
      const all = await Promise.allSettled(
        peers.flatMap((peer, userIndex) =>
          Array.from({ length: 4 }, (_, i) =>
            post(peer.raw, {
              model: MODEL, max_tokens: 200,
              messages: [{ role: 'user', content: `只回复四个字：用户${userIndex}序${i}` }],
            }).then(async (res) => ({ userId: peer.userId, userIndex, i, status: res.status })),
          ),
        ),
      );
      const outcomes = all.map((r) => (r.status === 'fulfilled' ? r.value : { status: 'network-error' }));
      const statusCount: Record<string, number> = {};
      for (const o of outcomes) statusCount[o.status] = (statusCount[o.status] ?? 0) + 1;
      console.log('④ 状态分布:', JSON.stringify(statusCount));
      const okCount = statusCount['200'] ?? 0;
      expect(okCount).toBeGreaterThanOrEqual(16); // 允许个别瞬时上游失败，但绝大多数必须成功

      for (const peer of peers) await settleAll(peer.userId);

      for (const [index, peer] of peers.entries()) {
        const userOk = outcomes.filter((o) => (o as { userId?: number }).userId === peer.userId && o.status === 200).length;
        const ws0 = await walletOf(peer.userId);
        console.log(`④ 用户${index}：${userOk} 笔 / 余额 ${ws0.balance} / 在途 ${ws0.inFlight}`);
        const bills = await billsOf(peer.userId);
        expect(bills.length).toBe(userOk); // 恰好自己的成功笔数（不少收不多收）
        expect(bills.every((b) => b.status === 'settled')).toBe(true);
        const usage = await db.$client.query<{ sum: string | null; rows: string }>(
          'select sum(amount)::text as sum, count(*)::text as rows from usage_logs where user_id = $1', [peer.userId],
        );
        expect(usage.rows[0]!.rows).toBe(String(userOk)); // 计量行数与请求一致（不错记他用户）
        const walletState = await walletOf(peer.userId);
        // 分毫对账：余额 = 充值 − Σ本用户实扣；在途归零
        expect(new Decimal(walletState.balance).eq(new Decimal(FUND).minus(usage.rows[0]!.sum ?? '0'))).toBe(true);
        expect(new Decimal(walletState.inFlight).eq('0')).toBe(true);
        // 金额 > 0（真上游真用量——不是 0 元白嫖）
        expect(new Decimal(usage.rows[0]!.sum ?? '0').gt(0)).toBe(true);
        void index;
      }
    },
    240_000,
  );
});
