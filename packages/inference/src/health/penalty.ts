import type { HealthStore, Versioned } from '../ports/state';

/**
 * 渠道惩罚箱（工厂闭包形态）：上游 429（rate_limited，窗口性）与配额耗尽
 * （quota_exhausted，持久性）的跨请求冷却记忆——这两类错误不进熔断
 * （circuitTrip=false）、不进死凭据，缺本记忆时每个新请求都会按调度序
 * 先撞一次坏渠道再换（多一跳 RTT 且持续打上游）。
 *
 *   - rate_limited：冷却 = max(Retry-After, base × 2^(连续-1))，封顶 maxMs
 *     （上游给的 Retry-After 是权威下界；连续命中指数退避防反复短冷却）；
 *   - quota_exhausted：固定冷却 quotaMs（充值/配额重置是小时级事件，指数无意义）；
 *   - 冷却期内 record 同 kind → 连续 +1（指数加长）；冷却过期后再记 → 重置为 1；
 *   - 合并规则 = 约束更强者胜：quota 冷却期间 rate_limited 不缩短 until（不降级）；
 *     反向升级（429 期间来 quota）与同 kind 指数退避照常；until 单调不缩短。
 *
 * 记账点在候选循环失败收口（dispatchFailure——429/quota 必然首字节前），
 * 查询点在渠道门（gateChannel）。键按 channelId（上游限流/配额是渠道账户属性，
 * 同 host 换 Key 即是新账户）。
 * 并发安全：CAS（与熔断器同构），写竞争低，重试上限 3 后降级放弃。
 */

export interface PenaltyConfig {
  /** 429 冷却基线（ms）；连续命中按 2^n 退避 */
  rateLimitBaseMs: number;
  /** 429 冷却封顶（ms） */
  rateLimitMaxMs: number;
  /** quota_exhausted 冷却（ms，固定窗口） */
  quotaMs: number;
}

export type PenaltyKind = 'rate_limited' | 'quota_exhausted';

export interface PenaltyState extends Versioned {
  kind: PenaltyKind;
  /** 冷却截止时刻（epoch ms）；now >= until 视为无惩罚（键 TTL 兜底清理） */
  until: number;
  /** 连续惩罚次数（rate_limited 指数退避依据） */
  consecutive: number;
}

/** CAS 重试上限（避免 livelock） */
const CAS_MAX_RETRIES = 3;

export interface PenaltyHandle {
  /** 冷却期内 → true（渠道门跳过该渠道） */
  penalized(): Promise<boolean>;
  /** 冷却剩余毫秒（0 = 无惩罚/已过期）——终局有界等待的最早恢复依据 */
  remainingMs(): Promise<number>;
  /** 记一次惩罚（kind + 可选 Retry-After 权威下界） */
  record(kind: PenaltyKind, retryAfterMs?: number): Promise<void>;
}

/** 冷却时长计算（纯函数：kind 语义分流，rate_limited 指数退避封顶） */
export function penaltyDelayMs(input: {
  kind: PenaltyKind;
  consecutive: number;
  config: PenaltyConfig;
  retryAfterMs?: number;
}): number {
  if (input.kind === 'quota_exhausted') return input.config.quotaMs;
  const exp = Math.min(
    input.config.rateLimitBaseMs * 2 ** (Math.max(1, input.consecutive) - 1),
    input.config.rateLimitMaxMs,
  );
  return Math.max(exp, input.retryAfterMs ?? 0, 1);
}

/** 降级判定（纯函数）：现存 quota 冷却 + 新 rate_limited + 候选 until 更短 → 拒绝记账 */
function isDegradingSignal(input: {
  state: PenaltyState | null;
  kind: PenaltyKind;
  at: number;
  candidateUntil: number;
}): boolean {
  const { state, kind, at, candidateUntil } = input;
  return (
    state != null &&
    at < state.until &&
    kind === 'rate_limited' &&
    state.kind === 'quota_exhausted' &&
    candidateUntil < state.until
  );
}

/** 记账一次（模块级）：降级拒绝 → 连续计数 → until 单调不缩短 → CAS */
async function recordPenalty(
  ctx: { env: { key: string; config: PenaltyConfig; store: HealthStore }; now(): number },
  kind: PenaltyKind,
  retryAfterMs?: number,
): Promise<void> {
  const at = ctx.now();
  const candidateUntil =
    at + penaltyDelayMs({ kind, consecutive: 1, config: ctx.env.config, retryAfterMs });
  for (let retry = 0; retry < CAS_MAX_RETRIES; retry++) {
    const state = await ctx.env.store.getState<PenaltyState>(ctx.env.key);
    // 约束更强者胜：quota 冷却期间的瞬态 429 不得缩短 until（不降级——降级会造成
    // 「冷却提前结束→再撞一次 quota 才重记 30min」的无谓上游调用）
    if (isDegradingSignal({ state, kind, at, candidateUntil })) return;
    // 连续语义：上次冷却未过期（同窗口内再犯）→ +1；过期/无状态 → 重置
    const active = state != null && at < state.until;
    const consecutive = active && state.kind === kind ? state.consecutive + 1 : 1;
    const delayMs = penaltyDelayMs({ kind, consecutive, config: ctx.env.config, retryAfterMs });
    const next: PenaltyState = {
      kind,
      until: at + delayMs,
      consecutive,
      version: (state?.version ?? 0) + 1,
    };
    // until 单调不缩短：新算更短（降级信号）只刷新 kind/consecutive，冷却保持
    if (state != null && active && next.until < state.until) next.until = state.until;
    const ok = await ctx.env.store.compareAndSet(
      ctx.env.key,
      state?.version ?? 0,
      next,
      Math.max(delayMs, next.until - at) + 1_000,
    );
    if (ok) return;
  }
  // 超出重试上限：放弃本次记账（惩罚是尽力保护，丢一次计数无害）
}

export function createPenaltyTracker(env: {
  key: string;
  config: PenaltyConfig;
  store: HealthStore;
  now?: () => number;
}): PenaltyHandle {
  const now = env.now ?? Date.now;
  return {
    async penalized(): Promise<boolean> {
      const state = await env.store.getState<PenaltyState>(env.key);
      return state != null && now() < state.until;
    },
    async remainingMs(): Promise<number> {
      const state = await env.store.getState<PenaltyState>(env.key);
      if (state == null) return 0;
      return Math.max(0, state.until - now());
    },
    record: (kind, retryAfterMs) => recordPenalty({ env, now }, kind, retryAfterMs),
  };
}
