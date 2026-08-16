import type { BreakerState, BreakerStorage } from '../config';

/**
 * 熔断器原语：closed / open / half-open 状态机 + 滚动窗口计数。
 * 计数只收 circuitTrip=true 的错误（5xx/网络/超时）——429/4xx/死凭据不跳闸。
 *
 * 并发安全（B5）：所有状态转移走 compareAndSet 原子 CAS，保证多实例/高并发下：
 *   - half-open 全局只有一个赢家放行探测（冷却到期瞬间 N 个并发只有 1 个 CAS 成功）
 *   - 滚动窗口计数不丢（recordFailure 并发各自 CAS，失败则重试，上限 3 次后降级为「尽力计数」）
 * CAS 失败重试上限避免理论 livelock（实践中熔断写竞争低，几乎不会触发）。
 */

export interface BreakerConfig {
  /** 滚动窗口（ms），默认 60s */
  windowMs: number;
  /** 窗口内失败 ≥ 阈值 → open，默认 5 */
  failureThreshold: number;
  /** 熔断冷却（ms），默认 5min */
  cooldownMs: number;
  /** 冷却到期后是否进入 half-open 放行探测，默认 true */
  halfOpenProbe: boolean;
}

/** CAS 重试上限（避免 livelock；超出后降级为「放弃本次计数」，不影响安全性） */
const CAS_MAX_RETRIES = 3;

function closedState(now: number): BreakerState {
  return { state: 'closed', failures: [], windowStart: now, version: 0 };
}

export class CircuitBreaker {
  constructor(
    private readonly key: string,
    private readonly config: BreakerConfig,
    private readonly storage: BreakerStorage,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 调用前：是否放行。
   *   - closed / 无状态 → 放行
   *   - open 且未到冷却 → 拒绝
   *   - open 且冷却到期 → CAS open→half-open，全局只有一个赢家放行探测（half-open 单探测）
   *   - half-open → 拒绝（已有探测在飞，其他请求等待）
   */
  async canRequest(): Promise<boolean> {
    const state = await this.load();
    if (!state || state.state === 'closed') return true;
    if (state.state === 'half-open') return false; // 已有探测在飞
    // state.state === 'open'
    if (!this.config.halfOpenProbe) {
      // 未开 half-open 探测：冷却到期后直接 CAS 回 closed
      if (this.now() >= (state.cooldownUntil ?? 0)) {
        return await this.cas(state, () => ({
          ...state,
          state: 'closed',
          failures: [],
          openedAt: undefined,
          cooldownUntil: undefined,
        }));
      }
      return false;
    }
    if (this.now() < (state.cooldownUntil ?? 0)) return false;
    // 冷却到期：CAS open→half-open，只有赢家放行（half-open 单探测）
    return await this.cas(state, () => ({ ...state, state: 'half-open' }));
  }

  /**
   * 调用后记录失败。circuitTrip=false（429/4xx/死凭据）不计数——
   * 避免一个用户的坏 Key 或请求问题熔断整个渠道。
   * 所有状态转移走 cas() helper（统一递增 version，保证 CAS 语义有效）。
   */
  async recordFailure(opts: { circuitTrip: boolean }): Promise<void> {
    if (!opts.circuitTrip) return;
    const now = this.now();

    for (let retry = 0; retry < CAS_MAX_RETRIES; retry++) {
      const state = await this.load();
      // half-open 探测失败 → CAS 回 open（重置 cooldownUntil）
      if (state.state === 'half-open') {
        if (
          await this.cas(state, () => ({
            ...state,
            state: 'open',
            openedAt: now,
            cooldownUntil: now + this.config.cooldownMs,
            failures: [],
          }))
        )
          return;
        continue; // CAS 失败（被别的转移抢先），重试
      }
      // open：不重复计数（已 open 再失败无意义）
      if (state.state === 'open') return;
      // closed：滚动窗口计数
      const windowStart = now - this.config.windowMs;
      const failures = state.failures.filter((t) => t >= windowStart);
      failures.push(now);
      if (failures.length >= this.config.failureThreshold) {
        // 达阈值 → CAS 成 open
        if (
          await this.cas(state, () => ({
            ...state,
            state: 'open',
            openedAt: now,
            cooldownUntil: now + this.config.cooldownMs,
            failures: [],
          }))
        )
          return;
        continue;
      }
      // 未达阈值 → CAS 更新 failures
      if (
        await this.cas(state, () => ({
          ...state,
          failures,
          windowStart: state.windowStart ?? now,
        }))
      )
        return;
      // CAS 失败重试
    }
    // 超出重试上限：降级放弃本次计数（不影响安全性，熔断是尽力而为的保护机制）
  }

  /** 调用后记录成功：half-open 探测成功 → CAS 恢复 closed（清空窗口） */
  async recordSuccess(): Promise<void> {
    const state = await this.load();
    if (state.state !== 'half-open') return; // closed 成功无意义；open 不可能收到成功
    await this.cas(state, (s) => ({
      ...s,
      state: 'closed',
      failures: [],
      openedAt: undefined,
      cooldownUntil: undefined,
    }));
  }

  /** CAS 辅助：load 已完成，按 mutator 计算 next 并尝试一次，失败则放弃（调用方语义允许） */
  private async cas(
    current: BreakerState,
    mutator: (s: BreakerState) => BreakerState,
  ): Promise<boolean> {
    const next = mutator(current);
    next.version = current.version + 1;
    return await this.storage.compareAndSet(this.key, current.version, next, this.ttl());
  }

  private async load(): Promise<BreakerState> {
    return (await this.storage.getState(this.key)) ?? closedState(this.now());
  }

  /** TTL 略大于冷却时长，保证 open 状态不会因 TTL 提前丢失 */
  private ttl(): number {
    return this.config.cooldownMs + this.config.windowMs;
  }
}
