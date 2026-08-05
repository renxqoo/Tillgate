import { describe, expect, it, vi } from 'vitest';
import { MeterProducer } from './meter.js';

/**
 * MeterProducer 入队失败处理（资损防线 B4）：
 *   - enqueue 失败不能被静默吞掉（之前是 .catch(()=>{})，导致漏计费无感知）
 *   - 失败必须记日志 + 计数告警指标（meter_enqueue_failed_total）
 *   - removeOnFail 不能太小（之前 1000 条后自动删，丢死信）
 *
 * 测试用 mock Queue 模拟 BullMQ（不依赖真实 Redis）。
 */

/** 构造 MeterProducer，注入 mock Queue（绕过真实 BullMQ + Redis 连接） */
function makeProducer(queueAdd: (name: string, data: unknown, opts: unknown) => Promise<unknown>) {
  // 用 Object.create 跳过构造函数（避免实例化真实 BullMQ Queue 连 Redis）
  const producer = Object.create(MeterProducer.prototype) as MeterProducer;
  (producer as unknown as { queue: { add: typeof queueAdd } }).queue = {
    add: queueAdd,
  } as never;
  producer.onFailure = null;
  return producer;
}

describe('MeterProducer 入队失败处理', () => {
  it('enqueue 成功 → 返回 {ok:true}', async () => {
    const producer = makeProducer(async () => ({ id: 'job-1' }));
    const result = await producer.enqueue({
      requestId: 'test-ok',
      userId: 1,
      apiKeyId: null,
      appId: null,
      credentialType: 'key',
      externalModel: 'm',
      realModel: 'm',
      channelId: null,
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, estimated: false },
      inputPrice: '0.001',
      outputPrice: '0.002',
      cacheInputPrice: '0.0001',
      coefficient: '1.0',
      durationMs: 100,
      stream: false,
      streamAborted: false,
      holdAmount: '0',
      mappingId: 1,
    });
    expect(result.ok).toBe(true);
  });

  it('enqueue 失败 → 返回 {ok:false, error}（不抛异常，不静默吞）', async () => {
    const producer = makeProducer(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await producer.enqueue({
      requestId: 'test-fail',
      userId: 1,
      apiKeyId: null,
      appId: null,
      credentialType: 'key',
      externalModel: 'm',
      realModel: 'm',
      channelId: null,
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, estimated: false },
      inputPrice: '0.001',
      outputPrice: '0.002',
      cacheInputPrice: '0.0001',
      coefficient: '1.0',
      durationMs: 100,
      stream: false,
      streamAborted: false,
      holdAmount: '0',
      mappingId: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain('ECONNREFUSED');
  });

  it('enqueue 失败 → 调用 onFailure 回调（记日志/告警钩子）', async () => {
    const onFailure = vi.fn();
    const producer = makeProducer(async () => {
      throw new Error('OOM');
    });
    producer.onFailure = onFailure;
    await producer.enqueue({
      requestId: 'test-callback',
      userId: 1,
      apiKeyId: null,
      appId: null,
      credentialType: 'key',
      externalModel: 'm',
      realModel: 'm',
      channelId: null,
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, estimated: false },
      inputPrice: '0.001',
      outputPrice: '0.002',
      cacheInputPrice: '0.0001',
      coefficient: '1.0',
      durationMs: 100,
      stream: false,
      streamAborted: false,
      holdAmount: '0',
      mappingId: 1,
    });
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'test-callback' }),
      expect.any(Error),
    );
  });

  it('enqueue 配置 removeOnFail=false（失败 job 永久保留，防死信被自动删导致漏计费）', async () => {
    let capturedConfig: unknown = null;
    const producer = makeProducer(async (_data: unknown) => {
      return ({ id: '1' });
    });
    const realAdd = (producer as unknown as { queue: { add: (n: string, d: unknown, o: unknown) => Promise<unknown> } }).queue.add;
    (producer as unknown as { queue: { add: (n: string, d: unknown, o: unknown) => Promise<unknown> } }).queue.add = (
      name: string,
      data: unknown,
      options: unknown,
    ) => {
      capturedConfig = options;
      return realAdd(name, data, options);
    };
    await producer.enqueue({
      requestId: 'test-config',
      userId: 1,
      apiKeyId: null,
      appId: null,
      credentialType: 'key',
      externalModel: 'm',
      realModel: 'm',
      channelId: null,
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, estimated: false },
      inputPrice: '0.001',
      outputPrice: '0.002',
      cacheInputPrice: '0.0001',
      coefficient: '1.0',
      durationMs: 100,
      stream: false,
      streamAborted: false,
      holdAmount: '0',
      mappingId: 1,
    });
    const cfg = capturedConfig as { removeOnFail?: number | boolean };
    // BullMQ 语义：removeOnFail=true → count:0（删除全部失败 job）；
    //   removeOnFail=false → count:-1（永久保留，不自动删）。
    // 计费资损防线：失败 job 必须保留供运维重放，因此 removeOnFail 必须为 false。
    expect(cfg.removeOnFail).toBe(false);
  });
});
