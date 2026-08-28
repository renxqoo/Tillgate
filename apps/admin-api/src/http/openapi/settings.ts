/**
 * 运营系统设置 OpenAPI registry（routes/settings.ts 契约面）：
 * 计费时区 + 第三方集成动态配置。
 */
import * as z from 'zod';
import { settingsContracts } from '../contracts/settings';
import type { OpenApiParam } from './shared';

const billingTimezoneSchema = z.object({ timezone: z.string().min(1).max(64) });
const billingTimezoneReadSchema = z.object({ timezone: z.string().min(1).max(64).nullable() });

/** 集成设置项（GET 列表元素 / PUT 响应）：secret 字段只出掩码（**** + 尾 4 或 null） */
export const integrationItemSchema = z
  .object({
    key: z
      .string()
      .describe(
        '集成键（封闭词表：oauth.github/oauth.google/smtp/captcha.turnstile/payment.epay/payment.stripe——oauth.base 已退回 env，ADR-0012）',
      ),
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

const debitFloorDefaultSchema = z.object({ floor: z.string() });
const billingReservationSchema = z.object({
  mode: z.enum(['full', 'fixed']),
  amount: z.string().optional(),
});
const billingReservationLimitSchema = z.object({ limit: z.string() });
const platformCurrencySchema = z.object({ currency: z.string() });

export const settingsEndpoints = [
  {
    method: 'get',
    path: '/v1/settings/billing-timezone',
    tag: 'settings',
    summary: '计费时区读（null = 未配置，消费方回落缺省 Asia/Shanghai）',
    response: { schema: billingTimezoneReadSchema },
    errors: [401, 403],
  },
  {
    method: 'put',
    path: '/v1/settings/billing-timezone',
    tag: 'settings',
    summary: '计费时区写（IANA 名；生效节奏 = 网关缓存 TTL，历史账单自带时段标签不受影响）',
    body: settingsContracts.billingTimezoneUpdate,
    response: { schema: billingTimezoneSchema },
    errors: [400, 401, 403],
  },
  {
    method: 'get',
    path: '/v1/settings/debit-floor-default',
    tag: 'settings',
    summary: '透支地板全局默认读（未配置 = "0" 不透支;新建钱包套用 + 批量刷默认基准）',
    response: { schema: debitFloorDefaultSchema },
    errors: [401, 403],
  },
  {
    method: 'put',
    path: '/v1/settings/debit-floor-default',
    tag: 'settings',
    summary: '透支地板全局默认写（即时生效;新钱包创建时套用;存量需调批量刷默认）',
    body: settingsContracts.debitFloorDefaultUpdate,
    response: { schema: debitFloorDefaultSchema },
    errors: [400, 401, 403],
  },
  {
    method: 'get',
    path: '/v1/settings/platform-currency',
    tag: 'settings',
    summary: '平台币种读（未配置 = CNY;写一次——各 app 启动读取）',
    response: { schema: platformCurrencySchema },
    errors: [401, 403],
  },
  {
    method: 'put',
    path: '/v1/settings/platform-currency',
    tag: 'settings',
    summary: '平台币种写（写一次:存在账本/渠道资金/用量记录即 409 锁定;换币需显式迁移）',
    body: settingsContracts.platformCurrencyUpdate,
    response: { schema: platformCurrencySchema },
    errors: [400, 401, 403, 409],
  },
  {
    method: 'get',
    path: '/v1/settings/billing-reservation-limit',
    tag: 'settings',
    summary: '单笔预估敞口上限读（未配置 = 1000;防单笔巨亏的结构性保险丝,网关 TTL 拾取）',
    response: { schema: billingReservationLimitSchema },
    errors: [401, 403],
  },
  {
    method: 'put',
    path: '/v1/settings/billing-reservation-limit',
    tag: 'settings',
    summary: '单笔预估敞口上限写（预估超限即 402 reservation_limit_exceeded;正金额）',
    body: settingsContracts.billingReservationLimitUpdate,
    response: { schema: billingReservationLimitSchema },
    errors: [400, 401, 403],
  },
  {
    method: 'get',
    path: '/v1/settings/billing-reservation',
    tag: 'settings',
    summary: '预扣策略读（未配置 = full 全额保守预扣;网关 TTL 缓存内拾取）',
    response: { schema: billingReservationSchema },
    errors: [401, 403],
  },
  {
    method: 'put',
    path: '/v1/settings/billing-reservation',
    tag: 'settings',
    summary:
      '预扣策略写（full 全额保守 / fixed 固定门槛厂商式——余额过门槛即放行,实际用量后付费结算,超出部分受 debit_floor 地板封底）',
    body: settingsContracts.billingReservationUpdate,
    response: { schema: billingReservationSchema },
    errors: [400, 401, 403],
  },
  {
    method: 'get',
    path: '/v1/settings/integrations',
    tag: 'settings',
    summary: '第三方集成设置列表（词表全量补齐；secret 字段掩码回显）',
    response: {
      schema: z.object({ integrations: z.array(integrationItemSchema) }),
    },
    errors: [401, 403],
  },
  {
    method: 'put',
    path: '/v1/settings/integrations/:key',
    tag: 'settings',
    summary:
      '集成设置写（settings:integrations 权限——0087 拆分；字段三态：缺席=保持 / null=清除 / 值=设置；enabled=true 需必填齐全；支付验签密钥轮换自动入双读窗）',
    params: [keyPathParam],
    body: settingsContracts.integrationsUpdate,
    response: { schema: integrationItemSchema },
    errors: [400, 401, 403, 404],
  },
  {
    method: 'post',
    path: '/v1/settings/integrations/smtp/test',
    tag: 'settings',
    summary:
      'SMTP 连通性探针（settings:integrations 权限；连接+认证校验，不发送邮件；测试弹窗当前填写值与存量合并——不落库；上游失败也是 200 探针结果）',
    body: settingsContracts.integrationsProbe,
    response: {
      schema: z.object({
        ok: z.boolean().describe('true = 连接与认证通过'),
        durationMs: z.number().describe('探针耗时（ms）'),
        error: z
          .object({ code: z.string(), message: z.string() })
          .optional()
          .describe('失败诊断（nodemailer 传输层 code，如 EAUTH/ETIMEDOUT）'),
      }),
    },
    errors: [400, 401, 403],
  },
] as const;
