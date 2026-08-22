import type { DeadCredentialState, DeadCredentialStorage } from '../config';

/**
 * 死凭据计数器（requirements 5.16）：
 *   - 连续死凭据失败（401/403 + 文本特征）达阈值 → 标记 invalid + 停止路由 + 告警
 *   - 成功调用 → 清零计数 / invalid → valid（凭据恢复，或人工换 Key 后首 个成功调用）
 *   - 不计熔断（坏 Key 不应熔断整个 provider，与 breaker 职责正交）
 *
 * 并发安全：状态转移走 compareAndSet CAS（与 CircuitBreaker 同构），保证多实例计数不丢。
 * 死凭据写竞争低（仅 401/403 触发），CAS 重试上限 3 次后降级「尽力计数」。
 */

export interface DeadCredentialConfig {
  /** 连续失败达阈值 → invalid，默认 3 */
  failureThreshold: number;
  /** 计数窗口（ms）：上次失败距今超过该值则重置计数，默认 1h */
  windowMs: number;
}

/** CAS 重试上限（避免 livelock） */
const CAS_MAX_RETRIES = 3;

function validState(): DeadCredentialState {
  return { status: 'valid', consecutiveFailures: 0, version: 0 };
}

export class DeadCredentialTracker {
  constructor(
    private readonly key: string,
    private readonly config: DeadCredentialConfig,
    private readonly storage: DeadCredentialStorage,
    private readonly now: () => number = Date.now,
    /** 状态翻转成 invalid 时恰好触发一次（告警挂点；不传零影响） */
    private readonly onInvalid?: () => void,
  ) {}

  /** 调用前：是否放行（invalid → 拒绝，gateway 路由层跳过该渠道） */
  async canRequest(): Promise<boolean> {
    const state = await this.load();
    return state.status !== 'invalid';
  }

  /**
   * 调用后记录结果。
   * deadCredential=true：连续失败计数，达阈值 → invalid。
   * deadCredential=false：no-op（非死凭据失败/成功不计——成功由 recordSuccess 专门处理）。
   */
  async recordFailure(opts: { deadCredential: boolean }): Promise<void> {
    if (!opts.deadCredential) return;
    const now = this.now();

    for (let retry = 0; retry < CAS_MAX_RETRIES; retry++) {
      const state = await this.load();
      // 窗口语义：上次失败距今超过窗口 → 不算连续，重置为 1
      const inWindow =
        state.lastFailedAt !== undefined && now - state.lastFailedAt <= this.config.windowMs;
      const consecutive = inWindow ? state.consecutiveFailures + 1 : 1;

      if (consecutive >= this.config.failureThreshold) {
        // 达阈值 → 标记 invalid
        if (
          await this.cas(state, () => ({
            ...state,
            status: 'invalid',
            consecutiveFailures: consecutive,
            lastFailedAt: now,
            invalidAt: now,
          }))
        ) {
          // 仅真实翻转（valid → invalid）触发；invalid 后的续失败只刷新状态不重复发
          if (state.status !== 'invalid') this.onInvalid?.();
          return;
        }
        continue;
      }
      // 未达阈值 → 更新计数
      if (
        await this.cas(state, () => ({
          ...state,
          consecutiveFailures: consecutive,
          lastFailedAt: now,
        }))
      )
        return;
    }
    // 超出重试上限：降级放弃本次计数（不影响安全性，死凭据是尽力保护）
  }

  /** 调用后记录成功：清零计数；invalid → valid（凭据恢复） */
  async recordSuccess(): Promise<void> {
    const state = await this.load();
    if (state.status === 'valid' && state.consecutiveFailures === 0) return; // 无需更新
    await this.cas(state, () => ({ ...validState() }));
  }

  private async cas(
    current: DeadCredentialState,
    mutator: (s: DeadCredentialState) => DeadCredentialState,
  ): Promise<boolean> {
    const next = mutator(current);
    next.version = current.version + 1;
    return await this.storage.compareAndSet(this.key, current.version, next, this.ttl());
  }

  private async load(): Promise<DeadCredentialState> {
    return (await this.storage.getState(this.key)) ?? validState();
  }

  /** TTL 略大于窗口，保证 invalid 状态不会因 TTL 提前丢失 */
  private ttl(): number {
    return this.config.windowMs * 2;
  }
}
