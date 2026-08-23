/**
 * 装配桥契约（C-G2/C-G3/C-G8 的纯逻辑面；SQL 语义归各包 real 测试）：
 * catalog-port：费率卡三层系数解析 / 停用卡 403 / 单位上界（body 推导 + 保底只抬不降）/
 *   变体单价（hold==settle）/ fallback 链透传 / 渠道候选映射（含可选限流列）；
 * billing-port：authorize 报价组装（inputUpperBound 逐候选盖章 / explicitlyFree）/
 *   signal 蛇形→点分词表 / reserveChannel 官方价口径 amount；
 * settle-wake：fire-and-forget + 失败不抛。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tokenlens/errors';
import { controlPlaneErrors } from '@tokenlens/control-plane';
import { createGatewayCatalog, type CatalogStores } from '../src/adapters/catalog-port';
import { createGatewayBilling } from '../src/adapters/billing-port';
import { createSettleWakeProducer } from '../src/adapters/settle-wake';
import type {
  ActiveMappingRow,
  RouteCandidateRow,
  UserRateCardContext,
} from '@tokenlens/control-plane';
import type { QuoteCandidate } from '@tokenlens/inference';

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
  };
}

const noCard = { userId: 1, body: {} };

const card = (coefficients: UserRateCardContext['coefficients']): UserRateCardContext => ({
  cardId: 9,
  cardName: 'vip',
  status: 0,
  coefficients,
});

describe('catalog-port：系数解析（C-G2）', () => {
  it('无卡恒系数 1；global 行兜底；model 行优先；group 行按 pricingGroup 命中', async () => {
    const catalog = createGatewayCatalog(
      stores({
        card: card([{ scope: 'global', modelMappingId: null, groupKey: null, coefficient: '0.8' }]),
      }),
    );
    expect((await catalog.findMapping('m-main', noCard))!.coefficient).toBe('0.8');

    const withModel = createGatewayCatalog(
      stores({
        card: card([
          { scope: 'global', modelMappingId: null, groupKey: null, coefficient: '0.8' },
          { scope: 'model', modelMappingId: 1, groupKey: null, coefficient: '0.5' },
        ]),
      }),
    );
    expect((await withModel.findMapping('m-main', noCard))!.coefficient).toBe('0.5'); // model > global

    const withGroup = createGatewayCatalog(
      stores({
        mappings: [mapping({ id: 2, externalName: 'm-g', pricingGroup: 'anthropic' })],
        card: card([
          { scope: 'group', modelMappingId: null, groupKey: 'anthropic', coefficient: '0.9' },
        ]),
      }),
    );
    expect((await withGroup.findMapping('m-g', noCard))!.coefficient).toBe('0.9'); // group 命中

    expect(
      (await createGatewayCatalog(stores({ card: null })).findMapping('m-main', noCard))!
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
    const err = await catalog.findMapping('m-main', noCard).catch((e: Error) => e);
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
    const snap = await catalog.findMapping('img-x', {
      userId: 1,
      body: { n: 2, size: '1024x1024' },
    });
    expect(snap!.pricingUnit).toBe('image');
    expect(snap!.unitPrice).toBe('0.04'); // 变体按 body.size 选定
    expect(snap!.unitUpperBound).toBe(2); // n=2 张

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
    const snap2 = await floored.findMapping('video-x', { userId: 1, body: { duration: 3 } });
    expect(snap2!.unitUpperBound).toBe(5); // 保底 5 秒只抬不降
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
    const snap = await catalog.findMapping('m-main', noCard);
    expect(snap!.fallbackModels).toEqual(['m-fb']);
    expect(snap!.cacheWritePrice).toBeNull();
    expect(snap!.billingPolicyFingerprint).toBe(
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
    await new Promise((r) => setTimeout(r, 10));
    expect(executed[0]!.sql).toContain('pg_notify');
    expect(executed[0]!.dump).toContain('settle-wake');
    expect(executed[0]!.dump).toContain('r-1');
    wake.wake('r-2'); // 失败路径
    await new Promise((r) => setTimeout(r, 10));
    expect(warns.some((m) => m.includes('settle wake notify failed'))).toBe(true);
    await expect(wake.close()).resolves.toBeUndefined();
  });
});
