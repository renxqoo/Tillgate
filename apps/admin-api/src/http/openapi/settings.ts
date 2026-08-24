/**
 * 运营系统设置 OpenAPI registry（routes/settings.ts 契约面）：
 * 计费时区 + 第三方集成动态配置（docs/integration-settings/DESIGN.md §4）。
 */
import { z } from 'zod';
import { settingsContracts } from '../contracts/settings';
import type { OpenApiParam } from './shared';

const billingTimezoneSchema = z.object({ timezone: z.string().min(1).max(64) });
const billingTimezoneReadSchema = z.object({ timezone: z.string().min(1).max(64).nullable() });

/** 集成设置项（GET 列表元素 / PUT 响应）：secret 字段只出掩码（**** + 尾 4 或 null） */
export const integrationItemSchema = z
  .object({
    key: z.string().describe('集成键（封闭词表：oauth.base/oauth.github/oauth.google/smtp/captcha.turnstile/payment.epay/payment.stripe）'),
    enabled: z.boolean(),
    configured: z.boolean().describe('必填字段齐全（enabled=true 的前置不变量）'),
    config: z.record(z.string(), z.string().nullable()).describe('字段值；secret 字段为掩码回显'),
    secretsSet: z.array(z.string()).describe('已设置的 secret 字段名（write-only 提示）'),
    rotatedAt: z.string().nullable().describe('最近一次验签密钥轮换时刻（支付双读窗锚）'),
    updatedAt: z.string().nullable(),
    updatedByAdminId: z.number().nullable(),
  })
  .meta({
    id: 'IntegrationSettingItem',
    description: '第三方集成设置项（GET/PUT /v1/settings/integrations；密文/明文永不回显）',
  });

const keyPathParam: OpenApiParam = {
  name: 'key',
  description: '集成键（封闭词表成员）',
  schema: z.string().min(1).max(64),
};

export const settingsEndpoints = [
  {
    method: 'get',
    path: '/v1/settings/billing-timezone',
    tag: 'settings',
    summary: '计费时区读（null = 未配置，消费方回落缺省 Asia/Shanghai）',
    response: { schema: billingTimezoneReadSchema },
    errors: [401],
  },
  {
    method: 'put',
    path: '/v1/settings/billing-timezone',
    tag: 'settings',
    summary: '计费时区写（IANA 名；生效节奏 = 网关缓存 TTL，历史账单自带时段标签不受影响）',
    body: settingsContracts.billingTimezoneUpdate,
    response: { schema: billingTimezoneSchema },
    errors: [400, 401],
  },
  {
    method: 'get',
    path: '/v1/settings/integrations',
    tag: 'settings',
    summary: '第三方集成设置列表（词表全量补齐；secret 字段掩码回显）',
    response: {
      schema: z.object({ integrations: z.array(integrationItemSchema) }),
    },
    errors: [401],
  },
  {
    method: 'put',
    path: '/v1/settings/integrations/:key',
    tag: 'settings',
    summary:
      '集成设置写（字段三态：缺席=保持 / null=清除 / 值=设置；enabled=true 需必填齐全；支付验签密钥轮换自动入双读窗）',
    params: [keyPathParam],
    body: settingsContracts.integrationsUpdate,
    response: { schema: integrationItemSchema },
    errors: [400, 401, 404],
  },
] as const;
