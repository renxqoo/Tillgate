import type { HealthStore, Versioned } from '../ports/state';

/**
 * 死凭据计数器（工厂闭包形态）：
 *   - 连续死凭据失败（invalid_api_key/insufficient_permissions 机制位）达阈值 →
 *     标记 invalid + 路由停止放行（单阈值判定）
 *   - 成功调用 → 清零计数 / invalid → valid（凭据恢复或人工换 Key 后首个成功）
 *   - 不计熔断（坏 Key 不熔断渠道，与 breaker 职责正交）
 *
 * 并发安全：状态转移走 compareAndSet CAS（与熔断器同构），多实例计数不丢；
 * 写竞争低，CAS 重试上限 3 次后降级「尽力计数」。
 */

export interface DeadCredentialConfig {
  /** 连续失败达阈值 → invalid */
  failureThreshold: number;
  /** 计数窗口（ms）：上次失败距今超过该值则重置计数 */
  windowMs: number;
}

export interface DeadCredentialState extends Versioned {
  status: 'valid' | 'invalid';
  consecutiveFailures: number;
  lastFailedAt?: number;
  invalidAt?: number;
}

/** CAS 重试上限（避免 livelock） */
const CAS_MAX_RETRIES = 3;

function validState(): DeadCredentialState {
  return { status: 'valid', consecutiveFailures: 0, version: 0 };
}

export interface DeadCredentialHandle {
  /** 调用前：是否放行（invalid → 拒绝，候选循环跳过该渠道） */
  canRequest(): Promise<boolean>;
  /** 调用后记录失败（deadCredential=false 不计数） */
  recordFailure(opts: { deadCredential: boolean }): Promise<void>;
  /** 调用后记录成功：清零计数；invalid → valid（凭据恢复） */
  recordSuccess(): Promise<void>;
}

/** 死凭据上下文（依赖 + 注入时钟） */
interface DeadCredentialCtx {
  env: { key: string; config: DeadCredentialConfig; store: HealthStore };
  now(): number;
}

async function loadDeadCredentialState(ctx: DeadCredentialCtx): Promise<DeadCredentialState> {
  return (await ctx.env.store.getState<DeadCredentialState>(ctx.env.key)) ?? validState();
}

async function casDeadCredential(
  ctx: DeadCredentialCtx,
  current: DeadCredentialState,
  mutator: (s: DeadCredentialState) => DeadCredentialState,
): Promise<boolean> {
  const next = mutator({ ...current });
  next.version = current.version + 1;
  /** TTL 略大于窗口，保证 invalid 状态不会因 TTL 提前丢失 */
  return await ctx.env.store.compareAndSet(
    ctx.env.key,
    current.version,
    next,
    ctx.env.config.windowMs * 2,
  );
}

/** 记录失败：窗口内连续计数，达阈值 CAS 转 invalid（超限降级放弃计数——尽力保护） */
async function recordDeadCredentialFailure(
  ctx: DeadCredentialCtx,
  opts: { deadCredential: boolean },
): Promise<void> {
  if (!opts.deadCredential) return;
  const at = ctx.now();
  for (let retry = 0; retry < CAS_MAX_RETRIES; retry++) {
    const state = await loadDeadCredentialState(ctx);
    // 窗口语义：上次失败距今超过窗口 → 不算连续，重置为 1
    const inWindow =
      state.lastFailedAt !== undefined && at - state.lastFailedAt <= ctx.env.config.windowMs;
    const consecutive = inWindow ? state.consecutiveFailures + 1 : 1;

    if (consecutive >= ctx.env.config.failureThreshold) {
      if (
        await casDeadCredential(ctx, state, (s) => ({
          ...s,
          status: 'invalid',
          consecutiveFailures: consecutive,
          lastFailedAt: at,
          invalidAt: at,
        }))
      ) {
        return;
      }
      continue;
    }
    if (
      await casDeadCredential(ctx, state, (s) => ({
        ...s,
        consecutiveFailures: consecutive,
        lastFailedAt: at,
      }))
    ) {
      return;
    }
  }
  // 超出重试上限：降级放弃本次计数（死凭据是尽力保护）
}

/** 记录成功：清零计数；invalid → valid（凭据恢复或人工换 Key 后首个成功） */
async function recordDeadCredentialSuccess(ctx: DeadCredentialCtx): Promise<void> {
  const state = await loadDeadCredentialState(ctx);
  if (state.status === 'valid' && state.consecutiveFailures === 0) return; // 无需更新
  await casDeadCredential(ctx, state, () => ({ ...validState() }));
}

export function createDeadCredentialTracker(env: {
  key: string;
  config: DeadCredentialConfig;
  store: HealthStore;
  now?: () => number;
}): DeadCredentialHandle {
  const ctx: DeadCredentialCtx = { env, now: env.now ?? Date.now };
  return {
    async canRequest(): Promise<boolean> {
      const state = await loadDeadCredentialState(ctx);
      return state.status !== 'invalid';
    },
    recordFailure: (opts) => recordDeadCredentialFailure(ctx, opts),
    recordSuccess: () => recordDeadCredentialSuccess(ctx),
  };
}
