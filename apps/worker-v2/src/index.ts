/**
 * worker 入口：事件驱动结算（BullMQ 'settle-wake' 唤醒，毫秒级）+
 * 四定时器兜底（结算扫描 + 滞留回收 + 生成任务轮询 + 佣金日结），优雅停机。
 * 业务全部来自 service 包；本文件只有节奏与生命周期。
 * 账务正确性不依赖消息：认领/幂等全在 DB，唤醒通道故障退化为兜底扫描节奏。
 */
import { createDb, type Db } from '@ai-gateway/db';
import { assertRedisReachable, createRedisClient } from '@ai-gateway/core';
import { createRepositories } from '@ai-gateway/repository';
import {
  createBillingDomain,
  createGenerationPollUseCase,
  createSettlementDomain,
  createWallet,
  systemContext,
} from '@ai-gateway/service';
import { loadConfig, type WorkerConfig } from './config.js';
import { createRunOnce } from './run-once.js';
import { createTaskAdapter } from './generation-adapter.js';
import { runReferralCommissionOnce } from './tasks/referral-commission.js';
import { createSettleWakeupConsumer } from './wakeup.js';

export interface WorkerHandles {
  stop(): Promise<void>;
}

export async function startWorker(
  config: WorkerConfig,
  db: Db = createDb(config.DATABASE_URL, { poolMax: config.WORKER_BATCH_SIZE + 5 }),
): Promise<WorkerHandles> {
  const ctx = systemContext(config.WORKER_OWNER_ID);
  const repos = createRepositories();
  // Redis 必配（首选组件：ai 状态共享；连不上拒绝启动）
  const redis = createRedisClient(config.REDIS_URL, { serviceName: 'worker-v2' });
  await assertRedisReachable(redis, 'worker-v2', config.REDIS_URL);
  // 配置快照：关键业务参数生效值一处可查（排查「以为配了其实默认」类问题）
  console.log(
    `[worker-v2] config snapshot: ${JSON.stringify({
      currency: config.WORKER_CURRENCY,
      referralCommissionRate: config.REFERRAL_COMMISSION_RATE,
      settleIntervalMs: config.WORKER_SETTLE_INTERVAL_MS,
      referralIntervalMs: config.WORKER_REFERRAL_INTERVAL_MS,
      batchSize: config.WORKER_BATCH_SIZE,
      maxAttempts: config.WORKER_MAX_ATTEMPTS,
    })}`,
  );
  const settlement = createSettlementDomain({
    db,
    currency: config.WORKER_CURRENCY,
    policy: {
      maxAttempts: config.WORKER_MAX_ATTEMPTS,
      baseDelayMs: config.WORKER_BASE_DELAY_MS,
      maxDelayMs: config.WORKER_MAX_DELAY_MS,
    },
  });
  const runOnce = createRunOnce({
    settlement,
    ownerId: config.WORKER_OWNER_ID,
    batchSize: config.WORKER_BATCH_SIZE,
    claimLeaseMs: config.WORKER_CLAIM_LEASE_MS,
  });
  // 结算唤醒消费端（BullMQ 门铃）：事件驱动即时结算 + 满批排空（积压一次抽干）；
  // 定时轮询缩为兜底。可配置关闭（纯轮询形态/测试隔离——多测试进程同队列会互相偷门铃）
  const settleWakeup = config.WORKER_SETTLE_WAKEUP
    ? createSettleWakeupConsumer(
        config.REDIS_URL,
        async () => { await runOnce(ctx); },
        {
          logger: console as unknown as { error(obj: unknown, msg: string): void },
          batchSize: config.WORKER_BATCH_SIZE,
          pendingCount: async () => {
            const inv = await repos.billingRequest.inventory({ ...ctx, db }, new Date());
            return inv.pending + inv.retrying;
          },
        },
      )
    : null;
  // 生成任务轮询：终态信号（实扣/释放）走 billing 域；结算仍由 settlement 批次消费
  const billing = createBillingDomain({ db, currency: config.WORKER_CURRENCY });
  const pollGeneration = createGenerationPollUseCase({
    db,
    signal: (c, event) => billing.signal(c, event),
    taskPort: createTaskAdapter({
      encryptionKey: config.CHANNEL_API_KEY_ENCRYPTION,
      redis,
      ...(config.WORKER_AI_ALLOW_LOCAL_URL ? { allowLocalUrl: true } : {}),
    }),
    config: {
      batch: config.WORKER_GENERATION_BATCH_SIZE,
      leaseMs: config.WORKER_GENERATION_LEASE_MS,
      expireReason: config.WORKER_GENERATION_EXPIRE_REASON,
    },
  });

  // 邀请佣金日结：独立 wallet 实例（refType 'referral' 白名单）；幂等在 wallet 自然键
  const referralWallet = createWallet({
    db,
    guards: {
      refTypes: ['referral'],
      currencies: [config.WORKER_CURRENCY],
      internalAccounts: ['outside', 'platform_revenue'],
    },
    currency: config.WORKER_CURRENCY,
  });

  let running = true;
  // 在途批次全量登记（四循环并发时单变量会互相覆盖——停机只等最后一批，旧的被杀在半路）
  const inFlight = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>): Promise<unknown> => {
    inFlight.add(p);
    void p.catch(() => undefined).then(() => inFlight.delete(p));
    return p;
  };
  const loop = (intervalMs: number, job: () => Promise<unknown>, name: string) => {
    const tick = async () => {
      if (!running) return;
      try {
        await track(Promise.resolve(job()));
      } catch (error) {
        console.error(`[worker] ${name} loop failed:`, error);
      }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    return timer;
  };

  const timers = [
    loop(config.WORKER_SETTLE_INTERVAL_MS, () => runOnce(ctx), 'settle'),
    loop(
      config.WORKER_RECOVER_INTERVAL_MS,
      () => settlement.recover(ctx, { batchSize: config.WORKER_RECOVERY_BATCH_SIZE }),
      'recover',
    ),
    loop(config.WORKER_GENERATION_INTERVAL_MS, () => pollGeneration(ctx), 'generation'),
    loop(
      config.WORKER_REFERRAL_INTERVAL_MS,
      () =>
        runReferralCommissionOnce({
          db,
          wallet: referralWallet,
          commissionRate: config.REFERRAL_COMMISSION_RATE,
          ctx,
        }),
      'referral',
    ),
  ];

  return {
    async stop() {
      running = false; // 拒新批次
      for (const timer of timers) clearInterval(timer);
      // 全部在途批次完成（宽限上界内）；账务安全网：认领租约到期由他副本/下轮 recover 接管
      await Promise.race([
        Promise.allSettled(inFlight),
        new Promise((resolve) => setTimeout(resolve, config.WORKER_SHUTDOWN_GRACE_MS).unref()),
      ]);
      // 优雅停机：本副本仍持有的 processing 认领立即归还 retry_wait（不等 60s 租约自然到期）
      await repos.billingRequest
        .abandonOwnedClaims({ ...ctx, db }, config.WORKER_OWNER_ID, new Date())
        .catch(() => undefined);
      await settleWakeup?.close().catch(() => undefined);
      await redis?.quit().catch(() => {});
      await db.$client.end().catch(() => {});
    },
  };
}

if (process.env.NODE_ENV !== 'test') {
  const handles = await startWorker(loadConfig());
  const shutdown = (signal: string) => {
    console.log(`[worker] ${signal} received, stopping`);
    void handles.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 30_000).unref(); // 强退兜底
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  console.log('[worker-v2] started');
}
