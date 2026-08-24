import type { HealthStore, Versioned } from '../ports/state';

/**
 * 熔断器原语（v1 packages/ai breaker/breaker.ts 迁移为工厂闭包，状态机语义不变）：
 * closed / open / half-open + 滚动窗口计数。计数只收 circuitTrip=true 的错误
 * （5xx/网络/超时）——429/4xx/死凭据不跳闸（避免一个坏 Key 熔断整个渠道）。
 *
 * 并发安全（v1 B5）：所有状态转移走 compareAndSet 原子 CAS，多实例/高并发下：
 *   - half-open 全局只有一个赢家放行探测（冷却到期瞬间 N 个并发只有 1 个 CAS 成功）
 *   - 滚动窗口计数不丢（并发各自 CAS，失败重试，上限 3 次后降级「放弃本次计数」）
 * CAS 失败重试上限避免理论 livelock（熔断写竞争低，几乎不会触发）。
 */

export interface BreakerConfig {
  /** 滚动窗口（ms） */
  windowMs: number;
  /** 窗口内失败 ≥ 阈值 → open */
  failureThreshold: number;
  /** 熔断冷却（ms） */
  cooldownMs: number;
  /** 冷却到期后是否进入 half-open 放行探测 */
  halfOpenProbe: boolean;
}

export interface BreakerState extends Versioned {
  state: 'closed' | 'open' | 'half-open';
  /** 滚动窗口内失败时间戳 */
  failures: number[];
  windowStart: number;
  openedAt?: number;
  cooldownUntil?: number;
}

/** CAS 重试上限（超出后降级「放弃本次计数」，不影响安全性） */
const CAS_MAX_RETRIES = 3;

function closedState(now: number): BreakerState {
  return { state: 'closed', failures: [], windowStart: now, version: 0 };
}

export interface CircuitBreakerHandle {
  /** 调用前：是否放行（open 且冷却到期时 CAS 转移——half-open 单探测只放一个赢家） */
  canRequest(): Promise<boolean>;
  /** 调用后记录失败（circuitTrip=false 不计数） */
  recordFailure(opts: { circuitTrip: boolean }): Promise<void>;
  /** 调用后记录成功：half-open 探测成功 → CAS 恢复 closed（清空窗口） */
  recordSuccess(): Promise<void>;
}

/** 熔断上下文（依赖 + 注入时钟） */
interface BreakerCtx {
  env: { key: string; config: BreakerConfig; store: HealthStore };
  now(): number;
}

async function loadBreakerState(ctx: BreakerCtx): Promise<BreakerState> {
  return (await ctx.env.store.getState<BreakerState>(ctx.env.key)) ?? closedState(ctx.now());
}

/** CAS 辅助：按 mutator 计算 next（version+1）并尝试一次；TTL 略大于冷却时长，保证 open 状态不会因 TTL 提前丢失 */
async function casBreaker(
  ctx: BreakerCtx,
  current: BreakerState,
  mutator: (s: BreakerState) => BreakerState,
): Promise<boolean> {
  const next = mutator({ ...current });
  next.version = current.version + 1;
  return await ctx.env.store.compareAndSet(
    ctx.env.key,
    current.version,
    next,
    ctx.env.config.cooldownMs + ctx.env.config.windowMs,
  );
}

/** open 态转移 mutator（重置冷却与窗口；half-open 探测失败与阈值触顶共用） */
function toOpenAt(ctx: BreakerCtx, at: number): (s: BreakerState) => BreakerState {
  return (s) => ({
    ...s,
    state: 'open',
    openedAt: at,
    cooldownUntil: at + ctx.env.config.cooldownMs,
    failures: [],
  });
}

/** 放行检查：open 且冷却到期时 CAS 转移（half-open 单探测只放一个赢家） */
async function breakerCanRequest(ctx: BreakerCtx): Promise<boolean> {
  const state = await loadBreakerState(ctx);
  if (state.state === 'closed') return true;
  if (state.state === 'half-open') return false; // 已有探测在飞
  // open
  if (!ctx.env.config.halfOpenProbe) {
    // 未开 half-open 探测：冷却到期后直接 CAS 回 closed
    if (ctx.now() >= (state.cooldownUntil ?? 0)) {
      return await casBreaker(ctx, state, (s) => ({
        ...s,
        state: 'closed',
        failures: [],
        openedAt: undefined,
        cooldownUntil: undefined,
      }));
    }
    return false;
  }
  if (ctx.now() < (state.cooldownUntil ?? 0)) return false;
  // 冷却到期：CAS open→half-open，只有赢家放行（half-open 单探测）
  return await casBreaker(ctx, state, (s) => ({ ...s, state: 'half-open' }));
}

/** 记录失败：half-open 探测失败 / closed 滚动窗口计数达阈值 → CAS 转 open（超限降级放弃计数——熔断是尽力而为的保护机制） */
async function breakerRecordFailure(
  ctx: BreakerCtx,
  opts: { circuitTrip: boolean },
): Promise<void> {
  if (!opts.circuitTrip) return;
  const at = ctx.now();
  for (let retry = 0; retry < CAS_MAX_RETRIES; retry++) {
    const state = await loadBreakerState(ctx);
    // half-open 探测失败 → CAS 回 open（重置 cooldownUntil）
    if (state.state === 'half-open') {
      if (await casBreaker(ctx, state, toOpenAt(ctx, at))) {
        return;
      }
      continue; // CAS 失败（被别的转移抢先），重试
    }
    // open：不重复计数（已 open 再失败无意义）
    if (state.state === 'open') return;
    // closed：滚动窗口计数
    const windowStart = at - ctx.env.config.windowMs;
    const failures = state.failures.filter((t) => t >= windowStart);
    failures.push(at);
    if (failures.length >= ctx.env.config.failureThreshold) {
      if (await casBreaker(ctx, state, toOpenAt(ctx, at))) {
        return;
      }
      continue;
    }
    if (
      await casBreaker(ctx, state, (s) => ({
        ...s,
        failures,
        windowStart: s.windowStart ?? at,
      }))
    ) {
      return;
    }
    // CAS 失败重试
  }
  // 超出重试上限：降级放弃本次计数（熔断是尽力而为的保护机制）
}

/** 记录成功：half-open 探测成功 → CAS 恢复 closed（清空窗口） */
async function breakerRecordSuccess(ctx: BreakerCtx): Promise<void> {
  const state = await loadBreakerState(ctx);
  if (state.state !== 'half-open') return; // closed 成功无意义；open 不可能收到成功
  await casBreaker(ctx, state, (s) => ({
    ...s,
    state: 'closed',
    failures: [],
    openedAt: undefined,
    cooldownUntil: undefined,
  }));
}

export function createCircuitBreaker(env: {
  key: string;
  config: BreakerConfig;
  store: HealthStore;
  now?: () => number;
}): CircuitBreakerHandle {
  const ctx: BreakerCtx = { env, now: env.now ?? Date.now };
  return {
    canRequest: () => breakerCanRequest(ctx),
    recordFailure: (opts) => breakerRecordFailure(ctx, opts),
    recordSuccess: () => breakerRecordSuccess(ctx),
  };
}
