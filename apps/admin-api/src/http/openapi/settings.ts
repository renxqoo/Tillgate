/**
 * 运营系统设置 OpenAPI registry（routes/settings.ts 契约面）。
 */
import { z } from 'zod';
import { settingsContracts } from '../contracts/settings';

const billingTimezoneSchema = z.object({ timezone: z.string().min(1).max(64) });
const billingTimezoneReadSchema = z.object({ timezone: z.string().min(1).max(64).nullable() });

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
] as const;
