import { z } from 'zod';

/**
 * ai 包配置（纯机制参数，无业务；zod 校验 + 默认值）
 * 注：zod 4 的 .default() 默认值需为完整输出形状，故显式写出
 */
export const aiConfigSchema = z.object({
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).default(3),
      baseDelayMs: z.number().int().min(0).default(250),
      maxDelayMs: z.number().int().min(1).default(8000),
      jitterRatio: z.number().min(0).max(1).default(0.25),
      deadlineMs: z.number().int().min(1).default(240_000),
      emptyCompletionRetries: z.number().int().min(0).default(2),
    })
    .default({
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 8000,
      jitterRatio: 0.25,
      deadlineMs: 240_000,
      emptyCompletionRetries: 2,
    }),
  breaker: z
    .object({
      windowMs: z.number().int().min(1).default(60_000),
      failureThreshold: z.number().int().min(1).default(5),
      cooldownMs: z.number().int().min(1).default(300_000),
      halfOpenProbe: z.boolean().default(true),
    })
    .default({
      windowMs: 60_000,
      failureThreshold: 5,
      cooldownMs: 300_000,
      halfOpenProbe: true,
    }),
  stream: z
    .object({
      heartbeatIdleMs: z.number().int().min(1).default(30_000),
      inactivityTimeoutMs: z.number().int().min(1).default(300_000),
    })
    .default({
      heartbeatIdleMs: 30_000,
      inactivityTimeoutMs: 300_000,
    }),
  timeout: z
    .object({
      connectMs: z.number().int().min(1).default(10_000),
      totalMs: z.number().int().min(1).default(120_000),
    })
    .default({
      connectMs: 10_000,
      totalMs: 120_000,
    }),
  /** 允许 http + 内网地址（仅测试/本地调试；生产必须 false，SSRF 防线在配置层+此处双重） */
  allowLocalUrl: z.boolean().default(false),
  /** 生产上游域名白名单；配置后拒绝任何不在列表中的 hostname。 */
  allowedHosts: z.array(z.string().min(1)).default([]),
  estimate: z
    .object({
      charPerToken: z.number().min(1).default(3.5),
    })
    .default({
      charPerToken: 3.5,
    }),
  /** 死凭据计数（requirements 5.16：连续 401/403 → 凭据无效 + 停止路由 + 告警） */
  deadCredential: z
    .object({
      /** 连续死凭据失败达阈值 → 标记 invalid（停止路由），默认 3 */
      failureThreshold: z.number().int().min(1).default(3),
      /** 计数窗口（ms）：窗口外的失败不计入连续次数，默认 1h */
      windowMs: z.number().int().min(1).default(3_600_000),
    })
    .default({
      failureThreshold: 3,
      windowMs: 3_600_000,
    }),
});

export type AiConfig = z.infer<typeof aiConfigSchema>;
export type AiConfigInput = z.input<typeof aiConfigSchema>;

/** 依赖注入：宿主实现，包保持零业务/零 OTel 直接依赖 */
export interface AiDeps {
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
  tracer?: {
    startSpan: (name: string, attrs?: Record<string, unknown>) => { end: () => void };
  };
  breakerStorage?: BreakerStorage;
  deadCredentialStorage?: DeadCredentialStorage;
}

/**
 * 熔断状态持久化（gateway 注入 Redis 实现，多实例共享）。
 * compareAndSet 用于多实例/高并发下的原子状态转移（half-open 单探测、滚动窗口计数无竞态）。
 */
export interface BreakerStorage {
  getState(key: string): Promise<BreakerState | null>;
  /**
   * 原子 CAS：仅当 key 当前 version === expectedVersion 时写入 next，返回是否成功。
   * key 不存在时 expectedVersion 传 0；写入成功后 next.version 成为新版本。
   * gateway 的 Redis 实现必须用 Lua 保证 GET+条件 SET 原子（不可拆成两次 RTT）。
   */
  compareAndSet(
    key: string,
    expectedVersion: number,
    next: BreakerState,
    ttlMs: number,
  ): Promise<boolean>;
  /** 无条件写入（初始化/降级兜底用；正常路径优先 compareAndSet） */
  setState(key: string, state: BreakerState, ttlMs: number): Promise<void>;
}

export interface BreakerState {
  state: 'closed' | 'open' | 'half-open';
  /** 滚动窗口内的失败时间戳（circuitTrip 计数） */
  failures: number[];
  windowStart: number;
  openedAt?: number;
  cooldownUntil?: number;
  /** 单调递增版本号（CAS 依据；每次状态变更 +1） */
  version: number;
}

// ---- 死凭据计数（requirements 5.16：连续 401/403 → 凭据无效 + 停止路由）----

/**
 * 死凭据状态持久化（与 BreakerStorage 同构，gateway 注入同一 Redis 实现）。
 * 复用 compareAndSet CAS 语义保证多实例并发下计数不丢、状态转移原子。
 */
export interface DeadCredentialStorage {
  getState(key: string): Promise<DeadCredentialState | null>;
  compareAndSet(
    key: string,
    expectedVersion: number,
    next: DeadCredentialState,
    ttlMs: number,
  ): Promise<boolean>;
  setState(key: string, state: DeadCredentialState, ttlMs: number): Promise<void>;
}

export interface DeadCredentialState {
  /** valid = 正常；invalid = 连续失败达阈值，凭据已失效（停止路由，等人工换 Key） */
  status: 'valid' | 'invalid';
  /** 连续死凭据失败次数（成功时清零） */
  consecutiveFailures: number;
  /** 最近一次失败时间戳（排障/滑动判定用） */
  lastFailedAt?: number;
  /** 标记为 invalid 的时间戳（admin-api 展示 + 手动恢复参考） */
  invalidAt?: number;
  /** 单调递增版本号（CAS 依据） */
  version: number;
}

export function defaultAiConfig(): AiConfig {
  return aiConfigSchema.parse({});
}
