import { describe, expect, it } from 'vitest';
import { DeadCredentialTracker } from '../../src/dead-credential/tracker.js';
import { MemoryKvStorage } from '../../src/internal/memory-storage.js';
import type { DeadCredentialState } from '../../src/config.js';
import type { DeadCredentialConfig } from '../../src/dead-credential/tracker.js';

const config: DeadCredentialConfig = { failureThreshold: 3, windowMs: 3_600_000 };

function makeTracker(now: () => number, onInvalid?: () => void) {
  return new DeadCredentialTracker('test-channel', config, new MemoryKvStorage<DeadCredentialState>(), now, onInvalid);
}

describe('DeadCredentialTracker', () => {
  it('valid 状态放行', async () => {
    let t = 1000;
    const d = makeTracker(() => t);
    expect(await d.canRequest()).toBe(true);
  });

  it('deadCredential=false 不计数（与熔断正交：非死凭据失败不影响凭据状态）', async () => {
    let t = 1000;
    const d = makeTracker(() => t);
    for (let i = 0; i < 10; i++) await d.recordFailure({ deadCredential: false });
    expect(await d.canRequest()).toBe(true);
  });

  it('连续死凭据失败未达阈值 → 仍 valid', async () => {
    let t = 1000;
    const d = makeTracker(() => t);
    await d.recordFailure({ deadCredential: true });
    await d.recordFailure({ deadCredential: true });
    expect(await d.canRequest()).toBe(true);
  });

  it('连续死凭据失败达阈值 → invalid + 拒绝', async () => {
    let t = 1000;
    const d = makeTracker(() => t);
    for (let i = 0; i < 3; i++) await d.recordFailure({ deadCredential: true });
    expect(await d.canRequest()).toBe(false);
  });

  it('成功调用清零计数', async () => {
    let t = 1000;
    const d = makeTracker(() => t);
    await d.recordFailure({ deadCredential: true });
    await d.recordFailure({ deadCredential: true });
    await d.recordSuccess();
    // 清零后再连续 2 次不够阈值（成功后计数从 0 重新累计）
    await d.recordFailure({ deadCredential: true });
    await d.recordFailure({ deadCredential: true });
    expect(await d.canRequest()).toBe(true);
  });

  it('invalid 后成功调用 → 恢复 valid（凭据恢复）', async () => {
    let t = 1000;
    const d = makeTracker(() => t);
    for (let i = 0; i < 3; i++) await d.recordFailure({ deadCredential: true });
    expect(await d.canRequest()).toBe(false);
    await d.recordSuccess();
    expect(await d.canRequest()).toBe(true);
  });

  it('窗口外失败重置计数（不连续）', async () => {
    let t = 1000;
    const d = makeTracker(() => t);
    await d.recordFailure({ deadCredential: true });
    await d.recordFailure({ deadCredential: true });
    t += 3_600_001; // 超过窗口
    // 窗口外：上次失败已过期，本次重置为 1
    await d.recordFailure({ deadCredential: true });
    expect(await d.canRequest()).toBe(true); // 仅 1 次连续，未达阈值 3
  });

  it('不同 key 状态隔离', async () => {
    let t = 1000;
    const storage = new MemoryKvStorage<DeadCredentialState>();
    const a = new DeadCredentialTracker('channel-a', config, storage, () => t);
    const b = new DeadCredentialTracker('channel-b', config, storage, () => t);
    for (let i = 0; i < 3; i++) await a.recordFailure({ deadCredential: true });
    expect(await a.canRequest()).toBe(false);
    expect(await b.canRequest()).toBe(true);
  });
});

describe('DeadCredentialTracker 并发安全', () => {
  it('并发 recordFailure 不丢计数：N 个并发后状态正确', async () => {
    let t = 1000;
    const storage = new MemoryKvStorage<DeadCredentialState>();
    const d = new DeadCredentialTracker('conc-test', config, storage, () => t);
    // 阈值 3，并发 3 个死凭据失败 → 应 invalid
    await Promise.all(Array.from({ length: 3 }, () => d.recordFailure({ deadCredential: true })));
    expect(await d.canRequest()).toBe(false);
  });

  it('并发 canRequest + recordFailure：invalid 后并发请求都被拒', async () => {
    let t = 1000;
    const d = makeTracker(() => t);
    for (let i = 0; i < 3; i++) await d.recordFailure({ deadCredential: true });
    const results = await Promise.all(Array.from({ length: 10 }, () => d.canRequest()));
    expect(results.every((r) => r === false)).toBe(true);
  });
});


describe('DeadCredentialTracker.onInvalid（软杀告警挂点）', () => {
  it('达阈值翻转时恰好触发一次（阈值后继续失败不重复发）', async () => {
    let t = 1000;
    let fired = 0;
    const d = makeTracker(() => t, () => { fired += 1; });
    await d.recordFailure({ deadCredential: true });
    await d.recordFailure({ deadCredential: true });
    expect(fired).toBe(0); // 未达阈值不发
    await d.recordFailure({ deadCredential: true });
    expect(fired).toBe(1); // 翻转发一次
    await d.recordFailure({ deadCredential: true });
    await d.recordFailure({ deadCredential: true });
    expect(fired).toBe(1); // 已 invalid 不重复发
  });

  it('恢复（成功）后再次翻转 → 再次触发（每轮告警一条）', async () => {
    let t = 1000;
    let fired = 0;
    const d = makeTracker(() => t, () => { fired += 1; });
    for (let i = 0; i < 3; i++) await d.recordFailure({ deadCredential: true });
    expect(fired).toBe(1);
    await d.recordSuccess();
    expect(await d.canRequest()).toBe(true);
    for (let i = 0; i < 3; i++) await d.recordFailure({ deadCredential: true });
    expect(fired).toBe(2);
  });

  it('不传回调零影响', async () => {
    let t = 1000;
    const d = makeTracker(() => t);
    for (let i = 0; i < 3; i++) await d.recordFailure({ deadCredential: true });
    expect(await d.canRequest()).toBe(false);
  });
});
