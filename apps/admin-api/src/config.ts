/**
 * 环境配置（zod 解析，装配唯一入口）：部署可变值全在此声明——
 * 业务参数（开关/阈值/密钥）必填或显式默认，代码零写死。
 */
import { z } from 'zod';
import { secretSchema, strictBooleanSchema } from '@ai-gateway/core';

const nonNegativeDecimal = z.string().regex(/^\d{1,20}(?:\.\d{1,18})?$/);

function createSchema(production: boolean) {
  return z.object({
    /** 基础设施必配（fail-closed：连错库/忘配 = 拒绝启动，不落默认值跑偏） */
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    ADMIN_API_PORT: z.coerce.number().int().positive().default(8082),
    /** DB 连接池上限 */
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    /** 管理面会话 JWT 密钥（与用户面/网关物理隔离——token 跨面互斥的根） */
    ADMIN_JWT_SECRET: secretSchema('ADMIN_JWT_SECRET', production ? 32 : 16),
    /** 会话有效期（秒） */
    SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    /** 渠道上游 Key 落库加密密钥（单 key 单格式 enc:v1——core.encrypt 唯一口径） */
    ENCRYPTION_KEY: secretSchema('ENCRYPTION_KEY', 32),
    /** 登录爆破防护：per-邮箱 失败阈值/窗口/锁定 + per-IP 失败上限（Redis 形态生效） */
    LOGIN_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
    LOGIN_FAILURE_WINDOW_S: z.coerce.number().int().positive().default(600),
    LOGIN_LOCK_S: z.coerce.number().int().positive().default(600),
    LOGIN_IP_FAILURE_LIMIT: z.coerce.number().int().positive().default(50),
    LOGIN_IP_FAILURE_WINDOW_S: z.coerce.number().int().positive().default(300),
    /** 渠道/模型探针是否放行本地/私网上游（生产恒关——SSRF 硬闸，与配置无关） */
    ALLOW_LOCAL_UPSTREAM: strictBooleanSchema(false),
    /** 批量导入单次上限（渠道条目数） */
    CHANNEL_IMPORT_MAX: z.coerce.number().int().positive().default(1000),
    /** 目录导入：免费渠道限流预填（公开免费档限额量级） */
    CATALOG_FREE_CHANNEL_RPM: z.coerce.number().int().positive().default(20),
    /** 目录导入：免费渠道进货额度预填（上游成本 0，给足余量） */
    CATALOG_FREE_CHANNEL_BUDGET: nonNegativeDecimal.default('1000000'),
    /** 目录源拉取缓存 TTL（ms） */
    CATALOG_CACHE_TTL_MS: z.coerce.number().int().positive().default(600_000),
    /** SMTP 三要素（host/user/pass）齐全才启用发信；未配置 = 2FA 验证码不可用（fail-closed） */
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(465),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),
    /** 记账币种（wallet 装配注入；调账/赠送/订阅收款同一口径） */
    ADMIN_CURRENCY: z.string().default('CNY'),
    /** 渠道进货凭证：上传上限（字节）与本地存储目录（可换 OSS 实现——接口注入） */
    VOUCHER_MAX_BYTES: z.coerce.number().int().positive().default(2_097_152),
    /** Redis（缺省 = 单副本开发形态：登录爆破防护降级关闭；路由缓存失效靠网关 TTL 兜底） */
    /** 可信代理跳数（来源 IP 提取语义：0 = 不信 XFF） */
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
    /** CORS 白名单（逗号分隔；空 = 不放行跨域） */
    CORS_ORIGINS: z.string().default(''),
    /** 请求体上限（字节；批量导入批次较大） */
    ADMIN_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(4_194_304),
    /** 优雅停机：停收新请求后等待在途完成的上界（ms） */
    ADMIN_SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(10_000),
    /** OTel：off 完全 no-op / otlp 走 collector */
    OTEL_TRACES_MODE: z.enum(['off', 'otlp']).default('off'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  });
}

export type AdminApiConfig = z.infer<ReturnType<typeof createSchema>>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdminApiConfig {
  return createSchema(env.NODE_ENV === 'production').parse(env);
}
