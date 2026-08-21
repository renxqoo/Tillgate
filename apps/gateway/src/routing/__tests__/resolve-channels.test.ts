/** 渠道解析（真实 PG）：候选过滤（仅启用）+ 基序正确 + 调度规则施加。 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { systemContext } from '@ai-gateway/service';
import { createResolveChannels } from '../resolve-channels.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const ctx = systemContext('v2gr-suite');
const resolveChannels = createResolveChannels({ db, rng: () => 0 });

const createdChannels: number[] = [];
const createdProviders: number[] = [];
const createdMappings: number[] = [];
const tag = () => `v2gr-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  // model_channels 双向 FK（渠道+映射）——绑定行先清
  if (createdChannels.length) {
    await db.$client.query('delete from model_channels where channel_id = any($1)', [createdChannels]);
    await db.$client.query('delete from channels where id = any($1)', [createdChannels]);
  }
  if (createdProviders.length) await db.$client.query('delete from providers where id = any($1)', [createdProviders]);
  if (createdMappings.length) await db.$client.query('delete from model_mappings where id = any($1)', [createdMappings]);
  await db.$client.end().catch(() => {});
});

async function seedChannel(providerId: number, status: number, priority: number, weight: number, mappingId: number, realModel: string): Promise<void> {
  const { channels, modelChannels } = await import('@ai-gateway/db');
  const [channel] = await db
    .insert(channels)
    .values({ providerId, name: tag(), apiKeyEnc: 'enc', status, upstreamBudget: '100' })
    .returning({ id: channels.id });
  createdChannels.push(channel!.id);
  await db.insert(modelChannels).values({ mappingId, channelId: channel!.id, priority, weight });
  void realModel;
}

describe('createResolveChannels', () => {
  it('启用渠道按 priority 分层；禁用/熔断/维护缺席；连接信息带全', async () => {
    const { providers, modelMappings } = await import('@ai-gateway/db');
    const [provider] = await db
      .insert(providers)
      .values({ name: tag(), baseUrl: 'https://v2gr.test', protocol: 'openai-compatible', status: 0 })
      .returning({ id: providers.id });
    createdProviders.push(provider!.id);
    const realModel = `real-${tag()}`;
    const [mapping] = await db
      .insert(modelMappings)
      .values({ externalName: tag(), realModel, status: 0 })
      .returning({ id: modelMappings.id });
    createdMappings.push(mapping!.id);

    await seedChannel(provider!.id, 0, 10, 1, mapping!.id, realModel);  // 高层
    await seedChannel(provider!.id, 0, 5, 9, mapping!.id, realModel);   // 中层
    await seedChannel(provider!.id, 0, 5, 1, mapping!.id, realModel);   // 中层
    await seedChannel(provider!.id, 0, 0, 99, mapping!.id, realModel);  // 低层
    await seedChannel(provider!.id, 1, 99, 1, mapping!.id, realModel);  // 禁用 → 缺席
    await seedChannel(provider!.id, 3, 99, 1, mapping!.id, realModel);  // 熔断 → 缺席
    await seedChannel(provider!.id, 4, 99, 1, mapping!.id, realModel);  // 死凭据 → 缺席

    const candidates = await resolveChannels(ctx, realModel);
    expect(candidates).toHaveLength(4);
    expect(candidates.map((c) => c.priority)).toEqual([10, 5, 5, 0]); // 分层严格序
    // 连接信息带全（G4 上游调用直接消费）
    expect(candidates[0]).toMatchObject({
      providerBaseUrl: 'https://v2gr.test',
      providerProtocol: 'openai-compatible',
      apiKeyEnc: 'enc',
    });
  });

  it('无绑定 → 空数组（调用方走无可用渠道语义）', async () => {
    expect(await resolveChannels(ctx, `real-none-${tag()}`)).toEqual([]);
  });
});

describe('换渠判定词表（isChannelSwitchable / isDeadCredentialError）', () => {
  it('可换码判定；死凭据以 deadCredential 标志为单一真相（不按码重判）', async () => {
    const { isChannelSwitchable, isDeadCredentialError } = await import('../switchable.js');
    expect(isChannelSwitchable(undefined)).toBe(false);
    expect(isChannelSwitchable('rate_limited')).toBe(true);
    expect(isChannelSwitchable('content_policy')).toBe(false); // 4xx 客户端问题不换渠
    expect(isDeadCredentialError({ deadCredential: true, code: 'whatever' })).toBe(true);
    expect(isDeadCredentialError({ deadCredential: false, code: 'invalid_api_key' })).toBe(false);
  });
});
