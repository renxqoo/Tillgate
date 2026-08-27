/**
 * 领域规格:词表封闭性、渠道形状校验矩阵、掩码、退避公式、
 * HMAC 签名/头/体构造、目标渠道筛选、邮件模板形状。
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NOTIFY_EVENTS, isNotifyEvent } from '../src/domain/events';
import {
  validateChannelShape,
  maskSecret,
  maskChannelConfig,
  encryptChannelConfig,
  narrowEvents,
  type NotificationChannel,
} from '../src/domain/channel';
import {
  backoffDelayMs,
  signWebhook,
  webhookBody,
  webhookHeaders,
  selectTargetChannels,
  succeededChannelIds,
} from '../src/domain/delivery';
import { renderAlertEmail } from '../src/templates/alert-email';
import { fakeCipher } from './memory';
import { defined } from './defined';

const channel = (over: Partial<NotificationChannel> = {}): NotificationChannel => ({
  id: 1,
  name: 'ch',
  type: 'webhook',
  config: {},
  events: ['billing_dead'],
  status: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

describe('事件词表(封闭)', () => {
  it('快照锁死五个事件(v1 词表原样)', () => {
    expect(NOTIFY_EVENTS).toEqual([
      'channel_disabled',
      'reconcile_discrepancy',
      'billing_dead',
      'balance_low',
      'context_overflow',
    ]);
  });

  it('isNotifyEvent:词表内真、词表外假(大小写敏感)', () => {
    expect(isNotifyEvent('billing_dead')).toBe(true);
    expect(isNotifyEvent('Billing_Dead')).toBe(false);
    expect(isNotifyEvent('concurrency_probe')).toBe(false);
    expect(isNotifyEvent('')).toBe(false);
  });

  it('narrowEvents 过滤非词表成员', () => {
    expect(narrowEvents(['billing_dead', 'nope', 'balance_low'])).toEqual([
      'billing_dead',
      'balance_low',
    ]);
  });
});

describe('渠道形状校验(B1 收口:config 形状独立 + type 在场跨校验)', () => {
  it.each([
    [
      'webhook 完整',
      {
        name: 'n',
        type: 'webhook',
        config: { url: 'https://x.test/h', secret: 's' },
        events: ['billing_dead'],
      },
      null,
    ],
    [
      'email 完整',
      { name: 'n', type: 'email', config: { recipients: ['a@b.test'] }, events: ['balance_low'] },
      null,
    ],
    ['仅 status(PATCH 部分更新)', { status: 1 }, null],
    [
      'email 缺 recipients',
      { name: 'n', type: 'email', config: {}, events: ['billing_dead'] },
      'config',
    ],
    [
      'webhook 缺 secret',
      { name: 'n', type: 'webhook', config: { url: 'https://x.test' }, events: ['billing_dead'] },
      'config',
    ],
    ['config 空对象(无 type 在场,refine 口径拒)', { config: {} }, 'config'],
    [
      'webhook 型配 recipients(跨校验拒)',
      {
        name: 'n',
        type: 'webhook',
        config: { recipients: ['a@b.test'] },
        events: ['billing_dead'],
      },
      'config',
    ],
    [
      '未知事件',
      { name: 'n', type: 'email', config: { recipients: ['a@b.test'] }, events: ['not_an_event'] },
      'event_word',
    ],
    [
      '空事件表',
      { name: 'n', type: 'email', config: { recipients: ['a@b.test'] }, events: [] },
      'events_empty',
    ],
    [
      '类型词表外',
      { name: 'n', type: 'sms', config: { recipients: ['a@b.test'] }, events: ['billing_dead'] },
      'type',
    ],
    [
      '名称超长',
      {
        name: 'x'.repeat(65),
        type: 'email',
        config: { recipients: ['a@b.test'] },
        events: ['billing_dead'],
      },
      'name',
    ],
    ['status 越界', { status: 2 }, 'status'],
    ['status 非整数', { status: 1.5 }, 'status'],
  ] as const)('%s → %s', (label, input, expected) => {
    expect(validateChannelShape(input as never)).toBe(expected);
  });

  it('config 无 type 在场时 url+secret 或 recipients 任一形态可过(zod refine 语义)', () => {
    expect(validateChannelShape({ config: { url: 'https://x.test', secret: 's' } })).toBeNull();
    expect(validateChannelShape({ config: { recipients: ['a@b.test'] } })).toBeNull();
  });
});

describe('密钥掩码与加密侧归一', () => {
  it('maskSecret:空全遮、余尾 4 位', () => {
    expect(maskSecret('')).toBe('****');
    expect(maskSecret('enc:v1:abcd1234')).toBe('****1234');
    expect(maskSecret('short')).toBe('****hort');
  });

  it('maskChannelConfig:无 secret 键原样、有则替换', () => {
    expect(maskChannelConfig({ url: 'https://x.test' })).toEqual({ url: 'https://x.test' });
    expect(maskChannelConfig({ url: 'https://x.test', secret: 'enc:v1:deadbeef' })).toEqual({
      url: 'https://x.test',
      secret: '****beef',
    });
  });

  it('encryptChannelConfig:secret 加密、空串/缺席原样(v1 语义)', () => {
    const cipher = fakeCipher();
    const encrypted = encryptChannelConfig({ url: 'https://x.test', secret: 'whsec' }, cipher);
    const secret = defined(encrypted, 'encrypted').secret as string;
    expect(secret).toMatch(/^enc:v1:fake:/);
    expect(cipher.decrypt(secret)).toBe('whsec');
    expect(encryptChannelConfig({ url: 'https://x.test', secret: '' }, cipher)).toEqual({
      url: 'https://x.test',
      secret: '',
    });
    expect(encryptChannelConfig({ url: 'https://x.test' }, cipher)).toEqual({
      url: 'https://x.test',
    });
    expect(encryptChannelConfig(undefined, cipher)).toBeUndefined();
  });

  it('客户端提交 enc: 前缀明文也被再加密(禁伪装内部密文)', () => {
    const cipher = fakeCipher();
    const encrypted = encryptChannelConfig({ secret: 'enc:v1:fake:c3Bvb2Y=' }, cipher);
    const secret = defined(encrypted, 'encrypted').secret as string;
    expect(secret).not.toBe('enc:v1:fake:c3Bvb2Y=');
    expect(cipher.decrypt(secret)).toBe('enc:v1:fake:c3Bvb2Y=');
  });
});

describe('退避公式(v1:base 15s/cap 300s)', () => {
  it.each([
    [0, 15_000],
    [1, 30_000],
    [2, 60_000],
    [4, 240_000],
    [5, 300_000],
    [10, 300_000],
  ] as const)('attempts=%i → %ims', (attempts, expected) => {
    expect(backoffDelayMs(attempts, { baseMs: 15_000, capMs: 300_000 })).toBe(expected);
  });
});

describe('webhook 签名 wire 契约', () => {
  it('body = {event,timestamp,payload};签名 = HMAC-SHA256(secret, ts 点接 body)', () => {
    const body = webhookBody('billing_dead', 1_700_000_000, { requestId: 'r1' });
    expect(JSON.parse(body)).toEqual({
      event: 'billing_dead',
      timestamp: 1_700_000_000,
      payload: { requestId: 'r1' },
    });
    const expected = createHmac('sha256', 'whsec-test')
      .update(`${1_700_000_000}.${body}`)
      .digest('hex');
    expect(signWebhook('whsec-test', 1_700_000_000, body)).toBe(expected);
  });

  it('头集合:五个头齐全,值口径正确', () => {
    const headers = webhookHeaders({
      deliveryId: '9:11',
      event: 'balance_low',
      timestamp: 123,
      signature: 'abc',
    });
    expect(headers).toEqual({
      'content-type': 'application/json',
      'x-notify-delivery': '9:11',
      'x-notify-event': 'balance_low',
      'x-notify-timestamp': '123',
      'x-notify-signature': 'abc',
    });
  });
});

describe('目标渠道筛选', () => {
  const channels = [
    channel({ id: 1, events: ['billing_dead'] }),
    channel({ id: 2, events: ['balance_low'] }),
    channel({ id: 3, events: ['billing_dead'], status: 1 }),
    channel({ id: 4, events: ['billing_dead'] }),
  ];
  it('命中订阅 + 活跃 + 未投递', () => {
    expect(
      selectTargetChannels(channels, { event: 'billing_dead', deliveredChannelIds: [4] }).map(
        (c) => c.id,
      ),
    ).toEqual([1]);
  });
  it('无订阅 → 空(调用方终态化)', () => {
    expect(
      selectTargetChannels(channels, { event: 'context_overflow', deliveredChannelIds: [] }),
    ).toEqual([]);
  });
  it('succeededChannelIds 与渠道同序对齐', () => {
    expect(succeededChannelIds(channels.slice(0, 2), [true, false])).toEqual([1]);
    expect(succeededChannelIds(channels.slice(0, 2), [false, true])).toEqual([2]);
  });
});

describe('告警邮件模板(v1 渲染形状,品牌注入)', () => {
  it('subject = [品牌] 告警:事件;text = 事件 + pretty JSON', () => {
    const mail = renderAlertEmail('balance_low', { userId: 7, balance: '0.5' }, 'AI Gateway');
    expect(mail.subject).toBe('[AI Gateway] 告警：balance_low');
    expect(mail.text).toBe(
      `balance_low\n${JSON.stringify({ userId: 7, balance: '0.5' }, null, 2)}`,
    );
  });
});
