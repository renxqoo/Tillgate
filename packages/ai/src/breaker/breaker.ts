import type { BreakerState, BreakerStorage } from '../config.js';

/**
 * 熔断器原语：closed / open / half-open 状态机 + 滚动窗口计数
 * 计数只收 circuitTrip=true 的错误（5xx/网络/超时）——429/4xx/死凭据不跳闸
 * （由调用方在 recordFailure({ circuitTrip }) 时判定，本类只按传入值计数）
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

function initialState(): BreakerState {
  return { state: 'closed', failures: [], windowStart: Date.now() };
}

export class CircuitBreaker {
  constructor(
    private readonly key: string,
    private readonly config: BreakerConfig,
    private readonly storage: BreakerStorage,
    private readonly now: () => number = Date.now,
  ) {}

  /** 调用前：是否放行（open 且未到冷却 → 拒绝；冷却到期 → half-open 放行探测） */
  async canRequest(): Promise<boolean> {
    const state = await this.load();
    if (state.state === 'open') {
      if (this.now() >= (state.cooldownUntil ?? 0)) {
        state.state = 'half-open';
        await this.save(state);
        return true;
      }
      return false;
    }
    return true;
  }

  /**
   * 调用后记录失败。circuitTrip=false（429/4xx/死凭据）不计数——
   * 避免一个用户的坏 Key 或请求问题熔断整个渠道。
   */
  async recordFailure(opts: { circuitTrip: boolean }): Promise<void> {
    if (!opts.circuitTrip) return;
    const state = await this.load();
    const now = this.now();

    // half-open 探测失败 → 立即回 open
    if (state.state === 'half-open') {
      state.state = 'open';
      state.openedAt = now;
      state.cooldownUntil = now + this.config.cooldownMs;
      await this.save(state);
      return;
    }

    // closed：滚动窗口计数
    const windowStart = now - this.config.windowMs;
    state.failures = state.failures.filter((t) => t >= windowStart);
    state.failures.push(now);
    if (state.failures.length >= this.config.failureThreshold) {
      state.state = 'open';
      state.openedAt = now;
      state.cooldownUntil = now + this.config.cooldownMs;
      state.failures = [];
    }
    await this.save(state);
  }

  /** 调用后记录成功：half-open 探测成功 → 恢复 closed（清空窗口） */
  async recordSuccess(): Promise<void> {
    const state = await this.load();
    if (state.state === 'half-open') {
      state.state = 'closed';
      state.failures = [];
      state.openedAt = undefined;
      state.cooldownUntil = undefined;
      await this.save(state);
    }
  }

  private async load(): Promise<BreakerState> {
    return (await this.storage.getState(this.key)) ?? initialState();
  }

  private async save(state: BreakerState): Promise<void> {
    // TTL 略大于冷却时长，保证 open 状态不会因 TTL 提前丢失
    await this.storage.setState(this.key, state, this.config.cooldownMs + this.config.windowMs);
  }
}
