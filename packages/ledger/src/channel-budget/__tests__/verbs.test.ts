/** channel-budget 域规格（S4）：进货/调账幂等、敞口预留/换渠/补足、结算扣减与熔断。
 *  行为对齐旧实现（admin channel-funds + billing/channel-reserve + channel-closeout）。 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  admins,
  billingRequests,
  channelRecharges,
  channels,
  providers,
  users,
} from '@ai-gateway/db/schema';
import { toDecimal } from '@ai-gateway/wallet/metering';
import { ChannelBudgetError } from '../../platform/errors.js';
import {
  createChannelBudget,
  deductBudget,
  releaseExposure,
  reserveExposure,
} from '../index.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const domain = createChannelBudget({ db });

const PREFIX = 'chbw';
const createdProviders: number[] = [];
const createdChannels: number[] = [];
const createdRequests: string[] = [];
const createdUsers: number[] = [];
const createdAdmins: number[] = [];
let adminId = 1;
let userId = 1;

beforeAll(async () => {
  await db.query.users.findFirst({ columns: { id: true } });
  const [admin] = await db
    .insert(admins)
    .values({ email: `${PREFIX}-${randomUUID().slice(0, 8)}@test.local`, passwordHash: 'x' })
    .returning({ id: admins.id });
  createdAdmins.push(admin!.id);
  adminId = admin!.id;
  const [user] = await db
    .insert(users)
    .values({ issuer: PREFIX, subject: `${PREFIX}-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  userId = user!.id;
});
afterAll(async () => {
  if (createdRequests.length > 0) {
    await db.delete(billingRequests).where(inArray(billingRequests.requestId, createdRequests));
  }
  if (createdChannels.length > 0) {
    await db.delete(channelRecharges).where(inArray(channelRecharges.channelId, createdChannels));
    await db.delete(channels).where(inArray(channels.id, createdChannels));
  }
  if (createdProviders.length > 0) {
    await db.delete(providers).where(inArray(providers.id, createdProviders));
  }
  if (createdAdmins.length > 0) {
    await db.delete(admins).where(inArray(admins.id, createdAdmins));
  }
  if (createdUsers.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUsers));
  }
  await db.$client.end().catch(() => {});
});

async function createChannel(overrides: Partial<typeof channels.$inferInsert> = {}): Promise<number> {
  const [provider] = await db
    .insert(providers)
    .values({ name: `${PREFIX}-${randomUUID().slice(0, 8)}`, baseUrl: 'https://example.test' })
    .returning({ id: providers.id });
  createdProviders.push(provider!.id);
  const [channel] = await db
    .insert(channels)
    .values({
      providerId: provider!.id,
      name: `${PREFIX}-${randomUUID().slice(0, 8)}`,
      apiKeyEnc: 'test',
      upstreamBudget: '100',
      ...overrides,
    } as typeof channels.$inferInsert)
    .returning({ id: channels.id });
  createdChannels.push(channel!.id);
  return channel!.id;
}

async function budgetOf(channelId: number): Promise<{ budget: string; reserved: string; status: number }> {
  const [row] = await db
    .select({
      budget: channels.upstreamBudget,
      reserved: channels.upstreamReserved,
      status: channels.status,
    })
    .from(channels)
    .where(eq(channels.id, channelId));
  return row!;
}

/** 最小 billing_requests 行（敞口预留的认领目标）；requestId 为 uuid 列 */
async function createRequest(status = 'authorized'): Promise<string> {
  const requestId = randomUUID();
  await db.insert(billingRequests).values({
    requestId,
    userId,
    reservedAmount: '0',
    status,
    quote: {},
    authorizationFingerprint: 'x',
  });
  createdRequests.push(requestId);
  return requestId;
}

const op = (key: string): string => `${PREFIX}-${key}-${randomUUID().slice(0, 8)}`;

describe('recharge / adjust（管理端运营资金）', () => {
  it('入货：预算累加 + 流水落库 + 熔断复活 + 同键重放', async () => {
    const channelId = await createChannel({ upstreamBudget: '100', status: 3 });
    const operationId = op('rc');
    const first = await domain.recharge({ operationId, channelId, amount: '50', adminId });
    expect(first.replayed).toBe(false);
    expect(toDecimal(first.balanceAfter).toNumber()).toBe(150);
    expect((await budgetOf(channelId)).status).toBe(0); // 熔断复活

    const replay = await domain.recharge({ operationId, channelId, amount: '50', adminId });
    expect(replay.replayed).toBe(true);
    expect(replay.rechargeId).toBe(first.rechargeId);
    expect(toDecimal((await budgetOf(channelId)).budget).toNumber()).toBe(150);

    const missing = await domain
      .recharge({ operationId: op('rc404'), channelId: 99_999_999, amount: '1', adminId })
      .catch((error) => error as ChannelBudgetError);
    expect(missing).toBeInstanceOf(ChannelBudgetError);
    expect((missing as ChannelBudgetError).code).toBe('channel_not_found');
  });

  it('调账：正负皆可、不得调负、同键重放', async () => {
    const channelId = await createChannel({ upstreamBudget: '100' });
    const up = await domain.adjust({ operationId: op('adj1'), channelId, amount: '30', adminId });
    expect(toDecimal(up.balanceAfter).toNumber()).toBe(130);
    const down = await domain.adjust({ operationId: op('adj2'), channelId, amount: '-20', adminId });
    expect(toDecimal(down.balanceAfter).toNumber()).toBe(110);

    const negative = await domain
      .adjust({ operationId: op('adj3'), channelId, amount: '-999', adminId })
      .catch((error) => error as ChannelBudgetError);
    expect((negative as ChannelBudgetError).code).toBe('insufficient_budget');
    expect(toDecimal((await budgetOf(channelId)).budget).toNumber()).toBe(110);
  });
});

describe('reserveExposure：敞口硬闸与换渠原子替换', () => {
  it('预算内预留成功；预算外拒绝且零变更', async () => {
    const channelId = await createChannel({ upstreamBudget: '100' });
    const requestId = await createRequest();
    const ok = await reserveExposure(db, () => new Date(), { requestId, channelId, amount: '30' });
    expect(ok.allowed).toBe(true);
    expect(toDecimal((await budgetOf(channelId)).reserved).toNumber()).toBe(30);

    const denied = await reserveExposure(db, () => new Date(), {
      requestId: await createRequest(),
      channelId,
      amount: '71',
    });
    expect(denied.allowed).toBe(false);
    expect(toDecimal((await budgetOf(channelId)).reserved).toNumber()).toBe(30);
  });

  it('同渠道补足（F3）：fallback 预估更高按差额补敞口', async () => {
    const channelId = await createChannel({ upstreamBudget: '100' });
    const requestId = await createRequest();
    await reserveExposure(db, () => new Date(), { requestId, channelId, amount: '5' });
    const topped = await reserveExposure(db, () => new Date(), {
      requestId,
      channelId,
      amount: '8',
    });
    expect(topped.allowed).toBe(true);
    expect(topped.switched).toBe(false);
    expect(toDecimal((await budgetOf(channelId)).reserved).toNumber()).toBe(8);
  });

  it('换渠道：新渠道预留 + 旧渠道原子释放 + 账单投影改绑', async () => {
    const firstChannel = await createChannel({ upstreamBudget: '100' });
    const secondChannel = await createChannel({ upstreamBudget: '100' });
    const requestId = await createRequest();
    await reserveExposure(db, () => new Date(), { requestId, channelId: firstChannel, amount: '20' });

    const switched = await reserveExposure(db, () => new Date(), {
      requestId,
      channelId: secondChannel,
      amount: '30',
    });
    expect(switched.allowed).toBe(true);
    expect(switched.switched).toBe(true);
    expect(toDecimal((await budgetOf(firstChannel)).reserved).toNumber()).toBe(0);
    expect(toDecimal((await budgetOf(secondChannel)).reserved).toNumber()).toBe(30);
    const [row] = await db
      .select({ channelId: billingRequests.channelId, reserved: billingRequests.channelReservedAmount })
      .from(billingRequests)
      .where(eq(billingRequests.requestId, requestId));
    expect(row?.channelId).toBe(secondChannel);
    expect(toDecimal(row?.reserved ?? '0').toNumber()).toBe(30);
  });
});

describe('closeout：释放敞口 + 实际成本扣减熔断', () => {
  it('结算前释放敞口；结算后按真实成本扣预算并按阈值熔断', async () => {
    const channelId = await createChannel({ upstreamBudget: '100', upstreamThreshold: '60' });
    const requestId = await createRequest();
    const ok = await reserveExposure(db, () => new Date(), {
      requestId,
      channelId,
      amount: '20',
    });
    expect(ok.allowed).toBe(true);

    let broke = false;
    await db.transaction(async (tx) => {
      await releaseExposure(tx, { channelId, channelReservedAmount: '20' });
      broke = await deductBudget(tx, channelId, '45');
    });
    // 100 − 45 = 55 ≤ 阈值 60 → 熔断
    expect(broke).toBe(true);
    expect((await budgetOf(channelId)).status).toBe(3);
    expect(toDecimal((await budgetOf(channelId)).budget).toNumber()).toBe(55);
    expect(toDecimal((await budgetOf(channelId)).reserved).toNumber()).toBe(0);
  });

  it('释放敞口守卫：预占不足 → invariant 红灯', async () => {
    const channelId = await createChannel({ upstreamBudget: '100' });
    const rejection = await db
      .transaction(async (tx) => releaseExposure(tx, { channelId, channelReservedAmount: '1' }))
      .catch((error) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error & { code?: string }).code).toBe('channel_reservation_invariant');
  });
});
