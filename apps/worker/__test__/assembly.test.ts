/**
 * 装配根规格（trace-receiver 同款手法：不可达 DB 的惰性池——全链装配不触库）：
 * jobs 注册清单、静音/唤醒开关的装配影响、健康深度报告形状、可拆卸。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { defined } from './defined.js';
import { assembleWorker } from '../src/assembly';
import { loadWorkerConfig } from '../src/config';
import type { WorkerAssembly } from '../src/assembly';

const config = (overrides: Record<string, string | undefined> = {}) =>
  loadWorkerConfig({
    DATABASE_URL: 'postgres://u:p@localhost:5432/unreachable-worker-test',
    CHANNEL_API_KEY_ENCRYPTION: 'wk3y-zx9q'.repeat(4),
    REDIS_URL: 'redis://u:p@localhost:6399/unreachable-worker-test',
    OTEL_TRACES_MODE: 'off',
    WORKER_SETTLE_WAKE: 'false', // 单测不挂 LISTEN（专用连接会尝试建连）
    ...overrides,
  } as NodeJS.ProcessEnv);

describe('assembleWorker', () => {
  const assemblies: WorkerAssembly[] = [];
  // timeout 放宽:不可达 Redis 的有界收口竞速最多 10s/实例
  afterAll(async () => {
    for (const assembly of assemblies) {
      // BullMQ 消费端先收口(断 ioredis 重连定时器),再收 db 池
      await assembly.settleQueue.close().catch(() => {});
      await assembly.closeDb().catch(() => {});
    }
  }, 60_000);

  it('off 模式全链装配：七个 job 注册 + 唤醒关闭 + 健康深度报告形状', async () => {
    const assembly = assembleWorker(config());
    assemblies.push(assembly);
    expect([...assembly.jobs].toSorted()).toEqual([
      'generation',
      'notify',
      'partitions',
      'reconcile',
      'recover',
      'referral',
      'settle',
    ]);
    expect(assembly.wakeup).toBeNull();
    expect(typeof assembly.abandonOwnedClaims).toBe('function');
    await expect(assembly.healthState.ready()).resolves.toBe(false);
    const deep = assembly.healthState.deep() as Record<string, unknown>;
    expect(deep.owner).toBe(`worker-${process.pid}`);
    expect(deep.running).toBe(false); // 未 start
    expect(Object.keys(deep.jobs as Record<string, unknown>).toSorted()).toEqual(
      [...assembly.jobs].toSorted(),
    );
  });

  it('WORKER_NOTIFY_ENABLED=false → notify 静音（不注册）', () => {
    const assembly = assembleWorker(config({ WORKER_NOTIFY_ENABLED: 'false' }));
    assemblies.push(assembly);
    expect(assembly.jobs.includes('notify')).toBe(false);
    expect(assembly.jobs).toHaveLength(6);
  });

  it('池-并发不变量从注册表派生：并发 12 + 7 tick（notify 开，partitions/reconcile 双连接）超池 20 → fail-fast', () => {
    // 旧手工记账 RUNNER_COUNT=6 会算 12+6+2=20 放行（漏 notify tick 与持锁
    // 双连接 tick，红队复审 R-2）；注册表派生 = 12 + (1+1+1+1+2+2+1) + 2 = 23 > 20
    expect(() => assembleWorker(config({ WORKER_SETTLE_CONCURRENCY: '12' }))).toThrow(
      /worker DB pool 20 < worst-case DB concurrency 23/,
    );
    // 静音 notify（6 tick，连接需求 8）+ 并发 10 = 20 恰好覆盖 → 放行
    const tight = assembleWorker(
      config({ WORKER_SETTLE_CONCURRENCY: '10', WORKER_NOTIFY_ENABLED: 'false' }),
    );
    assemblies.push(tight);
    expect(tight.jobs).toHaveLength(6);
  });

  it('WORKER_SETTLE_WAKE=true → 唤醒消费端挂载（LISTEN 专用连接尽力建连，失败仅日志）', async () => {
    const assembly = assembleWorker(config({ WORKER_SETTLE_WAKE: 'true' }));
    assemblies.push(assembly);
    expect(assembly.wakeup).not.toBeNull();
    // 初始建连对不可达库异步失败（sweep covers 口径）——close 幂等收口
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    await defined(assembly.wakeup, 'assembly.wakeup').close();
  });

  it('pingDb 暴露为闭包（非 Db 类型泄漏——P5 口径的健康探测面）', () => {
    const assembly = assembleWorker(config());
    assemblies.push(assembly);
    expect(typeof assembly.pingDb).toBe('function');
  });
});
