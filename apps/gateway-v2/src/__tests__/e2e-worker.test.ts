/**
 * E2E ⑯ worker-v2 全链（真网关 HTTP → 真 worker 三定时器 → 落库审计）：
 *   ⑯a 结算环：chat 请求 → settlement_pending → worker settle 定时器消费 →
 *       usage_logs/钱包腿/渠道预算扣减全部由 worker 落账（数据接收正确性）
 *   ⑯b 生成环：mock MiniMax 视频上游（提交→轮询 running→Success→files 换 url）
 *       → 网关提交 201 → worker generation 定时器驱动终态 → 结算实扣
 *   ⑯c 停机语义：worker.stop() 后不再消费（新 pending 停留）
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from '@ai-gateway/domain';
import { encrypt } from '@ai-gateway/core';
import { E2EKeys, E2E_MODEL, e2eDb, e2ePost, encryptionKeyOf, startE2EGateway, type E2EGateway } from './e2e-kit.js';
/** 跨 app 测试导入（vitest 运行时解析；tsc 不跨 app rootDir——类型本地声明） */
type WorkerHandles = { stop(): Promise<void> };
type WorkerConfig = Record<string, unknown>;
let workerEntryPath = '';
async function importStartWorker(): Promise<(config: WorkerConfig) => WorkerHandles> {
  // 导入前禁用模块级自启动（显式开关——NODE_ENV 守卫在部分运行器形态下不可靠）
  process.env.WORKER_NO_AUTOSTART = '1';
  // 跨 app 导入：cwd 在不同运行方式下漂移（repo 根/apps/app 根）——候选探测定位
  const { resolve } = await import('node:path');
  const { existsSync } = await import('node:fs');
  const candidates = [
    resolve(process.cwd(), '../../worker-v2/src/index.ts'),
    resolve(process.cwd(), '../worker-v2/src/index.ts'),
    resolve(process.cwd(), 'worker-v2/src/index.ts'),
  ];
  workerEntryPath = candidates.find((c) => existsSync(c))!;
  const workerEntry = workerEntryPath;
  if (!workerEntry) throw new Error(`worker-v2 入口未找到（cwd=${process.cwd()}）`);
  const mod = (await import(/* @vite-ignore */ workerEntry)) as { startWorker(config: WorkerConfig): WorkerHandles };
  return mod.startWorker;
}

const db = e2eDb();
const keys = new E2EKeys(db);
let gateway: E2EGateway;
let worker: WorkerHandles;
let restoreBudget: () => Promise<void>;

/** mock MiniMax 视频上游：提交→task_id；查询 2 次 running 后 Success；file 换 url */
let videoServer: Server;
let videoBase = '';
let videoTaskId = '';
let queryCount = 0;
let submittedAuth = '';

beforeAll(async () => {
  // 本套件的上游是本地 mock：显式开 dev 逃生门（生产默认关——SSRF 防护）
  gateway = await startE2EGateway(db, { GATEWAY_AI_ALLOW_LOCAL_URL: true });
  restoreBudget = await keys.snapshotChannelBudget(2);

  videoServer = createServer((req, res) => {
    submittedAuth = req.headers.authorization ?? '';
    const url = req.url ?? '';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.includes('/v1/video_generation')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        videoTaskId = `task-${randomUUID()}`;
        json(200, { task_id: videoTaskId, base_resp: { status_code: 0, status_msg: '' } });
      });
      return;
    }
    if (url.includes('/v1/query/video_generation')) {
      queryCount += 1;
      if (queryCount <= 2) {
        json(200, { status: 'Queueing', task_id: videoTaskId, base_resp: { status_code: 0, status_msg: '' } });
      } else {
        json(200, {
          status: 'Success', task_id: videoTaskId, file_id: 'file-xyz',
          video_width: 1280, video_height: 720, base_resp: { status_code: 0, status_msg: '' },
        });
      }
      return;
    }
    if (url.includes('/v1/files/retrieve')) {
      json(200, { file: { download_url: 'https://cdn.mock/video.mp4', file_id: 'file-xyz' }, base_resp: { status_code: 0, status_msg: '' } });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => videoServer.listen(0, '127.0.0.1', resolve));
  videoBase = `http://127.0.0.1:${(videoServer.address() as { port: number }).port}`;

  // 真 worker：结算/生成定时器节奏压快（100ms），recover 放慢不干扰
  const workerConfig = {
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
    // Redis 必配（worker 拒绝降级启动）；唤醒消费关闭——同队列多测试进程会互相偷门铃
    REDIS_URL: process.env.REDIS_URL ?? 'redis://:root123@localhost:6379',
    WORKER_SETTLE_WAKEUP: false as const,
    WORKER_CURRENCY: 'CNY',
    WORKER_OWNER_ID: 'v2e2e-worker',
    WORKER_BATCH_SIZE: 20,
    WORKER_CLAIM_LEASE_MS: 60_000,
    WORKER_MAX_ATTEMPTS: 5,
    WORKER_BASE_DELAY_MS: 50,
    WORKER_MAX_DELAY_MS: 200,
    WORKER_SETTLE_INTERVAL_MS: 100,
    WORKER_RECOVER_INTERVAL_MS: 300_000,
    WORKER_RECOVERY_BATCH_SIZE: 50,
    WORKER_GENERATION_INTERVAL_MS: 100,
    WORKER_GENERATION_BATCH_SIZE: 20,
    WORKER_GENERATION_LEASE_MS: 30_000,
    WORKER_GENERATION_EXPIRE_REASON: '任务超时（TTL 到期）',
    WORKER_SHUTDOWN_GRACE_MS: 5_000,
    CHANNEL_API_KEY_ENCRYPTION: encryptionKeyOf(),
    WORKER_AI_ALLOW_LOCAL_URL: true, // mock 上游在回环——dev 逃生门
  } as unknown as WorkerConfig;
  worker = await (await importStartWorker())(workerConfig);
}, 30_000);

afterAll(async () => {
  await worker.stop();
  await restoreBudget();
  ;(videoServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => videoServer.close(() => resolve()));
  await keys.cleanup();
  await gateway.stop();
  await db.$client.end().catch(() => {});
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`等待超时：${what}`);
}

describe('E2E ⑯ worker-v2 全链', () => {
  it('⑯a 结算环：网关 HTTP 请求 → worker 定时器结算 → 三处落账（usage_logs/钱包/渠道预算）', async () => {
    const FUND = '1';
    const { raw, userId } = await keys.issue(FUND);
    const budgetBefore = await db.$client.query<{ budget: string }>('select upstream_budget::text as budget from channels where id = 2');

    const res = await e2ePost(gateway.baseUrl, raw, {
      model: E2E_MODEL, max_tokens: 150, messages: [{ role: 'user', content: '只回复：好' }],
    });
    expect(res.status).toBe(200);
    await res.text();

    // worker settle 定时器消费（不是测试自己驱动——数据接收由真实 worker 完成）
    await waitFor(async () => {
      const row = await db.$client.query<{ status: string }>(
        'select status from billing_requests where user_id = $1', [userId],
      );
      return row.rows[0]?.status === 'settled';
    }, 15_000, 'worker 结算');

    const usage = await db.$client.query<{ input_tokens: string; amount: string; real_model: string }>(
      'select input_tokens::text, amount::text, real_model from usage_logs where user_id = $1', [userId],
    );
    expect(usage.rows.length).toBe(1); // worker 写的计量行
    expect(usage.rows[0]!.real_model).toBe('MiniMax-M3');
    expect(new Decimal(usage.rows[0]!.amount).gt(0)).toBe(true);

    const walletState = await keys.walletOf(userId);
    expect(new Decimal(walletState.balance).eq(new Decimal(FUND).minus(usage.rows[0]!.amount))).toBe(true);
    expect(new Decimal(walletState.inFlight).eq('0')).toBe(true);

    // 渠道进货额度被 worker 的结算扣减（upstreamCost 口径）
    await waitFor(async () => {
      const budgetAfter = await db.$client.query<{ budget: string }>('select upstream_budget::text as budget from channels where id = 2');
      return new Decimal(budgetBefore.rows[0]!.budget).gt(budgetAfter.rows[0]!.budget);
    }, 10_000, '渠道预算扣减');
  }, 60_000);

  it('⑯b 生成环：mock 视频上游 → 网关提交 201 → worker 轮询终态 → 结算实扣', async () => {
    const FUND = '5'; // 视频押 6s×0.5=3 元
    // 专属 minimax 协议 provider 指向 mock（video 任务操作面）
    const { providers, modelMappings, modelChannels, channels } = await import('@ai-gateway/db');
    const [provider] = await db.insert(providers)
      .values({ name: `v2e2e-mock-${randomUUID().slice(0, 6)}`, baseUrl: videoBase, protocol: 'minimax', status: 0 })
      .returning({ id: providers.id });
    const [mapping] = await db.insert(modelMappings).values({
      externalName: `v2e2e-vid-${randomUUID().slice(0, 8)}`, realModel: 'video-01', status: 0,
      inputPrice: '0', outputPrice: '0', cacheInputPrice: '0',
      pricingUnit: 'second', unitPrice: '0.5',
    }).returning({ id: modelMappings.id, externalName: modelMappings.externalName });
    const [channel] = await db.insert(channels).values({
      providerId: provider!.id, name: `v2e2e-mockch-${randomUUID().slice(0, 6)}`,
      apiKeyEnc: encrypt('sk-video-mock', encryptionKeyOf()), status: 0, upstreamBudget: '1000',
    }).returning({ id: channels.id });
    await db.insert(modelChannels).values({ mappingId: mapping!.id, channelId: channel!.id, priority: 1, weight: 1 });

    const { raw, userId } = await keys.issue(FUND);
        const submit = await fetch(`${gateway.baseUrl}/v1/video/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: mapping!.externalName, prompt: '一只猫', duration: 6 }),
    });
    expect(submit.status).toBe(201);
    const submitted = (await submit.json()) as { id: string; task_id: string; status: string };
    expect(submitted.status).toBe('queued');
    expect(submitted.task_id).toBe(videoTaskId);
    expect(submittedAuth).toMatch(/^Bearer /); // 解密注入上游

    // worker generation 定时器：轮询 running×2 → Success → file 换 url → 终态
    await waitFor(async () => {
      const task = await db.$client.query<{ status: string; result: Record<string, unknown> }>(
        'select status, result from generation_tasks where id = $1', [submitted.id],
      );
      return task.rows[0]?.status === 'succeeded';
    }, 20_000, 'video 任务终态');
    const task = await db.$client.query<{ status: string; result: Record<string, unknown> }>(
      'select status, result from generation_tasks where id = $1', [submitted.id],
    );
    expect((task.rows[0]!.result as { url?: string }).url).toBe('https://cdn.mock/video.mp4');

    // 结算：6s × 0.5 = 3 元实扣
    await waitFor(async () => {
      const bill = await db.$client.query<{ status: string }>(
        'select status from billing_requests where request_id = $1', [submitted.id],
      );
      return bill.rows[0]?.status === 'settled';
    }, 15_000, 'video 结算');
    const walletState = await keys.walletOf(userId);
    expectDecimalEq(walletState.balance, '2'); // 5 − 6s×0.5
    expectDecimalEq(walletState.inFlight, '0');

    // 清理 mock 渠道族（keys.cleanup 只管用户维度账单）
    await db.$client.query('delete from generation_tasks where request_id = $1', [submitted.id]);
    await db.$client.query('delete from billing_reservations where billing_request_id = $1', [submitted.id]);
    await db.$client.query('delete from usage_logs where request_id = $1', [submitted.id]);
    await db.$client.query('delete from billing_requests where request_id = $1', [submitted.id]);
    await db.$client.query('delete from model_channels where channel_id = $1', [channel!.id]);
    await db.$client.query('delete from channels where id = $1', [channel!.id]);
    await db.$client.query('delete from model_mappings where id = $1', [mapping!.id]);
    await db.$client.query('delete from providers where id = $1', [provider!.id]);
  }, 90_000);

  it('⑯c 停机语义：worker.stop() 后不再消费（新 pending 停留）', async () => {
    await worker.stop();
    const { raw, userId } = await keys.issue('1');
    const res = await e2ePost(gateway.baseUrl, raw, {
      model: E2E_MODEL, max_tokens: 150, messages: [{ role: 'user', content: '只回复：好' }],
    });
    expect(res.status).toBe(200);
    await res.text();
    await new Promise((r) => setTimeout(r, 1_200)); // 原节奏 100ms——足够证明不再消费
    const bill = await db.$client.query<{ status: string }>(
      'select status from billing_requests where user_id = $1', [userId],
    );
    expect(bill.rows[0]!.status).toBe('settlement_pending'); // 无人消费
    // 手动结算收尾（避免清理 FK）
    await keys.settleAll(userId);
  }, 30_000);
});

function expectDecimalEq(actual: string, expected: string): void {
  expect(new Decimal(actual).eq(expected)).toBe(true);
}

