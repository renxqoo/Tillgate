/**
 * 环境配置（zod 解析，装配唯一入口）：部署可变值全在此声明——
 * 业务参数（币种/阈值）必填或显式默认，代码零写死。
 */
import { z } from 'zod';
import { secretSchema, strictBooleanSchema } from '@ai-gateway/core';
import { Decimal } from '@ai-gateway/domain';

const positiveDecimal = z
  .string()
  .regex(/^\d{1,20}(?:\.\d{1,18})?$/)
  .refine((value) => !/^0+(?:\.0+)?$/.test(value));

function createSchema(production: boolean) {
  return z.object({
  /** 基础设施必配（fail-closed：连错库/忘配 = 拒绝启动，不落默认值跑偏） */
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(8080),
  /** DB 连接池上限（高并发部署按库容量调） */
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** 计费币种（装配注入 service 层） */
  GATEWAY_CURRENCY: z.string().default('CNY'),
  /** 结算积压准入阈值（张数 / 最老账龄 ms） */
  ADMISSION_MAX_PENDING: z.coerce.number().int().positive().default(10_000),
  ADMISSION_MAX_OLDEST_MS: z.coerce.number().int().positive().default(300_000),
  /** 单请求风险敞口上限（只拒绝不截断）与实际冻结策略。 */
  BILLING_RESERVATION_MAX: positiveDecimal.default('1000'),
  BILLING_RESERVATION_MODE: z.enum(['full', 'fixed']).default('full'),
  BILLING_FIXED_RESERVATION_AMOUNT: positiveDecimal.optional(),
  BILLING_AUTHORIZATION_TTL_MS: z.coerce.number().int().positive().default(300_000),
  /** 生成任务族：任务 TTL（超时上界）与租约宽限（轮询续租安全垫） */
  GENERATION_TASK_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  GENERATION_LEASE_GRACE_MS: z.coerce.number().int().positive().default(30_000),
  /** Redis（缺省未配置 = 单副本开发形态：状态内存化、限流/爆破防护降级关闭） */
  /** 鉴权爆破防护：per-keyHash 失败阈值/窗口/锁定 + per-IP 失败阈值（秒窗口即锁时长） */
  AUTH_KEY_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  AUTH_KEY_FAILURE_WINDOW_S: z.coerce.number().int().positive().default(600),
  AUTH_KEY_LOCK_S: z.coerce.number().int().positive().default(600),
  AUTH_IP_FAILURE_LIMIT: z.coerce.number().int().positive().default(30),
  AUTH_IP_FAILURE_WINDOW_S: z.coerce.number().int().positive().default(300),
  /** 可信代理跳数（来源 IP 提取语义：0 = 不信 XFF；N = 反代后取右数第 N 跳） */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  /** 全局 RPM 上限（所有请求并罚 global 维；生产强制 ≤5000——v1 对位） */
  GLOBAL_RPM: z.coerce.number().int().min(0).default(2_000),
  /** 上游调用总预算（ms——deadlineMs 传入 ai 包重试/熔断面） */
  GATEWAY_UPSTREAM_DEADLINE_MS: z.coerce.number().int().positive().default(120_000),
  /** 上游连接+响应头（TTFB）预算（ms——慢上游的非流式长生成需放宽；默认 10s 同 v1） */
  GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** 允许上游寻址回环/私网（SSRF 防护的 dev/test 逃生门——生产恒为 false） */
  GATEWAY_AI_ALLOW_LOCAL_URL: strictBooleanSchema(false),
  /** 优雅停机：停收新请求后等待在途完成的上界（ms）。
   *  默认 60s 覆盖流式长尾（长思考模型单流数十秒常见）——15s 会让长流被
   *  ServerDrainAbort 切断成 server_draining 单（估算计费+客诉面）；配合
   *  LB 先摘流再停机，宽限加长几乎不拖慢滚动 */
  GATEWAY_SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(60_000),
  /** OTel：off 完全 no-op / otlp 走 collector（须配 endpoint） */
  OTEL_TRACES_MODE: z.enum(['off', 'otlp']).default('off'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  /** 输出敞口护栏：客户端未传 max_tokens 时的缺省与总敞口封顶 */
  DEFAULT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4_096),
  GATEWAY_OUTPUT_EXPOSURE_CAP: z.coerce.number().int().positive().default(32_768),
  /** 渠道 apiKeyEnc 解密密钥（单 key 单格式 enc:v1——core.encrypt/decrypt 唯一口径） */
  CHANNEL_API_KEY_ENCRYPTION: secretSchema('CHANNEL_API_KEY_ENCRYPTION', 32),
  /** App JWT 签发密钥与有效期（/oauth/token） */
  JWT_SECRET: secretSchema('JWT_SECRET', production ? 32 : 16),
  JWT_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),
  }).superRefine((config, ctx) => {
    if (config.BILLING_RESERVATION_MODE === 'fixed' && config.BILLING_FIXED_RESERVATION_AMOUNT == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['BILLING_FIXED_RESERVATION_AMOUNT'],
        message: 'fixed 预扣模式必须配置 BILLING_FIXED_RESERVATION_AMOUNT',
      });
    }
    if (
      config.BILLING_FIXED_RESERVATION_AMOUNT != null &&
      new Decimal(config.BILLING_FIXED_RESERVATION_AMOUNT).gt(config.BILLING_RESERVATION_MAX)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['BILLING_FIXED_RESERVATION_AMOUNT'],
        message: '固定预扣金额不能超过单请求风险敞口上限',
      });
    }
  });
}

export type GatewayConfig = z.infer<ReturnType<typeof createSchema>>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  let parsed = createSchema(env.NODE_ENV === 'production').parse({
    ...env,
    // 渠道密钥：专用名优先，缺省回落 .env 规范键 ENCRYPTION_KEY（两处都未配置 =
    // 启动即失败——fail-closed，不带默认值）
    CHANNEL_API_KEY_ENCRYPTION: env.CHANNEL_API_KEY_ENCRYPTION ?? env.ENCRYPTION_KEY,
  });
  // 生产硬顶（v1 对位）：全局闸是护栏不是配额误配的放大器
  if (env.NODE_ENV === 'production' && parsed.GLOBAL_RPM > 5_000) {
    parsed = { ...parsed, GLOBAL_RPM: 5_000 };
  }
  // 废弃键检测（2026-08-21 黑盒子清除）：DEFAULT_USER_* 已删除——zod strip 会
  // 静默忽略残留配置，管理员以为限着实则不限；启动告警把认知错位变成显式
  for (const deprecated of ['DEFAULT_USER_RPM', 'DEFAULT_USER_TPM', 'FREE_MODEL_DAILY_LIMIT', 'GENERATION_MAX_ACTIVE_PER_USER']) {
    if (env[deprecated] != null && env[deprecated] !== '') {
      console.warn(`[gateway] 配置项 ${deprecated} 已废弃（用户级限流无兜底默认——未设置=不限，需要护栏在管理面『限流』页显式配置），当前值被忽略`);
    }
  }
  return parsed;
}
