/**
 * worker 全链 e2e：
 *   ⑯a 结算环：chat → settlement_pending → worker settle runner 结算 →
 *        usage_logs/钱包腿/渠道预算扣减三处落账（数据接收正确性）
 *   ⑯b 生成环：mock MiniMax 视频上游（提交→running×2→Success→file 换 url）
 *        → 网关提交 201 → worker generation runner 轮询终态 → 结算实扣
 *   ⑯c 停机语义：scheduler.stop() 后不再消费（新 pending 停留）
 * 驱动形态（装置见 kit 头）：结算/生成环 runners 直驱;⑯c 用真 scheduler
 * 先证「定时器活着会消费」再 stop 证「停机不再消费」。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Decimal } from '@tillgate/billing';
import { createCipher } from '@tillgate/runtime';
import {
  defined,
  E2E_ENCRYPTION_KEY,
  E2EKeys,
  E2E_MODEL,
  E2E_REAL_MODEL,
  e2ePost,
  setupE2EWorld,
  sleep,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from '../gateway/kit.js';
import {
  assembleWorldWorker,
  pgReady,
  startVideoUpstream,
  teardownWorker,
  type VideoUpstream,
} from './kit.js';
import type { WorkerAssembly } from '../../apps/worker/src/assembly.js';

/** env 有值且 PG/Redis 可达才跑（不可达优雅 skip——不误报;Redis 是 BullMQ 结算调度硬依赖） */
async function redisReady(): Promise<boolean> {
  if (process.env.REDIS_URL == null) return false;
  try {
    const { default: IORedis } = await import('ioredis');
    const probe = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 0,
      connectTimeout: 1_000,
      lazyConnect: true,
    });
    try {
      await probe.connect();
      return (await probe.ping()) === 'PONG';
    } finally {
      probe.disconnect();
    }
  } catch {
    return false;
  }
}
const hasInfra =
  (process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null) &&
  (await pgReady()) &&
  (await redisReady());

/** 套件世界（三环共享）——单对象收拢,测试体解构即用（无 shadow） */
interface Suite {
  world: E2EWorld;
  gateway: E2EGateway;
  worker: WorkerAssembly;
  keys: E2EKeys;
  video: VideoUpstream;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(80);
  }
  throw new Error(`等待超时：${what}`);
}

describe.skipIf(!hasInfra)('E2E ⑯ worker 全链', () => {
  let s: Suite | null = null;
  /** ⑯b 的 mock 渠道族 id（世界 drop cascade 兜底回收;记录仅排障用） */
  const vidSeed = { providerId: 0, channelId: 0, mappingId: 0 };

  beforeAll(async () => {
    s = {
      world: await setupE2EWorld(),
      gateway: null as unknown as E2EGateway,
      worker: null as unknown as WorkerAssembly,
      keys: null as unknown as E2EKeys,
      video: startVideoUpstream(),
    };
    await (s.video as unknown as { ready: Promise<void> }).ready;
    s.gateway = await startE2EGateway(s.world);
    s.worker = await assembleWorldWorker(s.world);
    s.keys = new E2EKeys(s.world, s.gateway.assembly.billingFacade);
  }, 120_000);

  afterAll(async () => {
    if (s === null) return;
    await teardownWorker(s.worker);
    await s.gateway.stop();
    await s.world.teardown();
    await s.video.close();
  }, 120_000);

  function w(): Suite {
    if (s === null) throw new Error('billing-recovery world not ready（infra 不可达整组 skip）');
    return s;
  }

  /** 单用户 billing 状态 */
  async function billStatusOf(userId: number): Promise<string | undefined> {
    const rows = await w().world.db.execute<{ status: string }>(
      sql`select status from billing_requests where user_id = ${userId}`,
    );
    return rows[0]?.status;
  }

  it('⑯a 结算环：网关 HTTP 请求 → worker 结算 → 三处落账（usage_logs/钱包/渠道预算）', async () => {
    const { world, gateway, worker, keys } = w();
    const FUND = '1';
    const { raw, userId } = await keys.issue(FUND);
    const budgetBefore = await world.db.execute<{ budget: string }>(
      sql`select upstream_budget::text as budget from channels where id = ${world.seed.channelId}`,
    );

    const res = await e2ePost(gateway.baseUrl, raw, {
      model: E2E_MODEL,
      max_tokens: 150,
      messages: [{ role: 'user', content: '只回复：好' }],
    });
    expect(res.status).toBe(200);
    await res.text();

    // worker settle runner 消费（认领/结算是生产函数——只是不经定时器）
    await waitFor(
      async () => {
        await defined(worker.runners.settle, 'runners.settle')();
        return (await billStatusOf(userId)) === 'settled';
      },
      15_000,
      'worker 结算',
    );

    const usage = await world.db.execute<{
      input_tokens: string;
      amount: string;
      real_model: string;
    }>(
      sql`select input_tokens::text, amount::text, real_model from usage_logs where user_id = ${userId}`,
    );
    expect(usage.length).toBe(1); // worker 写的计量行
    expect(defined(usage[0], 'usage row').real_model).toBe(E2E_REAL_MODEL);
    expect(new Decimal(defined(usage[0], 'usage row').amount).gt(0)).toBe(true);

    const walletState = await keys.walletOf(userId);
    expect(
      new Decimal(walletState.balance).eq(
        new Decimal(FUND).minus(defined(usage[0], 'usage row').amount),
      ),
    ).toBe(true);
    expect(new Decimal(walletState.inFlight).eq('0')).toBe(true);

    // 渠道进货额度被 worker 的结算扣减（upstreamCost 口径）
    await waitFor(
      async () => {
        const budgetAfter = await world.db.execute<{ budget: string }>(
          sql`select upstream_budget::text as budget from channels where id = ${world.seed.channelId}`,
        );
        const budgetBeforeRow = defined(budgetBefore[0], 'budget before');
        const budgetAfterRow = defined(budgetAfter[0], 'budget after');
        return new Decimal(budgetBeforeRow.budget).gt(budgetAfterRow.budget);
      },
      10_000,
      '渠道预算扣减',
    );
  }, 60_000);

  it('⑯b 生成环：mock 视频上游 → 网关提交 201 → worker 轮询终态 → 结算实扣', async () => {
    const { world, gateway, worker, keys, video } = w();
    const FUND = '5'; // 视频押 6s×0.5=3 元
    // 专属 minimax 协议 provider 指向 mock（video 任务操作面）
    const cipher = createCipher(E2E_ENCRYPTION_KEY);
    const stamp = Date.now().toString(36);
    const provider = await world.db.execute<{ id: number }>(sql`
      insert into providers (name, base_url, protocol, vendor)
      values (${`e2e-br-vid-${stamp}`}, ${video.baseUrl}, 'minimax', null) returning id`);
    vidSeed.providerId = Number(defined(provider[0], 'provider row').id);
    const mapping = await world.db.execute<{ id: number; external_name: string }>(sql`
      insert into model_mappings (external_name, real_model, status, input_price, output_price,
        cache_input_price, pricing_unit, unit_price)
      values (${`e2e-br-vidm-${stamp}`}, 'video-01', 0, '0', '0', '0', 'second', '0.5')
      returning id, external_name`);
    vidSeed.mappingId = Number(defined(mapping[0], 'mapping row').id);
    const channel = await world.db.execute<{ id: number }>(sql`
      insert into channels (provider_id, name, api_key_enc, status, upstream_budget)
      values (${vidSeed.providerId}, ${`e2e-br-vidch-${stamp}`}, ${cipher.encrypt('sk-video-mock')}, 0, '1000')
      returning id`);
    vidSeed.channelId = Number(defined(channel[0], 'channel row').id);
    await world.db.execute(sql`
      insert into model_channels (mapping_id, channel_id, priority, weight, upstream_model)
      values (${vidSeed.mappingId}, ${vidSeed.channelId}, 1, 1, 'video-01')`);

    const { raw, userId } = await keys.issue(FUND);
    const submit = await fetch(`${gateway.baseUrl}/v1/video/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: defined(mapping[0], 'mapping row').external_name,
        prompt: '一只猫',
        duration: 6,
      }),
    });
    expect(submit.status).toBe(201);
    const submitted = (await submit.json()) as { id: string; status: string };
    expect(submitted.status).toBe('queued');
    // 提交响应不含上游任务号（new-api 形状只有内部 id）,上游号落点为 DB 行的
    // upstream_task_id（同一事实:提交真实到达上游并被登记）
    const taskRow = await world.db.execute<{ upstream_task_id: string; status: string }>(
      sql`select upstream_task_id, status from generation_tasks where id = ${submitted.id}`,
    );
    expect(defined(taskRow[0], 'task row').upstream_task_id).toBe(video.lastTaskId);
    expect(video.submittedAuth).toMatch(/^Bearer /); // 解密注入上游

    // worker generation runner：轮询 running×2 → Success → file 换 url → 终态
    await waitFor(
      async () => {
        await defined(worker.runners.generation, 'runners.generation')();
        const task = await world.db.execute<{ status: string }>(
          sql`select status from generation_tasks where id = ${submitted.id}`,
        );
        return task[0]?.status === 'succeeded';
      },
      20_000,
      'video 任务终态',
    );
    const task = await world.db.execute<{ status: string; result: Record<string, unknown> }>(
      sql`select status, result from generation_tasks where id = ${submitted.id}`,
    );
    const finalTask = defined(task[0], 'final task row');
    expect((finalTask.result as { url?: string }).url).toBe('https://cdn.mock/video.mp4');

    // 结算：6s × 0.5 = 3 元实扣（提交响应 id = taskId,billing request_id 与其
    // 分离——经任务行 join 定位账单）
    await waitFor(
      async () => {
        await defined(worker.runners.settle, 'runners.settle')();
        const bill = await world.db.execute<{ status: string }>(sql`
        select b.status from billing_requests b
        join generation_tasks g on g.request_id = b.request_id
        where g.id = ${submitted.id}`);
        return bill[0]?.status === 'settled';
      },
      15_000,
      'video 结算',
    );
    const walletState = await keys.walletOf(userId);
    expectDecimalEq(walletState.balance, '2'); // 5 − 6s×0.5
    expectDecimalEq(walletState.inFlight, '0');
    // mock 渠道族随世界 drop cascade 回收（vidSeed 记录仅排障用）
  }, 90_000);

  it('⑯c 停机语义：scheduler.stop() 后不再消费（新 pending 停留）', async () => {
    const { gateway, worker, keys } = w();
    // 先用真定时器证「活着会消费」：起调度（settle/generation 100ms 节奏）,
    // 发请求后不手动驱动——settled 只能来自定时器 tick
    worker.scheduler.start();
    const first = await keys.issue('1');
    const res = await e2ePost(gateway.baseUrl, first.raw, {
      model: E2E_MODEL,
      max_tokens: 150,
      messages: [{ role: 'user', content: '只回复：好' }],
    });
    expect(res.status).toBe(200);
    await res.text();
    await waitFor(
      async () => (await billStatusOf(first.userId)) === 'settled',
      15_000,
      '定时器消费',
    );

    // 停机 → 新请求的 pending 停留（原节奏 100ms,等 1.2s 足以证明不再消费）
    await worker.scheduler.stop();
    expect(worker.scheduler.isRunning()).toBe(false);
    const second = await keys.issue('1');
    const res2 = await e2ePost(gateway.baseUrl, second.raw, {
      model: E2E_MODEL,
      max_tokens: 150,
      messages: [{ role: 'user', content: '只回复：好' }],
    });
    expect(res2.status).toBe(200);
    await res2.text();
    await sleep(1_200);
    // 隔离 schema 无外部 worker 竞态——精确断言「停留不被消费」
    expect(await billStatusOf(second.userId)).toBe('settlement_pending');
  }, 60_000);
});

function expectDecimalEq(actual: string, expected: string): void {
  expect(new Decimal(actual).eq(expected)).toBe(true);
}
