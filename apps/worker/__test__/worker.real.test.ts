/**
 * worker 真 PG/Redis 集成（铁律 14：默认门禁按文件名排除，test:real 显式运行）。
 * 覆盖 app 特有的真实面——结算/佣金/对账核验的用例本体已在 billing 包 real 门
 * （settlement-lifecycle / wallet-contract / wallet-invariants）覆盖，此处不重复：
 *   ① 唤醒全链：pg_notify('settle-wake') → 专用连接 LISTEN → onWake 触发（真通道）
 *   ② 会话级 advisory try-lock 互斥：他连接持键 → 本连接获锁失败（对账门语义）
 *   ③ BullMQ 结算队列：jobId 去重入队 → worker 消费 → retried 重投（真 Redis；
 *      毒账单进程隔离的全栈验证归 live-fire P1 用例）
 * 环境：DB_TEST_URL / DATABASE_URL + REDIS_URL（根 .env）；不可达时对应组跳过。
 * 零业务数据写入。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, ping } from '@tillgate/db';
import type { Db } from '@tillgate/db';
import { SETTLE_WAKE_CHANNEL } from '@tillgate/billing';
import IORedis from 'ioredis';
import { createSettleWakeListener } from '../src/wakeup/postgres-notify';
import type { ListenConnection } from '../src/wakeup/postgres-notify';
import { createSettlementQueue } from '../src/queue/settlement-queue';

const url = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;
let db: Db | null = null;

beforeAll(async () => {
  if (!url) return;
  try {
    const candidate = createDb({
      url,
      poolMax: 5,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 3_000,
      maxUses: 1_000,
    });
    await ping(candidate);
    db = candidate;
  } catch {
    db = null;
  }
});
afterAll(async () => {
  if (db) await closeDb(db).catch(() => {});
});

/** 轮询等待（真 LISTEN/通知到达是异步的） */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return predicate();
}

/** 池化连接发 NOTIFY（经池客户端原生查询——app 不依赖 drizzle 面） */
async function notify(target: Db, channel: string, payload: string): Promise<void> {
  const client = await target.$client.connect();
  try {
    await client.query({ text: 'select pg_notify($1, $2)', values: [channel, payload] });
  } finally {
    client.release();
  }
}

describe('worker 真 PG：结算唤醒全链', () => {
  it('pg_notify(settle-wake) → 专用连接 LISTEN → 批次触发；他通道通知不触发', async (context) => {
    if (!db) return context.skip();
    const connected = db;
    let runs = 0;
    const listener = createSettleWakeListener({
      connect: async () => (await connected.$client.connect()) as unknown as ListenConnection,
      channel: SETTLE_WAKE_CHANNEL,
      onWake: async () => {
        runs += 1;
      },
      logger: { warn: () => {}, error: () => {} },
    });
    try {
      // LISTEN 建立等待：发一条通知直到被收到（自旋探测，最多 5s）
      // 谓词提为同级 const：避免回调字面量再嵌一层（max-nested-callbacks）
      const firstRun = () => runs >= 1;
      const probeOnce = async () => {
        await notify(connected, SETTLE_WAKE_CHANNEL, 'probe');
        return waitFor(firstRun, 400);
      };
      const established = await waitForEstablished(connected, probeOnce);
      expect(established).toBe(true);
      const probeRuns = runs;
      // 他通道不触发
      await notify(connected, 'other-worker-real-channel', 'x');
      expect(await waitFor(() => runs > probeRuns, 500)).toBe(false);
    } finally {
      await listener.close();
    }
  }, 15_000);
});

/** 探测 LISTEN 是否已建立（首次通知可能早于 LISTEN 生效被丢——重试直至收到） */
async function waitForEstablished(connected: Db, probe: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    if (await probe()) return true;
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
  return false;
}

describe('worker 真 PG：对账会话锁门', () => {
  it('他连接持键 → try-lock 获锁失败（null 语义，不误报不漏报）', async (context) => {
    if (!db) return context.skip();
    const connected = db;
    const key = 'tillgate-worker-real-test:reconcile';
    const holder = await connected.$client.connect();
    try {
      const locked = await holder.query<{ locked: boolean }>({
        text: 'select pg_try_advisory_lock(hashtext($1)) as locked',
        values: [key],
      });
      expect(locked.rows[0]?.locked).toBe(true);
      const gateOutcome = await withTryLock(connected, key, async () => 'ran');
      expect(gateOutcome).toBeNull();
      // 释放后可获
      await holder.query({ text: 'select pg_advisory_unlock(hashtext($1))', values: [key] });
      expect(await withTryLock(connected, key, async () => 'ran')).toBe('ran');
    } finally {
      holder.release();
    }
  });
});

/** 与 assembly 同形的会话锁门（真实 PG 语义验证） */
async function withTryLock<T>(target: Db, key: string, fn: () => Promise<T>): Promise<T | null> {
  const client = await target.$client.connect();
  try {
    const locked = await client.query<{ locked: boolean }>({
      text: 'select pg_try_advisory_lock(hashtext($1)) as locked',
      values: [key],
    });
    if (locked.rows[0]?.locked !== true) return null;
    try {
      return await fn();
    } finally {
      await client.query({ text: 'select pg_advisory_unlock(hashtext($1))', values: [key] });
    }
  } finally {
    client.release();
  }
}


const redisUrl = process.env.WORKER_REDIS_URL ?? process.env.REDIS_URL;

describe('worker 真 Redis：BullMQ 结算队列', () => {
  /** Redis 可达性探测（不可达整组 skip——与 PG 同口径） */
  async function redisReachable(): Promise<boolean> {
    if (!redisUrl) return false;
    const probe = new IORedis(redisUrl, {
      maxRetriesPerRequest: 0,
      connectTimeout: 1_000,
      lazyConnect: true,
    });
    try {
      await probe.connect();
      const pong = await probe.ping();
      return pong === 'PONG';
    } catch {
      return false;
    } finally {
      probe.disconnect();
    }
  }

  it(
    'jobId 去重入队 → worker 消费（重复 id 只处理一次）;retried 结局重投后完成',
    async (context) => {
      if (!(await redisReachable())) return context.skip();
      const calls: string[] = [];
      let retryOncePending = true;
      const face = createSettlementQueue({
        redisUrl: redisUrl as string,
        prefix: `{bull}:worker-real-test:${Date.now()}`, // 共享 Redis 隔离前缀
        concurrency: 2,
        maxAttempts: 3,
        backoffBaseMs: 50,
        process: async (requestId) => {
          calls.push(requestId);
          if (requestId === 'retry-once' && retryOncePending) {
            retryOncePending = false;
            return 'retried'; // 首次瞬时失败 → BullMQ 退避重投
          }
          return 'settled';
        },
        logger: { info: () => {}, error: () => {} },
      });
      try {
        await face.enqueueMany(['job-a', 'job-b', 'job-a']); // 重复 id
        const dedupDone = () =>
          calls.includes('job-a') && calls.includes('job-b') && calls.filter((c) => c === 'job-a').length === 1;
        expect(await waitFor(dedupDone, 5_000)).toBe(true);
        await face.enqueueMany(['retry-once']);
        const retriedTwice = () => calls.filter((c) => c === 'retry-once').length >= 2;
        expect(await waitFor(retriedTwice, 5_000)).toBe(true); // retried → 重投 → settled
      } finally {
        await face.close();
      }
    },
    15_000,
  );
});
