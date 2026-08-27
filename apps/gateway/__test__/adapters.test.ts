/**
 * 装配桥契约（纯逻辑面；SQL 语义归各包 real 测试）：
 * catalog-port：费率卡三层系数解析 / 停用卡 403 / 单位上界（body 推导 + 保底只抬不降）/
 *   变体单价（hold==settle）/ fallback 链透传 / 渠道候选映射（含可选限流列）；
 * billing-port：authorize 报价组装（inputUpperBound 逐候选盖章 / explicitlyFree）/
 *   signal 蛇形→点分词表 / reserveChannel 官方价口径 amount；
 * settle-wake：fire-and-forget + 失败不抛。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tillgate/errors';
import { controlPlaneErrors } from '@tillgate/control-plane';
import { createGatewayCatalog, type CatalogStores } from '../src/adapters/catalog-port';
import { defined } from './defined';
import { createGatewayBilling } from '../src/adapters/billing-port';
import { createSettleWakeProducer } from '../src/adapters/settle-wake';
import type {
  ActiveMappingRow,
  RouteCandidateRow,
  UserRateCardContext,
} from '@tillgate/control-plane';
import type { QuoteCandidate } from '@tillgate/inference';

// ---- catalog-port 替身 ----
const mapping = (
  over: Partial<ActiveMappingRow> & { id: number; externalName: string },
): ActiveMappingRow => ({
  realModel: `real-${over.externalName}`,
  contextLength: null,
  inputPrice: '1',
  outputPrice: '2',
  cacheInputPrice: '1',
  cacheWritePrice: '0',
  pricingUnit: 'token',
  unitPrice: '0',
  pricingGroup: null,
  rpmLimit: null,
  tpmLimit: null,
  isFree: false,
  fallbackModels: null,
  billingPolicy: null,
  billingConfig: {},
  ...over,
});

function stores(
  over: {
    mappings?: ActiveMappingRow[];
    card?: UserRateCardContext | null;
    channels?: RouteCandidateRow[];
    timezone?: string;
  } = {},
): CatalogStores {
  const mappings = over.mappings ?? [
    mapping({ id: 1, externalName: 'm-main', fallbackModels: ['m-fb'] }),
  ];
  return {
    models: {
      findActiveByExternalName: async (name) =>
        mappings.find((m) => m.externalName === name) ?? null,
    },
    channels: {
      findRouteCandidates: async (realModel) =>
        (over.channels ?? []).filter(() => realModel.length > 0),
    },
    rateCards: { findActiveCardByUser: async () => over.card ?? null },
    billingTimezone: { read: async () => over.timezone ?? 'Asia/Shanghai' },
  };
}

const noCard = { userId: 1, body: {}, now: new Date('2026-08-24T12:00:00+08:00') };

const card = (coefficients: UserRateCardContext['coefficients']): UserRateCardContext => ({
  cardId: 9,
  cardName: 'vip',
  status: 0,
  coefficients,
});

describe('catalog-port：模型级限流列透传', () => {
  it('ActiveMappingRow 的 rpm/tpm 限额进快照（admitModel 钩子消费面）', async () => {
    const catalog = createGatewayCatalog(
      stores({
        mappings: [mapping({ id: 1, externalName: 'm-main', rpmLimit: 60, tpmLimit: 90_000 })],
      }),
    );
    expect(defined(await catalog.findMapping('m-main', noCard))).toMatchObject({
      rpmLimit: 60,
      tpmLimit: 90_000,
    });
  });
});

describe('catalog-port：系数解析（C-G2）', () => {
  it('无卡恒系数 1；global 行兜底；model 行优先；group 行按 pricingGroup 命中', async () => {
    const catalog = createGatewayCatalog(
      stores({
        card: card([{ scope: 'global', modelMappingId: null, groupKey: null, coefficient: '0.8' }]),
      }),
    );
    expect(defined(await catalog.findMapping('m-main', noCard)).coefficient).toBe('0.8');

    const withModel = createGatewayCatalog(
      stores({
        card: card([
          { scope: 'global', modelMappingId: null, groupKey: null, coefficient: '0.8' },
          { scope: 'model', modelMappingId: 1, groupKey: null, coefficient: '0.5' },
        ]),
      }),
    );
    expect(defined(await withModel.findMapping('m-main', noCard)).coefficient).toBe('0.5'); // model > global

    const withGroup = createGatewayCatalog(
      stores({
        mappings: [mapping({ id: 2, externalName: 'm-g', pricingGroup: 'anthropic' })],
        card: card([
          { scope: 'group', modelMappingId: null, groupKey: 'anthropic', coefficient: '0.9' },
        ]),
      }),
    );
    expect(defined(await withGroup.findMapping('m-g', noCard)).coefficient).toBe('0.9'); // group 命中

    expect(
      defined(await createGatewayCatalog(stores({ card: null })).findMapping('m-main', noCard))
        .coefficient,
    ).toBe('1');
  });

  it('停用卡拒绝新请求（control_plane.rate_card_disabled → 403）', async () => {
    const catalog = createGatewayCatalog(
      stores({
        card: {
          cardId: 9,
          cardName: 'vip',
          status: 1,
          coefficients: [
            { scope: 'global', modelMappingId: null, groupKey: null, coefficient: '0.8' },
          ],
        },
      }),
    );
    const err = await catalog.findMapping('m-main', noCard).catch((error: Error) => error);
    expect(isBusinessError(err)).toBe(true);
    expect((err as { code?: string }).code).toBe(controlPlaneErrors.code('rate_card_disabled'));
  });

  it('单位上界：按请求体推导 + 预扣保底只抬不降；变体单价 hold==settle', async () => {
    const catalog = createGatewayCatalog(
      stores({
        mappings: [
          mapping({
            id: 3,
            externalName: 'img-x',
            pricingUnit: 'image',
            unitPrice: '0.02',
            billingConfig: {
              strategy: 'variant',
              params: { selector: 'size', prices: { '512x512': '0.01', '1024x1024': '0.04' } },
            },
          }),
        ],
      }),
    );
    const snap = defined(
      await catalog.findMapping('img-x', {
        userId: 1,
        body: { n: 2, size: '1024x1024' },
        now: new Date('2026-08-24T12:00:00+08:00'),
      }),
      'snap',
    );
    expect(snap.pricingUnit).toBe('image');
    expect(snap.unitPrice).toBe('0.04'); // 变体按 body.size 选定
    expect(snap.unitUpperBound).toBe(2); // n=2 张

    const floored = createGatewayCatalog(
      stores({
        mappings: [
          mapping({
            id: 4,
            externalName: 'video-x',
            pricingUnit: 'second',
            unitPrice: '0.5',
            billingConfig: { reservation: { strategy: 'floor', params: { units: 5 } } },
          }),
        ],
      }),
    );
    const snap2 = defined(
      await floored.findMapping('video-x', {
        userId: 1,
        body: { duration: 3 },
        now: new Date('2026-08-24T12:00:00+08:00'),
      }),
      'snap2',
    );
    expect(snap2.unitUpperBound).toBe(5); // 保底 5 秒只抬不降
  });

  it('快照杂项：fallback 链 / cacheWrite 零价归 null / 指纹 / 渠道候选可选限流列映射', async () => {
    const catalog = createGatewayCatalog(
      stores({
        mappings: [
          mapping({
            id: 1,
            externalName: 'm-main',
            fallbackModels: ['m-fb'],
            billingPolicy: { modal: true },
          }),
        ],
        channels: [
          {
            channelId: 7,
            channelName: 'c',
            apiKeyEnc: 'enc',
            baseUrlOverride: 'https://ov.example',
            providerName: 'p',
            providerBaseUrl: 'https://p.example',
            providerProtocol: 'openai-compatible',
            providerVendor: 'openai',
            priority: 3,
            weight: 2,
            rpmLimit: 60,
            tpmLimit: 1000,
            upstreamBudget: '99',
          },
        ],
      }),
    );
    const snap = defined(await catalog.findMapping('m-main', noCard), 'snap');
    expect(snap.fallbackModels).toEqual(['m-fb']);
    expect(snap.cacheWritePrice).toBeNull();
    expect(snap.billingPolicyFingerprint).toBe(
      createHash('sha256')
        .update(JSON.stringify({ modal: true }))
        .digest('hex'),
    );
    const [channel] = await catalog.resolveChannels('real-m-main');
    expect(channel).toMatchObject({
      channelId: 7,
      protocol: 'openai-compatible',
      baseUrl: 'https://ov.example', // override 优先
      rpmLimit: 60,
      upstreamBudget: '99',
    });
  });

  it('schedule 时段价：准入时刻命中 → 字段级覆盖 + 审计标签进快照；系数照常叠加', async () => {
    const catalog = createGatewayCatalog(
      stores({
        mappings: [
          mapping({
            id: 1,
            externalName: 'm-main',
            billingConfig: {
              strategy: 'schedule',
              params: {
                windows: [
                  {
                    label: '谷时段',
                    start: '18:00',
                    end: '07:00',
                    inputPrice: '0.5',
                    outputPrice: '1',
                  },
                ],
              },
            },
          }),
        ],
        card: card([{ scope: 'global', modelMappingId: null, groupKey: null, coefficient: '0.8' }]),
      }),
    );
    // 上海 23:00（跨午夜窗口内）→ 覆盖生效；未覆盖的 cache 价回落列基价
    const night = defined(
      await catalog.findMapping('m-main', {
        userId: 1,
        body: {},
        now: new Date('2026-08-24T15:00:00Z'),
      }),
      'night',
    );
    expect(night.inputPrice).toBe('0.5');
    expect(night.outputPrice).toBe('1');
    expect(night.cacheInputPrice).toBe('1'); // 窗口未覆盖 → 基价列
    expect(night.coefficient).toBe('0.8'); // 系数轴正交
    expect(night.pricingWindow).toBe('谷时段');

    // 上海 12:00（未命中）→ 全轴基价 + 无标签
    const day = defined(await catalog.findMapping('m-main', noCard), 'day');
    expect(day.inputPrice).toBe('1');
    expect(day.outputPrice).toBe('2');
    expect(day.pricingWindow).toBeUndefined();
  });

  it('schedule 单位计价轴：窗口 unitPrice 覆盖进快照（计量上界照常 body 推导）', async () => {
    const catalog = createGatewayCatalog(
      stores({
        mappings: [
          mapping({
            id: 5,
            externalName: 'img-s',
            pricingUnit: 'image',
            unitPrice: '0.02',
            billingConfig: {
              strategy: 'schedule',
              params: {
                windows: [{ label: '夜图', start: '00:00', end: '07:00', unitPrice: '0.008' }],
              },
            },
          }),
        ],
      }),
    );
    const snap = defined(
      await catalog.findMapping('img-s', {
        userId: 1,
        body: { n: 2 },
        now: new Date('2026-08-24T03:00:00+08:00'),
      }),
      'snap',
    );
    expect(snap.unitPrice).toBe('0.008');
    expect(snap.unitUpperBound).toBe(2);
    expect(snap.pricingWindow).toBe('夜图');
  });

  it('时区来自装配注入的读取器（同窗口按计费时区墙钟判定，不随宿主机本地时）', async () => {
    const scheduled = () => [
      mapping({
        id: 1,
        externalName: 'm-main',
        billingConfig: {
          strategy: 'schedule',
          params: { windows: [{ start: '18:00', end: '07:00', inputPrice: '0.5' }] },
        },
      }),
    ];
    // 同一时刻两种计费时区：UTC 12:00 不在 18:00-07:00 窗口（基价）；
    // 上海墙钟 20:00 在窗口内（覆盖价）——时区由装配注入，与宿主机本地时无关
    const utc = createGatewayCatalog(stores({ mappings: scheduled(), timezone: 'UTC' }));
    const sh = createGatewayCatalog(stores({ mappings: scheduled(), timezone: 'Asia/Shanghai' }));
    const now = new Date('2026-08-24T12:00:00Z');
    expect(defined(await utc.findMapping('m-main', { userId: 1, body: {}, now })).inputPrice).toBe(
      '1',
    );
    expect(defined(await sh.findMapping('m-main', { userId: 1, body: {}, now })).inputPrice).toBe(
      '0.5',
    );
  });
});

// ---- billing-port ----
const candidate = (over: Partial<QuoteCandidate> = {}): QuoteCandidate => ({
  mappingId: 1,
  externalModel: 'm',
  realModel: 'real-m',
  inputPrice: '1',
  cacheInputPrice: '1',
  cacheWritePrice: null,
  outputPrice: '2',
  unitPrice: null,
  pricingUnit: 'token',
  unitUpperBound: 0,
  coefficient: '0.8',
  billingPolicyFingerprint: null,
  ...over,
});

function spyApi() {
  const calls: { authorize: unknown[]; signals: unknown[]; reserves: unknown[] } = {
    authorize: [],
    signals: [],
    reserves: [],
  };
  return {
    calls,
    api: {
      authorize: async (input: unknown) => {
        calls.authorize.push(input);
      },
      signal: async (event: unknown) => {
        calls.signals.push(event);
      },
      reserveChannel: async (input: { amount: string }) => {
        calls.reserves.push(input);
        return { allowed: true, remaining: '0', switched: false };
      },
    },
  };
}

describe('billing-port（C-G3）', () => {
  it('authorize：admission 前置 → 报价组装（上限逐候选盖章 + 预留门槛/policy 透传）', async () => {
    const { api, calls } = spyApi();
    const admissions: number[] = [];
    const port = createGatewayBilling(api as never, {
      reservationLimit: '1000',
      reservationPolicy: { mode: 'fixed', amount: '0.5' },
      assertCapacity: async () => {
        admissions.push(1);
      },
    });
    await port.authorize({
      requestId: 'r',
      userId: 1,
      apiKeyId: 2,
      appId: null,
      stream: false,
      candidates: [candidate({ mappingId: 1 }), candidate({ mappingId: 2, externalModel: 'm' })],
      inputTokenUpperBound: 999,
      maxOutputTokens: 4_096,
      authorizationTtlMs: 3_000,
    });
    expect(admissions).toHaveLength(1);
    const input = calls.authorize[0] as {
      quote: {
        candidates: Array<{ inputTokenUpperBound: number }>;
        maxOutputTokens: number;
        explicitlyFree?: boolean;
      };
      reservationLimit: string;
      reservationPolicy: { mode: string; amount?: string };
    };
    expect(input.quote.candidates.map((c) => c.inputTokenUpperBound)).toEqual([999, 999]);
    expect(input.quote.maxOutputTokens).toBe(4_096);
    expect(input.quote.explicitlyFree).toBeUndefined();
    expect(input.reservationLimit).toBe('1000');
    expect(input.reservationPolicy).toEqual({ mode: 'fixed', amount: '0.5' });
  });

  it('authorize：候选链全免费（isFree 标记或全零价）→ explicitlyFree', async () => {
    const { api, calls } = spyApi();
    const port = createGatewayBilling(api as never, {
      reservationLimit: '1000',
      reservationPolicy: { mode: 'full' },
    });
    await port.authorize({
      requestId: 'r',
      userId: 1,
      apiKeyId: null,
      appId: null,
      stream: false,
      candidates: [
        candidate({ isFree: true, inputPrice: '0', cacheInputPrice: '0', outputPrice: '0' }),
      ],
      inputTokenUpperBound: 0,
      maxOutputTokens: 0,
      authorizationTtlMs: 1,
    });
    expect(
      (calls.authorize[0] as { quote: { explicitlyFree?: boolean } }).quote.explicitlyFree,
    ).toBe(true);
  });

  it('signal：蛇形→点分词表四事件直译', async () => {
    const { api, calls } = spyApi();
    const port = createGatewayBilling(api as never, {
      reservationLimit: '1',
      reservationPolicy: { mode: 'full' },
    });
    await port.signal({ type: 'upstream_started', requestId: 'r', leaseOwner: 'o', leaseMs: 100 });
    await port.signal({ type: 'lease_renewed', requestId: 'r', leaseOwner: 'o', leaseMs: 100 });
    await port.signal({ type: 'request_failed', requestId: 'r', reason: 'boom' });
    await port.signal({
      type: 'request_succeeded',
      requestId: 'r',
      receipt: {
        requestId: 'r',
        usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, estimated: false },
      } as never,
    });
    expect(calls.signals.map((e) => (e as { type: string }).type)).toEqual([
      'upstream.started',
      'lease.renewed',
      'request.failed',
      'request.succeeded',
    ]);
    const receiptEvent = calls.signals[3] as { receipt: { usage: { inputTokens: number } } };
    expect(receiptEvent.receipt.usage.inputTokens).toBe(1);
  });

  it('reserveChannel：官方价口径（coefficient=1）amount 自算 + allowed 收窄', async () => {
    const { api, calls } = spyApi();
    const port = createGatewayBilling(api as never, {
      reservationLimit: '1',
      reservationPolicy: { mode: 'full' },
    });
    const result = await port.reserveChannel({
      requestId: 'r',
      channelId: 7,
      candidate: candidate({
        inputPrice: '3.5',
        cacheInputPrice: '1',
        cacheWritePrice: '7',
        outputPrice: '2',
      }),
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 1_000_000,
    });
    expect(result).toEqual({ allowed: true });
    const input = calls.reserves[0] as { channelId: number; amount: string };
    expect(input.channelId).toBe(7);
    // 贵价口径：max(3.5,1,7)=7 输入 + 2 输出 = 9 元（官方价，系数不参与）
    expect(Number(input.amount)).toBeCloseTo(9, 6);
  });
});

// ---- settle-wake ----
describe('settle-wake（C-G8）', () => {
  it('wake fire-and-forget：经 db.execute 发 pg_notify；失败仅记日志不抛；close 无资源', async () => {
    const executed: Array<{ sql: string; dump: string }> = [];
    const db = {
      execute: async (q: unknown) => {
        // drizzle SQL 模板对象：queryChunks 拼语句文本（参数 chunk 带 value 字段）
        // 语句文本 + 参数整体序列化（chunk 形状随 drizzle 版本演进，不逐一拆解）
        const chunk = q as { queryChunks?: unknown[] };
        const dump = JSON.stringify(chunk.queryChunks ?? []);
        const text = (chunk.queryChunks ?? [])
          .map((c) =>
            typeof c === 'string' ? c : ((c as { value?: unknown[] }).value?.join(' ') ?? ''),
          )
          .join('');
        executed.push({ sql: text, dump });
        if (executed.length === 2) throw new Error('notify dropped');
      },
    } as never;
    const warns: string[] = [];
    const wake = createSettleWakeProducer(db, { warn: (_o, msg) => warns.push(msg) });
    wake.wake('r-1');
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    const first = defined(executed[0], 'executed[0]');
    expect(first.sql).toContain('pg_notify');
    expect(first.dump).toContain('settle-wake');
    expect(first.dump).toContain('r-1');
    wake.wake('r-2'); // 失败路径
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    expect(warns.some((m) => m.includes('settle wake notify failed'))).toBe(true);
    await expect(wake.close()).resolves.toBeUndefined();
  });
});

function fakeBillingTimezoneDb(results: Array<Record<string, unknown> | null>) {
  let reads = 0;
  return {
    reads: () => reads,
    query: {
      systemConfigs: {
        findFirst: async () => {
          reads += 1;
          return results.length > 1 ? results.shift() : results[0];
        },
      },
    },
  };
}

describe('billing-timezone 读取器（TTL 缓存 + 单飞行 + 回落）', () => {
  it('KV 有值取值;缺省回落 fallback;TTL 内不重复查;过期后刷新', async () => {
    const { createBillingTimezoneReader } = await import('../src/adapters/billing-timezone.js');
    const db = fakeBillingTimezoneDb([{ value: { timezone: 'UTC' } }]);
    const read = createBillingTimezoneReader({
      db: db as never,
      ttlMs: 60_000,
      fallback: 'Asia/Shanghai',
    });
    expect(await read()).toBe('UTC');
    expect(await read()).toBe('UTC'); // TTL 内走缓存
    expect(db.reads()).toBe(1);

    const empty = fakeBillingTimezoneDb([null]);
    const readEmpty = createBillingTimezoneReader({
      db: empty as never,
      ttlMs: 1,
      fallback: 'Asia/Shanghai',
    });
    expect(await readEmpty()).toBe('Asia/Shanghai'); // 缺省回落

    // TTL 过期（ttlMs=1）→ 下一请求重查;非 string/空串形态也回落
    const shapey = fakeBillingTimezoneDb([{ value: { timezone: '' } }]);
    const readShapey = createBillingTimezoneReader({
      db: shapey as never,
      ttlMs: 1,
      fallback: 'UTC',
    });
    expect(await readShapey()).toBe('UTC');
    await new Promise((r) => {
      setTimeout(r, 3);
    });
    expect(await readShapey()).toBe('UTC');
    expect(shapey.reads()).toBe(2);
  });

  it('并发读合并单飞行（一次刷新一轮查询）', async () => {
    const { createBillingTimezoneReader } = await import('../src/adapters/billing-timezone.js');
    let queries = 0;
    const db = {
      query: {
        systemConfigs: {
          findFirst: () =>
            new Promise((resolve) => {
              queries += 1;
              setTimeout(() => resolve({ value: { timezone: 'UTC' } }), 5);
            }),
        },
      },
    };
    const read = createBillingTimezoneReader({ db: db as never, ttlMs: 60_000, fallback: 'x' });
    const [a, b] = await Promise.all([read(), read()]);
    expect(a).toBe('UTC');
    expect(b).toBe('UTC');
    expect(queries).toBe(1);
  });
});
