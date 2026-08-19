import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../../src/breaker/breaker.js';
import type { BreakerState } from '../../src/config.js';
import { MemoryKvStorage } from '../../src/internal/memory-storage.js';
import { SseScanner } from '../../src/transport/sse-parser.js';
import { estimateAudioDurationSeconds } from '../../src/usage/media-duration.js';
import { DEFAULT_TOKEN_ESTIMATE_CALIBRATION, resolveCalibration } from '../../src/usage/calibration.js';

const openState = async (storage: MemoryKvStorage<BreakerState>, key: string, cooldownUntil: number): Promise<void> => {
  await storage.setState(key, {
    state: 'open', failures: [1, 2, 3, 4, 5], windowStart: 0,
    cooldownUntil, version: 1,
  }, 60_000);
};

describe('熔断器边角：halfOpenProbe=false 冷却直闭 + CAS 竞争重试', () => {
  it('halfOpenProbe=false：冷却到期 → canRequest 直接 CAS 回 closed', async () => {
    const storage = new MemoryKvStorage<BreakerState>();
    await openState(storage, 'x', Date.now() - 1);
    const breaker = new CircuitBreaker('x', {
      windowMs: 60_000, failureThreshold: 5, cooldownMs: 1, halfOpenProbe: false,
    }, storage, Date.now);
    await expect(breaker.canRequest()).resolves.toBe(true);
    const after = await storage.getState('x');
    expect(after?.state).toBe('closed');
  });

  it('halfOpenProbe=false：冷却未到 → 拒绝', async () => {
    const storage = new MemoryKvStorage<BreakerState>();
    await openState(storage, 'y', Date.now() + 60_000);
    const breaker = new CircuitBreaker('y', {
      windowMs: 60_000, failureThreshold: 5, cooldownMs: 300_000, halfOpenProbe: false,
    }, storage, Date.now);
    await expect(breaker.canRequest()).resolves.toBe(false);
  });
});

describe('内存 KV 存储：CAS 版本冲突 → 返回 false（不覆盖他人写入）', () => {
  it('compareAndSet 旧版本 → false；正确版本 → true', async () => {
    const storage = new MemoryKvStorage<{ v: number; version: number }>();
    await storage.setState('k', { v: 1, version: 3 }, 60_000);
    await expect(storage.compareAndSet('k', 2, { v: 2, version: 4 }, 1_000)).resolves.toBe(false);
    await expect(storage.compareAndSet('k', 3, { v: 2, version: 4 }, 1_000)).resolves.toBe(true);
    expect(await storage.getState('k')).toEqual({ v: 2, version: 4 });
    expect(await storage.getState('missing')).toBeNull();
  });
});

const deltaFrame = (delta: unknown) =>
  new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);

describe('SseScanner：tool_calls 输出累计 + 边界/时间戳', () => {
  it('tool_calls 的 function.name 与 arguments 累计进 outputText', () => {
    const scanner = new SseScanner();
    scanner.consume(deltaFrame({ tool_calls: [{ index: 0, function: { name: 'get_', arguments: '{"a":' } }] }));
    scanner.consume(deltaFrame({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }));
    // 坏形状（function 非对象）不贡献文本也不抛
    scanner.consume(deltaFrame({ tool_calls: [{ index: 0 }] }));
    expect(scanner.getOutputText()).toBe('get_{"a":1}');
  });

  it('atBoundary：帧后为真；getLastEventAt 单调', async () => {
    const scanner = new SseScanner();
    expect(scanner.atBoundary()).toBe(true);
    scanner.consume(new TextEncoder().encode('data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n'));
    expect(scanner.atBoundary()).toBe(true);
    await new Promise((r) => setTimeout(r, 2));
    expect(scanner.getLastEventAt()).toBeLessThanOrEqual(Date.now());
  });
});

describe('音频时长：MP3 ID3 头 + 帧同步解析 / 兜底', () => {
  it('带 ID3v2 头的 MPEG1 LayerIII 128kbps 流 → 按位率估秒', () => {
    // ID3v2 头（10B，tag size 0）+ 帧同步 0xFF FB（MPEG1 LayerIII 128kbps）+ 数据
    const bytes = new Uint8Array(10 + 16_000); // 128kbps = 16KB/s → 约 1s
    bytes[0] = 0x49; bytes[1] = 0x44; bytes[2] = 0x33; // "ID3"
    bytes[10] = 0xff; bytes[11] = 0xfb; bytes[12] = 0x90; // 同步 + 128kbps 索引 9
    expect(estimateAudioDurationSeconds(bytes)).toBe(1);
  });

  it('MPEG2 LayerIII 低档位表 + 无法识别的字节 → 兜底 16KB/s', () => {
    const mpeg2 = new Uint8Array(8_000);
    mpeg2[0] = 0xff; mpeg2[1] = 0xf3; mpeg2[2] = 0x40; // MPEG2 LayerIII 位率档位
    expect(estimateAudioDurationSeconds(mpeg2)).toBeGreaterThanOrEqual(1);
    const noise = new Uint8Array(32_000).fill(0x01);
    expect(estimateAudioDurationSeconds(noise)).toBe(2); // 32KB / 16KB/s
    expect(estimateAudioDurationSeconds(new Uint8Array(0))).toBe(1); // 兜底下限 1s
  });
});

describe('校准解析：provider/model 层覆盖', () => {
  it('provider 层命中（注入表）→ weights 合并 + offset/tokensPerByte 覆盖；未命中 → 默认', () => {
    const table = {
      ...DEFAULT_TOKEN_ESTIMATE_CALIBRATION,
      providers: {
        demo: { weights: { cjk: 0.5 }, templateInputOffset: 9, tokensPerByte: 0.02 },
      },
    };
    const resolved = resolveCalibration('demo', 'x', table);
    expect(resolved.templateInputOffset).toBe(9);
    expect(resolved.tokensPerByte).toBe(0.02);
    expect(resolved.weights.cjk).toBe(0.5);
    const base = resolveCalibration('unknown-provider', 'x', table);
    expect(base.tokensPerByte).toBe(DEFAULT_TOKEN_ESTIMATE_CALIBRATION.tokensPerByte);
    expect(base.templateInputOffset).toBe(0);
  });

  it('model 级（provider:model 键）命中 → 覆盖 provider 层', () => {
    const mm = resolveCalibration('minimax', 'MiniMax-M3');
    expect(mm.tokensPerByte).toBe(DEFAULT_TOKEN_ESTIMATE_CALIBRATION.models['minimax:MiniMax-M3']!.tokensPerByte);
  });
});
