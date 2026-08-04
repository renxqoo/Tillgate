import { describe, expect, it } from 'vitest';
import { DeadCredentialTracker } from '../../src/dead-credential/tracker.js';
import { MemoryDeadCredentialStorage } from '../../src/dead-credential/memory-storage.js';
import type { DeadCredentialConfig } from '../../src/dead-credential/tracker.js';

const config: DeadCredentialConfig = { failureThreshold: 3, windowMs: 3_600_000 };

function makeTracker(now: () => number) {
  return new DeadCredentialTracker('test-channel', config, new MemoryDeadCredentialStorage(), now);
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
    // 清零后再连续 2 次不够阈值（原来是 2，现在从 0 起）
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
    const storage = new MemoryDeadCredentialStorage();
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
    const storage = new MemoryDeadCredentialStorage();
    const d = new DeadCredentialTracker('conc-test', config, storage, () => t);
    // 阈值 3，并发 3 个死凭据失败 → 应 invalid
    await Promise.all(
      Array.from({ length: 3 }, () => d.recordFailure({ deadCredential: true })),
    );
    expect(await d.canRequest()).toBe(false);
  });

  it('并发 canRequest + recordFailure：invalid 后并发请求都被拒', async () => {
    let t = 1000;
    const d = makeTracker(() => t);
    for (let i = 0; i < 3; i++) await d.recordFailure({ deadCredential: true });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => d.canRequest()),
    );
    expect(results.every((r) => r === false)).toBe(true);
  });
});

describe('MemoryDeadCredentialStorage', () => {
  it('缺失 key → null；TTL 过期 → null', async () => {
    const s = new MemoryDeadCredentialStorage();
    expect(await s.getState('x')).toBeNull();
    await s.setState('x', { status: 'valid', consecutiveFailures: 0, version: 0 }, 5);
    expect(await s.getState('x')).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(await s.getState('x')).toBeNull();
  });

  it('compareAndSet：version 匹配才写入', async () => {
    const s = new MemoryDeadCredentialStorage();
    expect(await s.compareAndSet('k', 0, { status: 'valid', consecutiveFailures: 1, version: 1 }, 10_000)).toBe(true);
    expect(await s.compareAndSet('k', 0, { status: 'valid', consecutiveFailures: 2, version: 2 }, 10_000)).toBe(false);
    expect(await s.compareAndSet('k', 1, { status: 'invalid', consecutiveFailures: 3, version: 2 }, 10_000)).toBe(true);
    const got = await s.getState('k');
    expect(got?.status).toBe('invalid');
  });
});
