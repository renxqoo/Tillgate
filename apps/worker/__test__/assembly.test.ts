/**
 * 装配根规格（trace-receiver 同款手法：不可达 DB 的惰性池——全链装配不触库）：
 * jobs 注册清单、静音/唤醒开关的装配影响、健康深度报告形状、可拆卸。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { assembleWorker } from '../src/assembly';
import { loadWorkerConfig } from '../src/config';
import type { WorkerAssembly } from '../src/assembly';

const config = (overrides: Record<string, string | undefined> = {}) =>
  loadWorkerConfig({
    DATABASE_URL: 'postgres://u:p@localhost:5432/unreachable-worker-test',
    CHANNEL_API_KEY_ENCRYPTION: 'wk3y-zx9q'.repeat(4),
    OTEL_TRACES_MODE: 'off',
    WORKER_SETTLE_WAKE: 'false', // 单测不挂 LISTEN（专用连接会尝试建连）
    ...overrides,
  } as NodeJS.ProcessEnv);

describe('assembleWorker', () => {
  const assemblies: WorkerAssembly[] = [];
  afterAll(async () => {
    for (const assembly of assemblies) {
      await assembly.closeDb().catch(() => undefined);
    }
  });

  it('off 模式全链装配：七个 job 注册 + 唤醒关闭 + 健康深度报告形状', () => {
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

  it('WORKER_SETTLE_WAKE=true → 唤醒消费端挂载（LISTEN 专用连接尽力建连，失败仅日志）', async () => {
    const assembly = assembleWorker(config({ WORKER_SETTLE_WAKE: 'true' }));
    assemblies.push(assembly);
    expect(assembly.wakeup).not.toBeNull();
    // 初始建连对不可达库异步失败（sweep covers 口径）——close 幂等收口
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assembly.wakeup!.close();
  });

  it('pingDb 暴露为闭包（非 Db 类型泄漏——P5 口径的健康探测面）', () => {
    const assembly = assembleWorker(config());
    assemblies.push(assembly);
    expect(typeof assembly.pingDb).toBe('function');
  });
});
