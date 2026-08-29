import type { HealthStore, Versioned } from '../ports/state';

/**
 * 模型死记忆（工厂闭包形态）：某 realModel 候选全渠道耗尽（所有渠道
 * 门拒绝或尝试失败）的连续计数——达阈值后在 TTL 窗口内跳过该候选，
 * 避免死候选链每个新请求被完整重走一遍（admitModel 只管 RPM/TPM，
 * 熔断是 host 维——都没有「模型维不可用」概念）。
 *
 *   - 失败 = 候选级事实（渠道循环耗尽未 return），一次请求最多记一次；
 *   - 成功 = 任意请求在该候选上成功 → 清零（低频读写，无热路径放大）；
 *   - TTL 过期自然复活（模型恢复的兜底路径——成功自愈是快路径）。
 *
 * 并发安全：CAS（与熔断器同构）。键按 realModel（候选维事实，跨渠道共享）。
 */

export interface ModelDeadConfig {
  /** 连续全渠道耗尽达阈值 → 判死 */
  failureThreshold: number;
  /** 判死后跳过窗口（ms）；窗口过期自然复活 */
  ttlMs: number;
  /** 连续计数的窗口（ms）：上次失败距今超窗 → 重置 */
  windowMs: number;
}

export interface ModelDeadState extends Versioned {
  dead: boolean;
  consecutive: number;
  lastFailedAt?: number;
}

/** CAS 重试上限（避免 livelock） */
const CAS_MAX_RETRIES = 3;

export interface ModelDeadHandle {
  /** 判死窗口内 → true（候选循环跳过该候选，trace model.skip reason=dead_model） */
  isDead(): Promise<boolean>;
  /** 候选全渠道耗尽后记一次 */
  recordFailure(): Promise<void>;
  /** 候选成功清零（无状态时 no-op——热路径零写放大） */
  recordSuccess(): Promise<void>;
}

/** 判死过期判定（复活兜底——成功自愈是快路径，TTL 过期是慢路径） */
function deadExpired(state: ModelDeadState, now: number, ttlMs: number): boolean {
  return now - (state.lastFailedAt ?? 0) > ttlMs;
}

/** 窗口内连续计数（纯函数）：计数态且上次失败在窗口内 → +1；否则重置为 1 */
function nextCountOf(state: ModelDeadState | null, at: number, config: ModelDeadConfig): number {
  const inWindow =
    state != null &&
    !state.dead &&
    state.lastFailedAt !== undefined &&
    at - state.lastFailedAt <= config.windowMs;
  return inWindow ? (state?.consecutive ?? 0) + 1 : 1;
}

/** 记失败：窗口内连续计数，达阈值判死（TTL = 判死窗口）；超限放弃（尽力记忆） */
async function recordModelDeadFailure(ctx: {
  env: { key: string; config: ModelDeadConfig; store: HealthStore };
  now(): number;
}): Promise<void> {
  const at = ctx.now();
  for (let retry = 0; retry < CAS_MAX_RETRIES; retry++) {
    const state = await ctx.env.store.getState<ModelDeadState>(ctx.env.key);
    if (state?.dead === true) {
      // 已判死：续窗（TTL 重置为判死窗口）——不重置计数、不翻回存活
      // （并发在途 herd 各自耗尽会把计数重置——死标记必须保持到成功自愈或 TTL 过期）
      const renewed: ModelDeadState = {
        dead: true,
        consecutive: state.consecutive,
        lastFailedAt: at,
        version: state.version + 1,
      };
      if (
        await ctx.env.store.compareAndSet(ctx.env.key, state.version, renewed, ctx.env.config.ttlMs)
      ) {
        return;
      }
      continue; // CAS 失败重试
    }
    const consecutive = nextCountOf(state, at, ctx.env.config);
    const dead = consecutive >= ctx.env.config.failureThreshold;
    // dead 状态 TTL = 判死窗口（过期复活）；计数态 TTL = 窗口（无后续失败自然清零）
    const ttl = dead
      ? ctx.env.config.ttlMs
      : Math.max(ctx.env.config.windowMs - (at - (state?.lastFailedAt ?? at)), 1_000);
    const next: ModelDeadState = {
      dead,
      consecutive,
      lastFailedAt: at,
      version: (state?.version ?? 0) + 1,
    };
    if (await ctx.env.store.compareAndSet(ctx.env.key, state?.version ?? 0, next, ttl)) return;
  }
}

/** 记成功：有状态才清零（无状态 no-op——热路径零写放大） */
async function recordModelDeadSuccess(ctx: {
  env: { key: string; config: ModelDeadConfig; store: HealthStore };
  now(): number;
}): Promise<void> {
  for (let retry = 0; retry < CAS_MAX_RETRIES; retry++) {
    const current = await ctx.env.store.getState<ModelDeadState>(ctx.env.key);
    if (current == null) return;
    const next: ModelDeadState = { dead: false, consecutive: 0, version: current.version + 1 };
    if (
      await ctx.env.store.compareAndSet(ctx.env.key, current.version, next, ctx.env.config.windowMs)
    )
      return;
  }
}

export function createModelDeadTracker(env: {
  key: string;
  config: ModelDeadConfig;
  store: HealthStore;
  now?: () => number;
}): ModelDeadHandle {
  const now = env.now ?? Date.now;
  return {
    async isDead(): Promise<boolean> {
      const state = await env.store.getState<ModelDeadState>(env.key);
      return state != null && state.dead && !deadExpired(state, now(), env.config.ttlMs);
    },
    recordFailure: () => recordModelDeadFailure({ env, now }),
    recordSuccess: () => recordModelDeadSuccess({ env, now }),
  };
}
