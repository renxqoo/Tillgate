/**
 * 用量读侧集成套件（真 PG）：明细（billedBy 拆分 + keyName 来源）/ 按模型聚合 /
 * 实时速率 / 用户隔离（他人用量不可见）。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { usageLogs, apiKeys } from '@ai-gateway/db';
import { systemContext } from '@ai-gateway/service';
import { createUsageService } from '../services/usage.service.js';
import { db, expectAmountEq, newUser } from './helpers.js';

const ctx = systemContext('cav2-usage');
const usage = createUsageService({ db });

async function seedUsage(input: {
  userId: number;
  apiKeyId?: number;
  model: string;
  amount: string;
  planAmount?: string;
  paygAmount?: string;
  billedBy: 'plan' | 'payg';
  inputTokens?: number;
  outputTokens?: number;
  createdAt?: Date;
}): Promise<void> {
  await db.insert(usageLogs).values({
    requestId: randomUUID(),
    userId: input.userId,
    apiKeyId: input.apiKeyId ?? null,
    credentialType: input.apiKeyId != null ? 'key' : 'jwt',
    externalModel: input.model,
    realModel: `${input.model}-real`,
    inputTokens: input.inputTokens ?? 100,
    cachedInputTokens: 0,
    outputTokens: input.outputTokens ?? 50,
    inputPrice: '1',
    outputPrice: '2',
    cacheInputPrice: '0.5',
    unitPrice: '0',
    coefficient: '1.000',
    amount: input.amount,
    calculatedAmount: input.amount,
    upstreamCost: '0',
    planAmount: input.planAmount ?? '0',
    paygAmount: input.paygAmount ?? '0',
    billedBy: input.billedBy,
    durationMs: 1234,
    status: 0,
    stream: false,
    createdAt: input.createdAt ?? new Date(),
  });
}

describe('用量明细（GET /v1/usage 语义）', () => {
  it('billedBy 拆分（plan 行 / payg 行）+ keyName 来源展示', async () => {
    const account = await newUser();
    const [key] = await db
      .insert(apiKeys)
      .values({
        keyHash: randomUUID().replace(/-/g, ''),
        keyPreview: 'ag_****test',
        userId: account.id,
        name: 'my-prod-key',
      })
      .returning({ id: apiKeys.id });
    await seedUsage({
      userId: account.id,
      apiKeyId: key!.id,
      model: 'rx-m3',
      amount: '3',
      planAmount: '3',
      billedBy: 'plan',
    });
    await seedUsage({
      userId: account.id,
      model: 'gpt-x',
      amount: '1.5',
      paygAmount: '1.5',
      billedBy: 'payg',
    });

    const result = await usage.list(ctx, account.id, { page: 1, limit: 20 });
    expect(result.total).toBe(2);
    const planRow = result.rows.find((r) => r.billedBy === 'plan')!;
    const paygRow = result.rows.find((r) => r.billedBy === 'payg')!;
    expect(planRow.keyName).toBe('my-prod-key');
    expectAmountEq(planRow.planAmount, '3');
    expectAmountEq(paygRow.paygAmount, '1.5');
    expectAmountEq(paygRow.planAmount, '0');
  });

  it('用户隔离：他人用量零可见', async () => {
    const a = await newUser();
    const b = await newUser();
    await seedUsage({ userId: a.id, model: 'rx-m3', amount: '1', billedBy: 'payg', paygAmount: '1' });
    const bResult = await usage.list(ctx, b.id, { page: 1, limit: 20 });
    expect(bResult.total).toBe(0);
    const bModels = await usage.byModel(ctx, b.id, {});
    expect(bModels.length).toBe(0);
  });
});

describe('按模型聚合（GET /v1/usage/by-model 语义）', () => {
  it('按 externalModel 聚合，金额字符串全精度', async () => {
    const account = await newUser();
    await seedUsage({ userId: account.id, model: 'rx-m3', amount: '1.25', billedBy: 'payg', paygAmount: '1.25' });
    await seedUsage({ userId: account.id, model: 'rx-m3', amount: '2.5', billedBy: 'payg', paygAmount: '2.5' });
    await seedUsage({ userId: account.id, model: 'vid-pro', amount: '4', billedBy: 'payg', paygAmount: '4' });

    const rows = await usage.byModel(ctx, account.id, {});
    expect(rows.length).toBe(2);
    const rx = rows.find((r) => r.model === 'rx-m3')!;
    expect(rx.requests).toBe(2);
    expect(rx.inputTokens).toBe(200);
    expectAmountEq(rx.cost, '3.75');
    // 成本降序：vid-pro(4) 在 rx-m3(3.75) 前
    expect(rows[0]!.model).toBe('vid-pro');
  });
});

describe('实时速率（GET /v1/usage/rate 语义）', () => {
  it('近 60 秒请求与 token 计数', async () => {
    const account = await newUser();
    await seedUsage({ userId: account.id, model: 'm', amount: '1', billedBy: 'payg', paygAmount: '1' });
    const rate = await usage.rate(ctx, account.id);
    expect(rate.rpm).toBe(1);
    expect(rate.tpm).toBe(150);
  });
});
