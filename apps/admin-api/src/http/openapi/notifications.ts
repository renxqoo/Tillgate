/**
 * 通知域 OpenAPI registry（routes/notifications.ts 契约面）。
 * 请求 schema 引用 contracts/notifications.ts（事件词表单一真相在 notifications 包）;
 * 响应 wire 形状按 MaskedChannel（config.secret 已掩码,密文不回显）。
 */
import * as z from 'zod';
import { notificationsContracts } from '../contracts/notifications';
import { idPathParam, okTrue, type OpenApiEndpoint } from './shared';

/** 通知渠道行（config.secret 已掩码:****+尾4;时间 ISO 字符串） */
const maskedChannelSchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string().describe('渠道类型（创建后不可改）'),
  config: z
    .record(z.string(), z.unknown())
    .describe('webhook:{url,secret(掩码)} / email:{recipients}'),
  events: z.array(z.string()).describe('订阅事件（词表在 notifications NOTIFY_EVENTS）'),
  status: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const notificationsEndpoints: readonly OpenApiEndpoint[] = [
  {
    method: 'get',
    path: '/v1/notifications',
    tag: 'notifications',
    summary: '通知渠道列表（secret 恒掩码）',
    response: { schema: z.array(maskedChannelSchema) },
    errors: [401],
  },
  {
    method: 'post',
    path: '/v1/notifications',
    tag: 'notifications',
    summary: '创建通知渠道（webhook 需 url+secret;email 需 recipients）',
    body: notificationsContracts.create,
    response: { schema: maskedChannelSchema, status: 201 },
    errors: [400, 401, 409],
  },
  {
    method: 'patch',
    path: '/v1/notifications/:id',
    tag: 'notifications',
    summary: '更新通知渠道（type 不可改）',
    params: [idPathParam('渠道 id')],
    body: notificationsContracts.update,
    response: { schema: maskedChannelSchema },
    errors: [400, 401, 404],
  },
  {
    method: 'delete',
    path: '/v1/notifications/:id',
    tag: 'notifications',
    summary: '删除通知渠道',
    params: [idPathParam('渠道 id')],
    response: { schema: okTrue },
    errors: [401, 404],
  },
  {
    method: 'post',
    path: '/v1/notifications/:id/test',
    tag: 'notifications',
    summary: '测试入箱（实际投递由 worker dispatchOnce 消费）',
    params: [idPathParam('渠道 id')],
    response: { schema: okTrue },
    errors: [401, 404],
  },
];
