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
  estimate: z
    .object({
      charPerToken: z.number().min(1).default(3.5),
    })
    .default({
      charPerToken: 3.5,
    }),
});

export type AiConfig = z.infer<typeof aiConfigSchema>;

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
}

/** 熔断状态持久化（gateway 注入 Redis 实现，多实例共享） */
export interface BreakerStorage {
  getState(key: string): Promise<BreakerState | null>;
  setState(key: string, state: BreakerState, ttlMs: number): Promise<void>;
}

export interface BreakerState {
  state: 'closed' | 'open' | 'half-open';
  /** 滚动窗口内的失败时间戳（circuitTrip 计数） */
  failures: number[];
  windowStart: number;
  openedAt?: number;
  cooldownUntil?: number;
}

export function defaultAiConfig(): AiConfig {
  return aiConfigSchema.parse({});
}
