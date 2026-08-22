import { z } from 'zod';
import type { ProtocolAdapter } from './adapters/protocol-adapter';
import type { UrlGuard } from './types';

/**
 * ai 包配置（纯机制默认值，无业务、无策略——SSRF 名单等策略经 AiDeps.guardUrl 注入）。
 * 注：zod 4 的 .default() 默认值需为完整输出形状，故显式写出。
 */
export const aiDefaultsSchema = z.object({
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
  stream: z
    .object({
      heartbeatIdleMs: z.number().int().min(1).default(30_000),
      /** 首字节预算（headers 后 body 首字节；connectMs 只覆盖到响应头） */
      firstByteTimeoutMs: z.number().int().min(1).default(60_000),
      /** 流中段静默预算（首 chunk 之后无数据的上限） */
      inactivityTimeoutMs: z.number().int().min(1).default(120_000),
    })
    .default({
      heartbeatIdleMs: 30_000,
      firstByteTimeoutMs: 60_000,
      inactivityTimeoutMs: 120_000,
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
});

export type AiDefaults = z.infer<typeof aiDefaultsSchema>;
export type AiDefaultsInput = z.input<typeof aiDefaultsSchema>;

/**
 * createAi 第三参（注册即扩展）：协议适配器注入。
 * 不传 → 默认注册表；传入则整体替换（显式优先，不做隐式合并）；
 * 同 protocol 键重复注册在启动时抛错（结构上杜绝双真相）。
 */
export interface AiOptions {
  adapters?: ProtocolAdapter[];
}

/**
 * 依赖注入：宿主实现，包保持零业务/零 OTel 直接依赖。
 * §3.6 零运维状态——无状态存储注入点；§3.2 机制/策略分离——SSRF 名单经 guardUrl 注入。
 */
export interface AiDeps {
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
  tracer?: {
    startSpan: (name: string, attrs?: Record<string, unknown>) => { end: () => void };
  };
  /**
   * URL 守卫（SSRF 策略注入点）：缺省执行机械基线（https-only + 禁私网/回环 +
   * DNS 逐地址判定防 rebinding）；注入则整体替换。受信名单是业务数据——生产由
   * 装配方从渠道目录派生（组合 `assertSafeUrl(u, { allowedHosts })`），
   * 测试/本地调试注入 `allowAllUrls`。
   */
  guardUrl?: UrlGuard;
}

export function defaultAiDefaults(): AiDefaults {
  return aiDefaultsSchema.parse({});
}
